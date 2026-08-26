import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import ts from 'typescript';
import type {
  InspectReportOptions,
  InspectTypegpuSymbolsInput,
  InspectionTargetKind,
  StaticAssetRoute,
  TypegpuSymbolBinding,
  TypegpuSymbolTarget,
} from '../types.ts';
import { DEFAULT_INSPECTION_TIMEOUT_MS, TYPEGPU_MCP_BINDING_SOURCES_PROP } from '../shared.ts';
import {
  createFsModuleUrl,
  getPackageRoot,
  type PackageResolutionOptions,
} from './paths.ts';
import {
  normalizeDependencyAliases,
  normalizeDependencyResolution,
  normalizeStaticAssetRoutes,
} from './options.ts';
import { DEFAULT_QUIESCENT } from './quiescentSetup.ts';

export type NormalizedSymbolInput = Required<
  Pick<
    InspectTypegpuSymbolsInput,
    | 'timeoutMs'
    | 'features'
    | 'strictNames'
    | 'autoBind'
    | 'reuseBrowser'
  >
> & {
  cwd: string;
  modulePath: string;
  targets: TypegpuSymbolTarget[];
  includePrivate: boolean;
  setupBody?: string | undefined;
  viteConfigPath?: string | undefined;
  documentHtml?: string | undefined;
  /** Raw caller setup; the quiescent prologue is composed once, in normalizeInput. */
  browserSetup?: string | undefined;
  quiescent: boolean;
  dependencyAliases: Record<string, string>;
  fsAllow: string[];
  staticAssetRoutes: StaticAssetRoute[];
  dependencyResolution: PackageResolutionOptions;
  reportOptions: InspectReportOptions;
};

export function normalizeSymbolInput(input: InspectTypegpuSymbolsInput): NormalizedSymbolInput {
  const cwd = resolve(input.cwd ?? process.cwd());
  const modulePath = resolve(cwd, input.modulePath);

  if (!existsSync(modulePath)) {
    throw new Error(`Module path does not exist: ${modulePath}`);
  }
  if (!Array.isArray(input.targets) || input.targets.length === 0) {
    throw new Error('Pass at least one symbol target.');
  }

  for (const [index, target] of input.targets.entries()) {
    validateSymbolTarget(target, index);
  }

  return {
    cwd,
    modulePath,
    targets: input.targets,
    includePrivate: input.includePrivate ?? false,
    setupBody: input.setupBody,
    documentHtml: input.documentHtml,
    browserSetup: input.browserSetup,
    quiescent: input.quiescent ?? DEFAULT_QUIESCENT,
    timeoutMs: input.timeoutMs ?? DEFAULT_INSPECTION_TIMEOUT_MS,
    viteConfigPath: input.viteConfigPath
      ? resolve(cwd, input.viteConfigPath)
      : undefined,
    features: input.features ?? [],
    strictNames: input.strictNames ?? true,
    autoBind: input.autoBind ?? true,
    reuseBrowser: input.reuseBrowser ?? false,
    dependencyAliases: normalizeDependencyAliases(cwd, input.dependencyAliases ?? {}),
    fsAllow: (input.fsAllow ?? []).map((path) => resolve(cwd, path)),
    staticAssetRoutes: normalizeStaticAssetRoutes(cwd, input.staticAssetRoutes ?? []),
    dependencyResolution: normalizeDependencyResolution(cwd, input.dependencyResolution),
    reportOptions: {
      verbosity: input.verbosity,
      includeWgsl: input.includeWgsl,
      includeCallWgsl: input.includeCallWgsl,
      includeCalls: input.includeCalls,
      maxWgslBytes: input.maxWgslBytes,
      diagnosticsOnly: input.diagnosticsOnly,
    },
  };
}

/**
 * Top-level bindings the synthesized module declares. `includePrivate` pastes
 * the user's source into the same module scope, so any of these appearing there
 * would be a module-level SyntaxError.
 */
const GENERATED_TOP_LEVEL_BINDINGS = [
  '__typegpuEditorInspectedModule',
  '__typegpuEditorInspect',
  '__typegpuMcpCreateComputePipeline',
  '__typegpuMcpCreateRenderPipeline',
  '__typegpuMcpCreateZeroValue',
  '__typegpuMcpReadSelector',
  '__typegpuMcpUnwrapZeroValueSchema',
  '__typegpuMcpScope',
];

/**
 * The typegpu package itself never exports user slots/accessors — importing it
 * as a binding source would only add noise to provider scans.
 */
