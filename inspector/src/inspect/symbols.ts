import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import ts from 'typescript';
import { buildHelperProbe } from './helperProbe.ts';
import { createHash } from 'node:crypto';
import type {
  InspectReportOptions,
  InspectTypegpuSymbolsInput,
  InspectionTargetKind,
  StaticAssetRoute,
  TypegpuSymbolBinding,
  TypegpuSymbolTarget,
} from '../types.ts';
import {
  DEFAULT_INSPECTION_TIMEOUT_MS,
  TYPEGPU_MCP_BINDING_SOURCES_PROP,
} from '../shared.ts';
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
    if ('selector' in target && target.declaration !== undefined && !input.includePrivate) {
      throw new Error('Nested declarations require includePrivate: true.');
    }
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
  const plans = input.targets.map((target, index) => ({
    ...target, label: target.label ?? getDefaultSymbolTargetLabel(target, index),
  }));
  const probes = plans.map((target, index) => {
    if (!('selector' in target)) return 'null';
    const effective = target.context ? { ...target, probeArguments: undefined,
      probeArgumentPlan: target.context.arguments, probeBindings: undefined } : target;
    const selected = `__typegpuMcpSelected${index}`;
    const probe = buildHelperProbe(effective, index, selected);
    if (probe.lines.length === 0) return 'null';
    return `(${selected}, inspectedModule, roots) => {\n${indentGeneratedBody(probe.lines.join('\n'), 4)}
    return { value: ${probe.valueExpression}, ledger: ${probe.ledgerExpression} };
  }`;
  });
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

  const modulePreamble = input.includePrivate
    ? `import * as __typegpuMcpExports from ${JSON.stringify(moduleUrl)};
import { moduleScope as __typegpuMcpModuleScope } from ${JSON.stringify(createFsModuleUrl(resolve(getPackageRoot(), 'src/browser/symbolRegistry.ts')))};
const __typegpuEditorInspectedModule = __typegpuMcpModuleScope(${JSON.stringify(input.modulePath)}, __typegpuMcpExports);`
    : importPreamble;
  // Reintroduce only explicitly requested type-only schema imports, in the wrapper.
  const erasedEntries = input.includePrivate ? collectLocalRoots(input.targets, input.setupBody)
    .flatMap(name => {
      const entry = scan?.erasedImports.get(name);
      return entry ? [`${JSON.stringify(name)}: (await import(${JSON.stringify(entry.specifier)}))[${JSON.stringify(entry.imported)}]`] : [];
    }) : [];

  // Import-scope binding sources: the module's own runtime imports, re-imported
  // by verbatim specifier (the generated module lives in the user module's
  // directory, so relative and aliased specifiers resolve identically, and the
  // module cache guarantees a single evaluation). Each import is isolated in
  // its own try/catch so one broken dependency costs nothing but itself.
  const depSpecifiers = [...(scan?.runtimeImportSpecifiers ?? [])]
    .filter(isBindingSourceSpecifier);
  const depLines = depSpecifiers.map((specifier, index) =>
    `let __typegpuMcpDep${index};\n` +
    `  try { __typegpuMcpDep${index} = await import(${JSON.stringify(specifier)}); } catch {}`
  );
  const bindingSourceEntries = [
    `{ origin: 'module-scope', value: setupRoots }`,
    `{ origin: 'module-scope', value: __typegpuEditorInspectedModule }`,
    ...depSpecifiers.map((specifier, index) =>
      `{ origin: 'import-scope', label: ${JSON.stringify(specifier)}, value: __typegpuMcpDep${index} }`
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
  createZeroValue as __typegpuMcpCreateZeroValue,
  readSelector as __typegpuMcpReadSelector,
  unwrapZeroValueSchema as __typegpuMcpUnwrapZeroValueSchema,
} from ${JSON.stringify(symbolRuntimeUrl)};

import { prepareSymbolTargets as __typegpuMcpPrepareTargets } from ${JSON.stringify(createFsModuleUrl(resolve(getPackageRoot(), 'src/browser/symbolTargets.ts')))};

async function __typegpuEditorInspect({ root, device, tgpu, d, std, common }) {
  const ctx = { root, device, tgpu, d, std, common };
  const inspectedModule = Object.create(__typegpuEditorInspectedModule, Object.getOwnPropertyDescriptors({ ${erasedEntries.join(', ')} }));
  const module = inspectedModule;
  const setup = await (async () => {
${indentGeneratedBody(input.setupBody ?? 'return undefined;', 4)}
  })();
  const setupRoots = setup && typeof setup === 'object' ? setup : {};
  const roots = { ...setupRoots, module: inspectedModule, inspectedModule, setup, ctx };
  ${depLines.length > 0 ? depLines.join('\n  ') : ''}
  const targets = __typegpuMcpPrepareTargets(${JSON.stringify(plans)}, [
    ${probes.join(',\n    ')}
  ], { modulePath: ${JSON.stringify(input.modulePath)},
    sourceRevision: ${JSON.stringify(createHash('sha256').update(source ?? '').digest('hex'))},
    inspectedModule, roots, ctx });

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

type ModuleBindingScan = {
  erasedImports: Map<string, { specifier: string; imported: string }>;
  runtimeImportSpecifiers: Set<string>;
};

function scanModuleBindings(modulePath: string, source: string): ModuleBindingScan {
  const sourceFile = ts.createSourceFile(
    modulePath, source, ts.ScriptTarget.Latest, true,
    modulePath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const runtimeImportSpecifiers = new Set<string>();
  const erasedImports = new Map<string, { specifier: string; imported: string }>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.importClause) continue;
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause.name) {
      if (clause.isTypeOnly) erasedImports.set(clause.name.text, { specifier, imported: 'default' });
      else runtimeImportSpecifiers.add(specifier);
    }
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (clause.isTypeOnly || element.isTypeOnly) {
          erasedImports.set(element.name.text, {
            specifier, imported: element.propertyName?.text ?? element.name.text,
          });
        } else runtimeImportSpecifiers.add(specifier);
      }
    } else if (bindings && !clause.isTypeOnly) runtimeImportSpecifiers.add(specifier);
  }
  return { erasedImports, runtimeImportSpecifiers };
}

/**
 * Property accesses on the inspected-module namespace inside `setupBody`, e.g.
 * `module.createPipeline(...)`. Used only to restore explicitly requested
 * type-only schema imports in the inspection wrapper.
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
      // Include explicitly requested type-only schema imports.
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
      for (const argument of target.context?.arguments ?? target.probeArgumentPlan ?? []) {
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
      for (const binding of target.context?.with ?? []) {
        addSelector(binding.slot);
        addSelector(binding.value);
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

function validateSymbolTarget(target: TypegpuSymbolTarget, index: number): void {
  if ('selector' in target) {
    validateSelector(target.selector, `targets[${index}].selector`);
    validateBindings(target.context?.with, index);
    for (const [argumentIndex, argument] of (
      target.context?.arguments ?? target.probeArgumentPlan ?? []
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

function getDefaultSymbolTargetLabel(target: TypegpuSymbolTarget, index: number): string {
  if ('selector' in target) {
    return target.selector;
  }
  if (target.kind === 'compute-pipeline') {
    return target.compute;
  }
  return target.fragment ? `${target.vertex} + ${target.fragment}` : target.vertex ?? `target ${index + 1}`;
}

function indentGeneratedBody(body: string, spaces: number): string {
  const indent = ' '.repeat(spaces);
  return body
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n');
}