function isBindingSourceSpecifier(specifier: string): boolean {
  return !/^typegpu(\/|$)/.test(specifier);
}

/** The export name the browser harness looks up on the synthesized module. */
const GENERATED_EXPORT_NAME = 'inspect';

export function buildSymbolInspectionModule(input: NormalizedSymbolInput): {
  inlineCode: string;
  inlineSourcePath: string;
  requestedTargets: Array<{ label: string; kind: InspectionTargetKind }>;
} {
  const moduleUrl = createFsModuleUrl(input.modulePath);
  const symbolRuntimeUrl = createFsModuleUrl(
    resolve(getPackageRoot(), 'src/browser/symbolRuntime.ts'),
  );
  const targetBlocks = input.targets.map((target, index) => createSymbolTargetBlock(target, index));
  const importPreamble =
    `import * as __typegpuEditorInspectedModule from ${JSON.stringify(moduleUrl)};`;

  // The scan feeds import-scope binding sources on both paths, so it runs even
  // without includePrivate; an unreadable module degrades to no dep sources.
  let scan: ModuleBindingScan | undefined;
  let source: string | undefined;
  try {
    source = readFileSync(input.modulePath, 'utf8');
    scan = scanModuleBindings(input.modulePath, source);
  } catch {
    scan = undefined;
  }

  let modulePreamble = importPreamble;
  let privateScopeExposed = false;
  if (input.includePrivate && source !== undefined && scan !== undefined) {
    // Inlining a module that already declares (or exports) one of the generated
    // bindings would not even parse. Degrade to the module-import preamble so
    // unresolvable private selectors fail per target with the friendly
    // "Could not resolve selector" diagnostic instead of killing the run.
    if (!hasGeneratedBindingCollision(scan)) {
      modulePreamble = createPrivateModulePreamble(
        source,
        scan,
        collectLocalRoots(input.targets, input.setupBody),
      );
      privateScopeExposed = true;
    }
  }

  // Import-scope binding sources: the module's own runtime imports, re-imported
  // by verbatim specifier (the generated module lives in the user module's
  // directory, so relative and aliased specifiers resolve identically, and the
  // module cache guarantees a single evaluation). Each import is isolated in
  // its own try/catch so one broken dependency costs nothing but itself.
  const depSpecifiers = [...(scan?.runtimeImportSpecifiers ?? [])]
    .filter(isBindingSourceSpecifier);
  const importerPaths = findSemanticBindingImporters(input.modulePath);
  const depLines = depSpecifiers.map((specifier, index) =>
    `let __typegpuMcpDep${index};\n` +
    `  try { __typegpuMcpDep${index} = await import(${JSON.stringify(specifier)}); } catch {}`
  );
  const importerLines = importerPaths.map((path, index) =>
    `let __typegpuMcpImporter${index};\n` +
    `  try { __typegpuMcpImporter${index} = await import(${JSON.stringify(createFsModuleUrl(path))}); } catch {}`
  );
  const bindingSourceEntries = [
    `{ origin: 'module-scope', value: setupRoots }`,
    `{ origin: 'module-scope', value: __typegpuEditorInspectedModule }`,
    ...(privateScopeExposed
      ? [`{ origin: 'module-scope', value: __typegpuMcpScope }`]
      : []),
    ...depSpecifiers.map((specifier, index) =>
      `{ origin: 'import-scope', label: ${JSON.stringify(specifier)}, value: __typegpuMcpDep${index} }`
    ),
    ...importerPaths.map((path, index) =>
      `{ origin: 'importer-scope', label: ${JSON.stringify(path)}, value: __typegpuMcpImporter${index} }`
    ),
  ];

  return {
    inlineSourcePath: join(
      dirname(input.modulePath),
      `${basename(input.modulePath)}.typegpu-mcp-inspect${virtualModuleExtension(input.modulePath)}`,
    ),
    requestedTargets: input.targets.map((target, index) => ({
      label: target.label ?? getDefaultSymbolTargetLabel(target, index),
      kind: target.kind ?? 'resolvable',
    })),
    inlineCode: `${modulePreamble}
import {
  createComputePipeline as __typegpuMcpCreateComputePipeline,
  createRenderPipeline as __typegpuMcpCreateRenderPipeline,
  createZeroValue as __typegpuMcpCreateZeroValue,
  readSelector as __typegpuMcpReadSelector,
  unwrapZeroValueSchema as __typegpuMcpUnwrapZeroValueSchema,
} from ${JSON.stringify(symbolRuntimeUrl)};

${importerLines.length > 0 ? importerLines.join('\n') : ''}

async function __typegpuEditorInspect({ root, device, tgpu, d, std, common }) {
  const ctx = { root, device, tgpu, d, std, common };
  const inspectedModule = __typegpuEditorInspectedModule;
  const module = __typegpuEditorInspectedModule;
  const setup = await (async () => {
${indentGeneratedBody(input.setupBody ?? 'return undefined;', 4)}
  })();
  const setupRoots = setup && typeof setup === 'object' ? setup : {};
  const roots = { ...setupRoots, module: __typegpuEditorInspectedModule, inspectedModule: __typegpuEditorInspectedModule, setup, ctx };
  ${depLines.length > 0 ? depLines.join('\n  ') : ''}
  const targets = [];

${targetBlocks.map((block) => indentGeneratedBody(block, 2)).join('\n\n')}

  return Object.assign(targets, { ${TYPEGPU_MCP_BINDING_SOURCES_PROP}: [
    ${bindingSourceEntries.join(',\n    ')},
  ] });
}

export { __typegpuEditorInspect as ${GENERATED_EXPORT_NAME} };
`,
  };
}

function virtualModuleExtension(modulePath: string): string {
  const extension = extname(modulePath).toLowerCase();
  return ['.tsx', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.js', '.ts'].includes(extension)
    ? extension
    : '.ts';
}

/**
 * Reverse edge of the binding scope. Only direct importers that both consume
 * this module and author a `.with(...)` binding are evaluated; ordinary app
 * importers are deliberately excluded. This keeps importer execution bounded
 * while exposing the real pipeline bindings that make the target resolvable.
 */
function findSemanticBindingImporters(modulePath: string): string[] {
  const directory = dirname(modulePath);
  const candidates: string[] = [];
  try {
    for (const entry of readdirSync(directory)) {
      const path = resolve(directory, entry);
      if (path === resolve(modulePath) || !/\.[cm]?[jt]sx?$/.test(path)) continue;
      if (!statSync(path).isFile()) continue;
      const source = readFileSync(path, 'utf8');
      if (!source.includes('.with')) continue;
      const sourceFile = ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.Latest,
        false,
        path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const importsTarget = sourceFile.statements.some((statement) =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteralLike(statement.moduleSpecifier) &&
        resolvesToModule(path, statement.moduleSpecifier.text, modulePath)
      );
      if (importsTarget && hasWithCall(sourceFile)) candidates.push(path);
    }
  } catch {
    return [];
  }
  return candidates.sort();
}

function resolvesToModule(importerPath: string, specifier: string, modulePath: string): boolean {
  if (!specifier.startsWith('.')) return false;
  const candidate = resolve(dirname(importerPath), specifier);
  const target = resolve(modulePath);
  if (candidate === target) return true;
  if (extname(candidate) !== '') return false;
  return ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
    .some((extension) => `${candidate}${extension}` === target);
}

function hasWithCall(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'with'
    ) {
      found = true;
      return;
    }
    if (!found) node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return found;
}

type ModuleBindingScan = {
  runtimeLocals: Set<string>;
  typeOnlyLocals: Set<string>;
  erasedImports: Map<string, { specifier: string; imported: string }>;
  topLevelNames: Set<string>;
  exportedNames: Set<string>;
  /** Specifiers of imports that bind at least one runtime value. */
  runtimeImportSpecifiers: Set<string>;
};

function hasGeneratedBindingCollision(scan: ModuleBindingScan): boolean {
  return (
    scan.exportedNames.has(GENERATED_EXPORT_NAME) ||
    GENERATED_TOP_LEVEL_BINDINGS.some((name) => scan.topLevelNames.has(name))
  );
}

function scanModuleBindings(modulePath: string, source: string): ModuleBindingScan {
  const sourceFile = ts.createSourceFile(
    modulePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    modulePath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const runtimeLocals = new Set<string>();
  const typeOnlyLocals = new Set<string>();
  const topLevelNames = new Set<string>();
  const exportedNames = new Set<string>();
  const runtimeImportSpecifiers = new Set<string>();
  const erasedImports = new Map<
    string,
    { specifier: string; imported: string }
  >();

  for (const statement of sourceFile.statements) {
    const isExported = hasExportModifier(statement);

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of collectBoundNames(declaration.name)) {
          runtimeLocals.add(name);
          topLevelNames.add(name);
          if (isExported) exportedNames.add(name);
        }
      }
      continue;
    }
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      runtimeLocals.add(statement.name.text);
      topLevelNames.add(statement.name.text);
      if (isExported) exportedNames.add(statement.name.text);
      continue;
    }
    if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
      typeOnlyLocals.add(statement.name.text);
      topLevelNames.add(statement.name.text);
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      exportedNames.add('default');
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      const exported = statement.exportClause;
      if (exported && ts.isNamedExports(exported)) {
        for (const element of exported.elements) {
          exportedNames.add(element.name.text);
        }
      }
      continue;
    }
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.importClause
    ) {
      continue;
    }

    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause.name) {
      topLevelNames.add(clause.name.text);
      if (clause.isTypeOnly) {
        erasedImports.set(clause.name.text, { specifier, imported: 'default' });
      } else {
        runtimeLocals.add(clause.name.text);
        runtimeImportSpecifiers.add(specifier);
      }
    }
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const local = element.name.text;
        topLevelNames.add(local);
        if (clause.isTypeOnly || element.isTypeOnly) {
          erasedImports.set(local, {
            specifier,
            imported: element.propertyName?.text ?? element.name.text,
          });
        } else {
          runtimeLocals.add(local);
          runtimeImportSpecifiers.add(specifier);
        }
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      topLevelNames.add(bindings.name.text);
      if (clause.isTypeOnly) {
        typeOnlyLocals.add(bindings.name.text);
      } else {
        runtimeLocals.add(bindings.name.text);
        runtimeImportSpecifiers.add(specifier);
      }
    }
  }

  return {
    runtimeLocals,
    typeOnlyLocals,
    erasedImports,
    topLevelNames,
    exportedNames,
    runtimeImportSpecifiers,
  };
}

function hasExportModifier(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    (ts.getModifiers(statement) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    )
  );
}

function collectBoundNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }
  return name.elements.flatMap((element) =>
    ts.isBindingElement(element) ? collectBoundNames(element.name) : [],
  );
}

function createPrivateModulePreamble(
  source: string,
  scan: ModuleBindingScan,
  localRoots: string[],
): string {
  const entries = localRoots.map((name) => {
    const key = JSON.stringify(name);
    if (scan.runtimeLocals.has(name)) return `${key}: ${name}`;
    const erasedImport = scan.erasedImports.get(name);
    if (erasedImport) {
      return `${key}: (await import(${JSON.stringify(
        erasedImport.specifier,
      )}))[${JSON.stringify(erasedImport.imported)}]`;
    }
    if (scan.typeOnlyLocals.has(name)) return `${key}: undefined`;
    // An unresolvable root (a typo, or a selector rooted at something the module
    // never declares) must not become a module-level ReferenceError that kills
    // every target; leave it undefined and let readSelector report it per target.
    return `${key}: (typeof ${name} === 'undefined' ? undefined : ${name})`;
  });

  // Every runtime local — including imported names the selectors never
  // mention — doubles as a binding source, so a sibling-imported accessor is
  // harvestable for slot auto-binding. Same typeof-guard: exposure must never
  // introduce a ReferenceError the module itself would not have.
  const scopeEntries = [...scan.runtimeLocals].map((name) =>
    `${JSON.stringify(name)}: (typeof ${name} === 'undefined' ? undefined : ${name})`
  );

  return `${source}

const __typegpuEditorInspectedModule = { ${entries.join(', ')} };
const __typegpuMcpScope = { ${scopeEntries.join(', ')} };
`;
}

/**
 * Property accesses on the inspected-module namespace inside `setupBody`, e.g.
 * `module.createPipeline(...)`. Those roots must be present in the synthesized
 * namespace too, otherwise setup sees `undefined` under `includePrivate`.
 */
const SETUP_BODY_MODULE_PROPERTY_PATTERN =
  /\b(?:module|inspectedModule)\s*\.\s*([A-Za-z_$][\w$]*)/g;

function collectSetupBodyRoots(setupBody: string | undefined): string[] {
  if (!setupBody) {
    return [];
  }
  const roots = new Set<string>();
  for (const match of setupBody.matchAll(SETUP_BODY_MODULE_PROPERTY_PATTERN)) {
    if (match[1]) roots.add(match[1]);
  }
  return [...roots];
}

function collectLocalRoots(
  targets: TypegpuSymbolTarget[],
  setupBody?: string | undefined,
): string[] {
  const roots = new Set<string>();
  const addSelector = (selector: string | undefined) => {
    const parts = selector?.split('.') ?? [];
    const root = parts[0];
    if (
      (root === 'module' || root === 'inspectedModule') &&
      parts[1] &&
      /^[A-Za-z_$][\w$]*$/.test(parts[1])
    ) {
      // Private editor inspection pastes the source module in place. Keep
      // schemas referenced as module.Foo in the synthetic namespace even when
      // Foo is an imported or otherwise non-exported declaration.
      roots.add(parts[1]);
      return;
    }
    if (
      root &&
      root !== 'ctx' &&
      root !== 'setup' &&
      root !== 'default' &&
      /^[A-Za-z_$][\w$]*$/.test(root)
    ) {
      roots.add(root);
    }
  };

  for (const target of targets) {
    if ('selector' in target) {
      addSelector(target.selector);
      for (const argument of target.probeArguments ?? []) addSelector(argument);
      for (const argument of target.probeArgumentPlan ?? []) {
        addSelector(
          'schema' in argument
            ? argument.schema
            : 'refSchema' in argument
            ? argument.refSchema
            : argument.value,
        );
      }
      for (const binding of target.probeBindings ?? []) {
        addSelector(binding.slot);
        addSelector(binding.schema);
      }
      continue;
    }
    if (target.kind === 'compute-pipeline') {
      addSelector(target.compute);
    } else {
      addSelector(target.vertex);
      addSelector(target.fragment);
      if (typeof target.attribs === 'string') {
        addSelector(target.attribs);
      } else {
        for (const selector of Object.values(target.attribs ?? {})) {
          addSelector(selector);
        }
      }
    }
    for (const binding of target.with ?? []) {
      addSelector(binding.slot);
      addSelector(binding.value);
    }
  }
  for (const root of collectSetupBodyRoots(setupBody)) {
    roots.add(root);
  }
  return [...roots];
}

function createSymbolTargetBlock(
  target: TypegpuSymbolTarget,
  index: number,
): string {
  const label = target.label ?? getDefaultSymbolTargetLabel(target, index);
  const lines = createSymbolTargetLines(target, index);

  return [
    'try {',
    ...lines.map((line) => `  ${line}`),
    '} catch (error) {',
    // Mirror the success path: an omitted kind stays omitted so the in-page
    // inference rules decide, instead of being pinned to 'resolvable' here.
    `  targets.push(${objectLiteral({
      label,
      kind: target.kind,
      error: jsExpression('error'),
    })});`,
    '}',
  ].join('\n');
}

function validateSymbolTarget(target: TypegpuSymbolTarget, index: number): void {
  if ('selector' in target) {
    validateSelector(target.selector, `targets[${index}].selector`);
    for (const [argumentIndex, argument] of (
      target.probeArgumentPlan ?? []
    ).entries()) {
      if ('schema' in argument) {
        validateSelector(
          argument.schema,
          `targets[${index}].probeArgumentPlan[${argumentIndex}].schema`,
        );
      } else if ('refSchema' in argument) {
        validateSelector(
          argument.refSchema,
          `targets[${index}].probeArgumentPlan[${argumentIndex}].refSchema`,
        );
      } else {
        validateSelector(
          argument.value,
          `targets[${index}].probeArgumentPlan[${argumentIndex}].value`,
        );
      }
    }
    for (const [bindingIndex, binding] of (target.probeBindings ?? []).entries()) {
      validateSelector(
        binding.slot,
        `targets[${index}].probeBindings[${bindingIndex}].slot`,
      );
      validateSelector(
        binding.schema,
        `targets[${index}].probeBindings[${bindingIndex}].schema`,
      );
    }
    return;
  }

  if (target.kind === 'compute-pipeline') {
    validateSelector(target.compute, `targets[${index}].compute`);
    validateBindings(target.with, index);
    return;
  }

  validateSelector(target.vertex, `targets[${index}].vertex`);
  if (target.fragment !== undefined) {
    validateSelector(target.fragment, `targets[${index}].fragment`);
  }
  if (target.attribs !== undefined) {
    validateAttribs(target.attribs, index);
  }
  validateBindings(target.with, index);
}

function validateAttribs(
  attribs: Extract<TypegpuSymbolTarget, { kind: 'render-pipeline' }>['attribs'],
  targetIndex: number,
): void {
  if (attribs === undefined) {
    return;
  }
  if (typeof attribs === 'string') {
    validateSelector(attribs, `targets[${targetIndex}].attribs`);
    return;
  }

  for (const [name, selector] of Object.entries(attribs)) {
    if (name.trim() === '') {
      throw new Error(`Expected targets[${targetIndex}].attribs keys to be non-empty.`);
    }
    validateSelector(selector, `targets[${targetIndex}].attribs.${name}`);
  }
}

function validateBindings(bindings: TypegpuSymbolBinding[] | undefined, targetIndex: number): void {
  for (const [index, binding] of (bindings ?? []).entries()) {
    validateSelector(binding.slot, `targets[${targetIndex}].with[${index}].slot`);
    validateSelector(binding.value, `targets[${targetIndex}].with[${index}].value`);
  }
}

function validateSelector(selector: string, label: string): void {
  if (typeof selector !== 'string' || selector.trim() === '') {
    throw new Error(`Expected ${label} to be a non-empty selector.`);
  }
}

function createSymbolTargetLines(
  target: TypegpuSymbolTarget,
  index: number,
): string[] {
  const label = target.label ?? getDefaultSymbolTargetLabel(target, index);

  if ('selector' in target) {
    const selected = `__typegpuMcpSelected${index}`;
    const lines = [
      `const ${selected} = __typegpuMcpReadSelector(inspectedModule, ${JSON.stringify(
        target.selector,
      )}, ${JSON.stringify(`targets[${index}].selector`)}, roots);`,
    ];

    let valueExpression = selected;
    let ledgerExpression = '[]';
    const probeArguments = target.probeArguments ?? [];
    const probeArgumentPlan =
      target.probeArgumentPlan ??
      probeArguments.map((schema) => ({ schema }));
    const probeBindings = target.probeBindings ?? [];
    if (probeArgumentPlan.length > 0 || probeBindings.length > 0) {
      const probePrelude: string[] = [];
      const argumentExpressions = probeArgumentPlan.map((argument, argumentIndex) => {
        if ('value' in argument) {
          // Resolve the selector root through readSelector so setup-returned
          // roots are honored, but keep the trailing property path inside the
          // probe body: accessors such as `.$` are only valid on the GPU side.
          const local = `__typegpuMcpProbeValue${index}_${argumentIndex}`;
          const { root, path } = splitSelectorRoot(argument.value);
          lines.push(
            `const ${local} = __typegpuMcpReadSelector(inspectedModule, ${JSON.stringify(
              root,
            )}, ${JSON.stringify(
              `targets[${index}].probeArgumentPlan[${argumentIndex}].value`,
            )}, roots);`,
          );
          return `${local}${path.map((part) => `[${JSON.stringify(part)}]`).join('')}`;
        }
        const ref = 'refSchema' in argument;
        const schema = normalizeSchemaSelector(
          ref ? argument.refSchema : argument.schema,
        );
        const local = `__typegpuMcpProbeSchema${index}_${argumentIndex}`;
        const schemaLabel = target.probeArgumentPlan
          ? `targets[${index}].probeArgumentPlan[${argumentIndex}].${ref ? 'refSchema' : 'schema'}`
          : `targets[${index}].probeArguments[${argumentIndex}]`;
        // Decorated schemas (d.align(...), d.size(...)) are descriptor objects
        // and are not callable; unwrap on the CPU so the probe body can still
        // build the zero value inside the shader.
        lines.push(
          `const ${local} = __typegpuMcpUnwrapZeroValueSchema(__typegpuMcpReadSelector(inspectedModule, ${JSON.stringify(
            schema,
          )}, ${JSON.stringify(schemaLabel)}, roots), ${JSON.stringify(schemaLabel)});`,
        );
        if (ref) {
          const refLocal = `__typegpuMcpProbeRef${index}_${argumentIndex}`;
          probePrelude.push(`let ${refLocal} = ${local}();`);
          return refLocal;
        }
        return `${local}()`;
      });
      const probe = `__typegpuMcpProbe${index}`;
      lines.push(
        `let ${probe} = tgpu.fn([])(() => {`,
        `  'use gpu';`,
        ...probePrelude.map((line) => `  ${line}`),
        `  ${selected}(${argumentExpressions.join(', ')});`,
        `});`,
      );
      for (const [bindingIndex, binding] of probeBindings.entries()) {
        const slotLocal = `__typegpuMcpProbeSlot${index}_${bindingIndex}`;
        const schemaLocal = `__typegpuMcpProbeBindingSchema${index}_${bindingIndex}`;
        const schemaLabel = `targets[${index}].probeBindings[${bindingIndex}].schema`;
        lines.push(
          `const ${slotLocal} = __typegpuMcpReadSelector(inspectedModule, ${JSON.stringify(
            binding.slot,
          )}, ${JSON.stringify(
            `targets[${index}].probeBindings[${bindingIndex}].slot`,
          )}, roots);`,
          `const ${schemaLocal} = __typegpuMcpReadSelector(inspectedModule, ${JSON.stringify(
            normalizeSchemaSelector(binding.schema),
          )}, ${JSON.stringify(schemaLabel)}, roots);`,
          `${probe} = ${probe}.with(${slotLocal}, __typegpuMcpCreateZeroValue(${schemaLocal}, ${JSON.stringify(
            schemaLabel,
          )}));`,
        );
      }
      valueExpression = probe;
      // Structured user-explicit provenance: these entries pre-satisfy the
      // requirements a probe wrapper exists for, so the engine never
      // re-extracts them, and the compat note derives from their provenance.
      ledgerExpression = JSON.stringify([
        {
          tier: 'target',
          kind: 'argument-values',
          key: `argument-values:${target.selector}`,
          status: 'satisfied',
          discoveredBy: 'shape',
          provider: 'user-explicit',
          provenance: probeArgumentPlan.length > 0
            ? describeProbeArgumentDefaults(probeArgumentPlan)
            : 'Called the selected zero-argument helper from an inspection wrapper.',
          detail: { argumentCount: probeArgumentPlan.length },
        },
        ...probeBindings.map((binding) => ({
          tier: 'resource',
          kind: 'slot-value',
          key: `slot-value:${binding.slot}`,
          status: 'satisfied',
          discoveredBy: 'shape',
          provider: 'user-explicit',
          provenance:
            `Bound inspection-only zero values for accessors: ${binding.slot}.`,
          detail: { slotName: binding.slot, schema: binding.schema },
        })),
      ]);
    }

    lines.push(
      `targets.push(${objectLiteral({
        label,
        kind: target.kind,
        unwrap: target.unwrap,
        value: jsExpression(valueExpression),
        ledger: jsExpression(ledgerExpression),
      })});`,
    );
    return lines;
  }

  if (target.kind === 'compute-pipeline') {
    return createComputePipelineTargetLines(target, index, label);
  }

  return createRenderPipelineTargetLines(target, index, label);
}

/**
 * Splits `a.b.c` into the root selector handed to `readSelector` and the
 * remaining property path, which stays a deferred member access.
 */
function splitSelectorRoot(selector: string): { root: string; path: string[] } {
  const parts = selector.split('.').filter(Boolean);
  const root = parts.shift() ?? selector;
  return { root, path: parts };
}

function normalizeSchemaSelector(selector: string): string {
  return selector.startsWith('d.') ? `ctx.${selector}` : selector;
}

function describeProbeArgumentDefaults(
  plan: Array<{ schema: string } | { refSchema: string } | { value: string }>,
): string {
  const schemas = plan.flatMap((entry) => 'schema' in entry ? [entry.schema] : []);
  const refs = plan.flatMap((entry) => 'refSchema' in entry ? [entry.refSchema] : []);
  const values = plan.flatMap((entry) => 'value' in entry ? [entry.value] : []);
  const details = [
    ...(schemas.length > 0
      ? [`zero values for: ${schemas.join(', ')}`]
      : []),
    ...(values.length > 0
      ? [`existing values for: ${values.join(', ')}`]
      : []),
    ...(refs.length > 0
      ? [`mutable reference locals for: ${refs.join(', ')}`]
      : []),
  ];
  return `Called the selected helper from a zero-argument tgpu.fn with ${details.join(' and ')}.`;
}

function createComputePipelineTargetLines(
  target: Extract<TypegpuSymbolTarget, { kind: 'compute-pipeline' }>,
  index: number,
  label: string,
): string[] {
  const descriptor = target.descriptor ?? {};

  return [
    `const __typegpuMcpCompute${index} = __typegpuMcpReadSelector(inspectedModule, ${JSON.stringify(
      target.compute,
    )}, ${JSON.stringify(`targets[${index}].compute`)}, roots);`,
    `targets.push(${objectLiteral({
      label,
      kind: 'compute-pipeline',
      create: jsExpression(
        `() => __typegpuMcpCreateComputePipeline(root, inspectedModule, ${JSON.stringify(
          target.with ?? [],
        )}, roots, ${JSON.stringify(`targets[${index}]`)}, ${JSON.stringify(
          descriptor,
        )}, __typegpuMcpCompute${index})`,
      ),
    })});`,
  ];
}

function createRenderPipelineTargetLines(
  target: Extract<TypegpuSymbolTarget, { kind: 'render-pipeline' }>,
  index: number,
  label: string,
): string[] {
  const descriptor = target.descriptor ?? {};
  const lines = [
    `const __typegpuMcpVertex${index} = __typegpuMcpReadSelector(inspectedModule, ${JSON.stringify(
      target.vertex,
    )}, ${JSON.stringify(`targets[${index}].vertex`)}, roots);`,
  ];

  let fragmentExpression = 'undefined';
  let attribsExpression = 'undefined';

  if (target.fragment !== undefined) {
    lines.push(
      `const __typegpuMcpFragment${index} = __typegpuMcpReadSelector(inspectedModule, ${JSON.stringify(
        target.fragment,
      )}, ${JSON.stringify(`targets[${index}].fragment`)}, roots);`,
    );
    fragmentExpression = `__typegpuMcpFragment${index}`;
  }

  if (target.attribs !== undefined) {
    const attribs = createAttribsExpression(target.attribs, index);
    lines.push(...attribs.lines);
    attribsExpression = attribs.expression;
  }

  lines.push(
    `const __typegpuMcpPreparedRender${index} = __typegpuMcpCreateRenderPipeline(root, tgpu, d, inspectedModule, ${JSON.stringify(
      target.with ?? [],
    )}, roots, ${JSON.stringify(`targets[${index}]`)}, ${JSON.stringify(
      descriptor,
    )}, __typegpuMcpVertex${index}, ${fragmentExpression}, ${attribsExpression}, ${JSON.stringify(
      target.synthesizeMissing ?? true,
    )});`,
    `targets.push(${objectLiteral({
      label,
      kind: 'render-pipeline',
      create: jsExpression(`__typegpuMcpPreparedRender${index}.create`),
      ledger: jsExpression(`__typegpuMcpPreparedRender${index}.ledger`),
    })});`,
  );

  return lines;
}

function createAttribsExpression(
  attribs: NonNullable<Extract<TypegpuSymbolTarget, { kind: 'render-pipeline' }>['attribs']>,
  index: number,
): { lines: string[]; expression: string } {
  if (typeof attribs === 'string') {
    return {
      lines: [
        `const __typegpuMcpAttribs${index} = __typegpuMcpReadSelector(inspectedModule, ${JSON.stringify(
          attribs,
        )}, ${JSON.stringify(`targets[${index}].attribs`)}, roots);`,
      ],
      expression: `__typegpuMcpAttribs${index}`,
    };
  }

  const lines: string[] = [];
  const entries = Object.entries(attribs).map(([name, selector], attribIndex) => {
    const local = `__typegpuMcpAttribs${index}_${attribIndex}`;
    lines.push(
      `const ${local} = __typegpuMcpReadSelector(inspectedModule, ${JSON.stringify(
        selector,
      )}, ${JSON.stringify(`targets[${index}].attribs.${name}`)}, roots);`,
    );
    return `${JSON.stringify(name)}: ${local}`;
  });

  return {
    lines,
    expression: `{ ${entries.join(', ')} }`,
  };
}

function getDefaultSymbolTargetLabel(target: TypegpuSymbolTarget, index: number): string {
  if ('selector' in target) {
    return target.selector;
  }
  if (target.kind === 'compute-pipeline') {
    return target.compute;
  }
  return target.fragment ? `${target.vertex} + ${target.fragment}` : target.vertex ?? `target ${index + 1}`;
}

type JsExpression = {
  __typegpuMcpExpression: string;
};

function jsExpression(value: string): JsExpression {
  return { __typegpuMcpExpression: value };
}

function objectLiteral(values: Record<string, unknown>): string {
  const entries = Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${formatObjectLiteralValue(value)}`);
  return `{ ${entries.join(', ')} }`;
}

function formatObjectLiteralValue(value: unknown): string {
  if (
    value &&
    typeof value === 'object' &&
    '__typegpuMcpExpression' in value &&
    typeof (value as JsExpression).__typegpuMcpExpression === 'string'
  ) {
    return (value as JsExpression).__typegpuMcpExpression;
  }
  return JSON.stringify(value);
}

function indentGeneratedBody(body: string, spaces: number): string {
  const indent = ' '.repeat(spaces);
  return body
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n');
}
