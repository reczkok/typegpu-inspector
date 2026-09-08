import { discoverFactoryResults, attachFactoryResults } from './factoryResults.js';
import { applyHelperPlans, type HelperDeclarations } from './helperPlanning.js';
export { MAX_SYNTHESIZED_SPECIALIZATIONS } from './helperPlanning.js';
import { isFnShellCall, isFnShellApplication, isTgpuFactoryCall, readCallee, calleeSegments, unwrap, hasOwnUseGpuDirective, expressionSelector } from './shaderSyntax.js';
import ts from 'typescript';
import type { Position, Range } from 'vscode-languageserver';
import type { StatementPathSegment } from './protocol.js';

export type TypeGpuRole =
  | 'compute-entrypoint'
  | 'vertex-entrypoint'
  | 'fragment-entrypoint'
  | 'shader-helper'
  | 'shader-constant'
  | 'schema'
  | 'bind-group-layout'
  | 'vertex-layout'
  | 'binding-resource'
  | 'buffer-resource'
  | 'texture-resource'
  | 'texture-view'
  | 'sampler-resource'
  | 'bind-group'
  | 'query-resource'
  | 'gpu-variable'
  | 'resource-collection'
  | 'compute-pipeline'
  | 'render-pipeline'
  | 'pipeline-factory'
  | 'resource-factory'
  | 'shader-factory'
  | 'factory-result'
  | 'unknown';

export type DiscoveredSymbol = {
  name: string;
  runtimeName?: string;
  role: TypeGpuRole;
  range: Range;
  /** Lexical tokens in the authored shader source that can survive into WGSL. */
  shaderSourceTokens?: ShaderSourceToken[];
  /** `'use gpu'` bodies, for statement-level mapping from the runtime's statement map. */
  shaderBodies?: ShaderBody[];
  targetIds: string[];
  probeArgumentPlan?: ProbeArgumentPlanEntry[];
  probeContext?: ProbeContext;
  probeSpecializations?: ProbeSpecialization[];
  specializationSynthesis?: SpecializationSynthesis;
  pipelineSource?: PipelineSource;
};

export type ShaderSourceToken = {
  text: string;
  range: Range;
};

export type ShaderStatement = {
  path: StatementPathSegment[];
  /** The whole statement. */
  range: Range;
  /** `if (…)` / `for (…)` header of a compound statement; equals `range` for leaves. */
  headRange: Range;
};

/** One `'use gpu'` block, with its statements keyed the way tinyest orders them. */
export type ShaderBody = {
  range: Range;
  statements: ShaderStatement[];
};

export type PipelineSource = {
  kind: 'compute-pipeline' | 'render-pipeline';
  compute?: string;
  vertex?: string;
  fragment?: string;
  bindings?: PipelineSourceBinding[];
};

export type PipelineSourceBinding = {
  source: string;
  value?: string;
};

export type ProbeBinding = {
  slot: string;
  schema: string;
};

export type ProbeArgumentPlanEntry =
  | { schema: string }
  | { refSchema: string }
  | { value: string };

export type ProbeContext = {
  origin: 'schema' | 'call-site';
  line?: number;
  column?: number;
  missing?: Array<{ index: number; parameter: string; reason: string }>;
};

export type ProbeSpecialization = {
  probeArgumentPlan: ProbeArgumentPlanEntry[];
  probeContext?: ProbeContext;
  signature: string;
};

export type SpecializationSynthesis = {
  emitted: number;
  limit: number;
  truncated: boolean;
};


export type InspectorSelector =
  | {
      kind: 'compute-pipeline';
      compute: string;
      label: string;
    }
  | {
      kind: 'render-pipeline';
      vertex: string;
      fragment?: string;
      label: string;
      synthesizeMissing?: boolean;
    }
  | {
      kind: 'compute-pipeline' | 'render-pipeline' | 'resolvable' | 'resource';
      selector: string;
      inspectMembers?: boolean;
      member?: string[];
      declaration?: number;
      instance?: number;
      usage?: number;
      context?: { label?: string; arguments?: ProbeArgumentPlanEntry[]; with?: Array<{ slot: string; value: string }> };
      unwrap?: boolean;
      label: string;
      probeArguments?: string[];
      probeArgumentPlan?: ProbeArgumentPlanEntry[];
      probeContext?: ProbeContext;
      probeBindings?: ProbeBinding[];
    };

export type InspectionTarget = {
  instanceParentId?: string;
  id: string;
  label: string;
  selector: InspectorSelector;
  symbolNames: string[];
  pipelineSource?: PipelineSource;
};

/** A static import or re-export edge to another module. */
export type ModuleImport = {
  specifier: string;
  /** Imported name → local alias for named forms; absent for `import *` / `export *`. */
  bindings?: ModuleImportBinding[];
  /** `export … from`: the names are this module's exports, not its bindings. */
  reexport?: true;
};

export type ModuleImportBinding = {
  imported: string;
  local: string;
};

export type DiscoveredModule = {
  symbols: DiscoveredSymbol[];
  targets: InspectionTarget[];
  /** Value imports and re-exports, for locating helpers declared in other files. */
  imports: ModuleImport[];
};

export function discoverTypeGpuModule(
  fileName: string,
  sourceText: string,
): DiscoveredModule {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName),
  );
  const locals = new Map<string, Omit<DiscoveredSymbol, 'name' | 'targetIds'>>();
  const symbols: DiscoveredSymbol[] = [];
  const helperDeclarations: HelperDeclarations = new Map();
  const factoryResults = discoverFactoryResults(sourceFile, node => {
    const role = inferFunctionRole(node);
    return role === 'pipeline-factory' || role === 'resource-factory' || role === 'shader-factory';
  });

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) {
          for (const identifier of bindingIdentifiers(declaration.name)) {
            const role = factoryResults.has(identifier.text) ? 'factory-result' as const : undefined;
            if (!role) continue;
            const discovered = {
              role,
              range: nodeRange(identifier, sourceFile),
            };
            locals.set(identifier.text, discovered);
            if (isExported(statement)) {
              symbols.push({
                name: identifier.text,
                ...discovered,
                targetIds: [],
              });
            }
          }
          continue;
        }
        const role =
          (factoryResults.has(declaration.name.text) ? 'factory-result' as const : undefined) ??
          (declaration.initializer
            ? inferExpressionRole(declaration.initializer)
            : 'unknown' as TypeGpuRole);
        const discovered = {
          role,
          range: nodeRange(declaration.name, sourceFile),
          ...(declaration.initializer && hasGeneratedShaderSource(role)
            ? shaderSourceFields(declaration.initializer, sourceFile)
            : {}),
          ...pipelineSourceFromExpression(declaration.initializer, sourceFile),
        };
        if (declaration.initializer && hasGeneratedShaderSource(role)) helperDeclarations.set(declaration.name.text, declaration.initializer);
        locals.set(declaration.name.text, discovered);
        if (isExported(statement)) {
          symbols.push({
            name: declaration.name.text,
            ...discovered,
            targetIds: [],
          });
        }
      }
      continue;
    }

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const role = inferFunctionRole(statement);
      const discovered = {
        role,
        range: nodeRange(statement.name, sourceFile),
        ...(hasGeneratedShaderSource(role) && statement.body
          ? shaderSourceFields(statement, sourceFile)
          : {}),
      };
      if (hasGeneratedShaderSource(role)) helperDeclarations.set(statement.name.text, statement);
      locals.set(statement.name.text, discovered);
      if (isExported(statement)) {
        symbols.push({
          name: statement.name.text,
          ...discovered,
          targetIds: [],
        });
      }
      continue;
    }

    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        const localName = element.propertyName?.text ?? element.name.text;
        const local = locals.get(localName);
        if (!local) continue;
        symbols.push({
          name: element.name.text,
          runtimeName: localName,
          ...local,
          range: nodeRange(element.name, sourceFile),
          targetIds: [],
        });
      }
      continue;
    }

  }

  for (const [name, local] of locals) {
    if (!symbols.some((symbol) => symbol.name === name)) {
      symbols.push({
        name,
        ...local,
        targetIds: [],
      });
    }
  }

  const targets: InspectionTarget[] = [];
  const directRoles = new Set<TypeGpuRole>([
    'shader-helper',
    'shader-constant',
  ]);
  const resourceRoles = new Set<TypeGpuRole>([
    'schema',
    'bind-group-layout',
    'vertex-layout',
    'binding-resource',
    'buffer-resource',
    'texture-resource',
    'texture-view',
    'sampler-resource',
    'bind-group',
    'query-resource',
    'gpu-variable',
    'resource-collection',
  ]);

  for (const symbol of symbols) {
    const runtimeName = symbol.runtimeName ?? symbol.name;
    if (symbol.role === 'compute-entrypoint') {
      const id = `compute:${symbol.name}`;
      targets.push({
        id,
        label: symbol.name,
        selector: {
          kind: 'compute-pipeline',
          compute: runtimeName,
          label: symbol.name,
        },
        symbolNames: [symbol.name],
      });
      symbol.targetIds.push(id);
    } else if (directRoles.has(symbol.role)) {
      const id = `resolvable:${symbol.name}`;
      targets.push({ id, label: symbol.name, symbolNames: [symbol.name],
        selector: { kind: 'resolvable', selector: runtimeName, unwrap: false, label: symbol.name } });
      symbol.targetIds.push(id);
    } else if (resourceRoles.has(symbol.role)) {
      const id = `resource:${symbol.name}`;
      targets.push({
        id,
        label: symbol.name,
        selector: {
          kind: 'resource',
          selector: runtimeName,
          label: symbol.name,
        },
        symbolNames: [symbol.name],
      });
      symbol.targetIds.push(id);
    } else if (
      symbol.role === 'compute-pipeline' ||
      symbol.role === 'render-pipeline'
    ) {
      const id = `pipeline:${symbol.name}`;
      const source = symbol.pipelineSource;
      const selector: InspectorSelector =
        symbol.role === 'render-pipeline'
          ? {
              kind: 'render-pipeline',
              selector: runtimeName,
              label: symbol.name,
            }
          : {
              kind: symbol.role,
              selector: runtimeName,
              label: symbol.name,
            };
      const target: InspectionTarget = {
        id,
        label: symbol.name,
        selector,
        symbolNames: [symbol.name],
        ...(source ? { pipelineSource: clonePipelineSource(source) } : {}),
      };
      targets.push(target);
      symbol.targetIds.push(id);
      attachPipelineSourceSymbols(symbols, target, source);
    }
  }

  attachFactoryResults(symbols, targets, factoryResults);
  removeRedundantComputeTargets(symbols, targets);

  const vertices = symbols.filter(
    (symbol) => symbol.role === 'vertex-entrypoint',
  );
  const fragments = symbols.filter(
    (symbol) => symbol.role === 'fragment-entrypoint',
  );

  const renderPairs = pairRenderStages(vertices, fragments);

  if (renderPairs.length > 0) {
    for (const [vertex, fragment] of renderPairs) {
      if (vertex.targetIds.length > 0 || fragment.targetIds.length > 0) {
        continue;
      }
      const label = `${vertex.name} + ${fragment.name}`;
      const id = `render:${vertex.name}+${fragment.name}`;
      targets.push({
        id,
        label,
        selector: {
          kind: 'render-pipeline',
          vertex: vertex.runtimeName ?? vertex.name,
          fragment: fragment.runtimeName ?? fragment.name,
          label,
          synthesizeMissing: true,
        },
        symbolNames: [vertex.name, fragment.name],
      });
      vertex.targetIds.push(id);
      fragment.targetIds.push(id);
    }
  }

  for (const symbol of [...vertices, ...fragments]) {
    if (symbol.targetIds.length === 0) {
      const id = `resolvable:${symbol.name}`;
      const label = `${symbol.name} WGSL`;
      targets.push({
        id,
        label,
        selector: {
          kind: 'resolvable',
          selector: symbol.runtimeName ?? symbol.name,
          unwrap: false,
          label,
        },
        symbolNames: [symbol.name],
      });
      symbol.targetIds.push(id);
    }
  }

  discoverNestedShaderSymbols(sourceFile, symbols, targets, helperDeclarations);
  applyHelperPlans(sourceFile, helperDeclarations, symbols, targets);

  return {
    symbols: symbols.filter((symbol) => symbol.role !== 'unknown' && (symbol.role !== 'shader-factory' || symbol.targetIds.length > 0)),
    targets,
    imports: collectModuleImports(sourceFile),
  };
}

/** Nested CPU-created shader values are addressed by their original declaration offset. */
function discoverNestedShaderSymbols(file: ts.SourceFile, symbols: DiscoveredSymbol[], targets: InspectionTarget[], declarations: HelperDeclarations): void {
  const shaderRoles = new Set<TypeGpuRole>(['shader-helper', 'compute-entrypoint', 'vertex-entrypoint', 'fragment-entrypoint']);
  const nested: Array<{ symbol: DiscoveredSymbol; target: InspectionTarget; offset: number; value: ts.Expression | ts.FunctionDeclaration }> = [];
  const add = (name: ts.Identifier, value: ts.Expression | ts.FunctionDeclaration, scope: string[]) => {
    const role = ts.isFunctionDeclaration(value) ? inferFunctionRole(value) : inferExpressionRole(value);
    if (!shaderRoles.has(role)) return;
    const qualified = [...scope, name.text].join('.');
    const declaration = name.getStart(file);
    const id = `nested:${declaration}`;
    declarations.set(qualified, value);
    const symbol: DiscoveredSymbol = {
      name: qualified,
      runtimeName: name.text,
      role,
      range: nodeRange(name, file),
      ...shaderSourceFields(value, file),
      targetIds: [id],
    };
    symbols.push(symbol);
    const target: InspectionTarget = { id, label: qualified, symbolNames: [qualified], selector: {
      selector: qualified, declaration, label: qualified, kind: 'resolvable', unwrap: false,
    } };
    targets.push(target);
    nested.push({ symbol, target, offset: declaration, value });
  };
  const visit = (node: ts.Node, scope: string[]) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && scope.length > 0) add(node.name, node.initializer, scope);
    const fn = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
    if (fn) {
      const gpu = node.body && ts.isBlock(node.body) && node.body.statements.some((statement, index, statements) =>
        ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression) && statement.expression.text === 'use gpu' &&
        statements.slice(0, index).every(s => ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression)));
      if (gpu) {
        if (scope.length > 0 && ts.isFunctionDeclaration(node) && node.name) add(node.name, node, scope);
        return;
      }
      const parent = node.parent;
      const name = node.name?.getText(file) ??
        (ts.isVariableDeclaration(parent) ? parent.name.getText(file) : `callback@${node.getStart(file)}`);
      scope = [...scope, name];
    }
    node.forEachChild(child => visit(child, scope));
  };
  visit(file, []);
  const counts = new Map<string, number>();
  for (const target of targets) counts.set(target.label, (counts.get(target.label) ?? 0) + 1);
  for (const { symbol, target, offset, value } of nested) {
    if ((counts.get(target.label) ?? 0) < 2) continue;
    const { line, character } = file.getLineAndCharacterOfPosition(offset);
    const label = `${target.label}@${line + 1}:${character + 1}`;
    declarations.set(label, value);
    symbol.name = label;
    target.label = label;
    target.symbolNames = [label];
    target.selector = { ...target.selector, label };
  }
}

function attachPipelineSourceSymbols(
  symbols: DiscoveredSymbol[],
  target: InspectionTarget,
  source: DiscoveredSymbol['pipelineSource'] | undefined,
): void {
  if (!source) return;
  const stageRoles = new Set<TypeGpuRole>([
    'compute-entrypoint',
    'vertex-entrypoint',
    'fragment-entrypoint',
  ]);
  for (const selector of [source.compute, source.vertex, source.fragment]) {
    if (!selector || selector.includes('.')) continue;
    for (const symbol of symbols) {
      if (!stageRoles.has(symbol.role)) continue;
      if ((symbol.runtimeName ?? symbol.name) !== selector) continue;
      if (!target.symbolNames.includes(symbol.name)) {
        target.symbolNames.push(symbol.name);
      }
      if (!symbol.targetIds.includes(target.id)) {
        symbol.targetIds.push(target.id);
      }
    }
  }
}

function removeRedundantComputeTargets(
  symbols: DiscoveredSymbol[],
  targets: InspectionTarget[],
): void {
  const redundant = new Set<string>();
  for (const symbol of symbols) {
    if (symbol.role !== 'compute-entrypoint') continue;
    const standaloneId = `compute:${symbol.name}`;
    if (
      symbol.targetIds.includes(standaloneId) &&
      symbol.targetIds.some((id) => id !== standaloneId)
    ) {
      redundant.add(standaloneId);
      symbol.targetIds = symbol.targetIds.filter((id) => id !== standaloneId);
    }
  }
  if (redundant.size === 0) return;
  for (let index = targets.length - 1; index >= 0; index -= 1) {
    if (redundant.has(targets[index]!.id)) targets.splice(index, 1);
  }
}

function clonePipelineSource(source: PipelineSource): PipelineSource {
  return {
    ...source,
    ...(source.bindings
      ? { bindings: source.bindings.map((binding) => ({ ...binding })) }
      : {}),
  };
}

function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element)
      ? []
      : bindingIdentifiers(element.name)
  );
}

const functionRoleCache = new WeakMap<ts.Node, TypeGpuRole>();
const expressionRoleCache = new WeakMap<ts.Node, TypeGpuRole>();

function inferFunctionRole(node: ts.FunctionLikeDeclaration): TypeGpuRole {
  const cached = functionRoleCache.get(node);
  if (cached !== undefined) return cached;
  const role = computeFunctionRole(node);
  functionRoleCache.set(node, role);
  return role;
}

function computeFunctionRole(node: ts.FunctionLikeDeclaration): TypeGpuRole {
  // Only pipelines built by this function body count; one created inside a
  // nested callback belongs to that callback, not to the enclosing function.
  if (containsCall(node, isPipelineCreationCallee, true)) {
    return 'pipeline-factory';
  }
  if (containsCall(node, (callee) =>
    callee.endsWith('.createBuffer') ||
    callee.endsWith('.createTexture') ||
    callee.endsWith('.createSampler') ||
    callee.endsWith('.createBindGroup'))) {
    return 'resource-factory';
  }
  // Only a directive in this function's own prologue makes it a shader
  // helper. A CPU factory that merely defines 'use gpu' closures (geometry
  // builders, pipeline setup) cannot be called from a probe body.
  if (hasOwnUseGpuDirective(node)) return 'shader-helper';
  return containsUseGpuDirective(node) || containsCall(node, callee => ['fn', 'computeFn', 'vertexFn', 'fragmentFn'].some(name => isTgpuFactoryCall(callee, name)))
    ? 'shader-factory' : 'unknown';
}

function inferExpressionRole(expression: ts.Expression): TypeGpuRole {
  const cached = expressionRoleCache.get(expression);
  if (cached !== undefined) return cached;
  const role = computeExpressionRole(expression);
  expressionRoleCache.set(expression, role);
  return role;
}

function computeExpressionRole(expression: ts.Expression): TypeGpuRole {
  const value = unwrap(expression);
  // Resource calls inside callbacks configure future work; they do not make
  // the constructed host object itself a TypeGPU resource.
  if (ts.isNewExpression(value)) return 'unknown';
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
    return inferFunctionRole(value);
  }

  const pipelineCall = findPipelineCreationCall(value);
  if (pipelineCall) {
    const pipelineRole = pipelineRoleFromCall(pipelineCall);
    if (pipelineRole) return pipelineRole;
  }

  const resourceRole = inferResourceRole(value);
  if (resourceRole) {
    return isResourceCollectionExpression(value)
      ? 'resource-collection'
      : resourceRole;
  }

  // Arrays/objects that merely *hold* pipelines stay collections.
  if (
    isResourceCollectionExpression(value) &&
    containsPipelineCreationCall(value)
  ) {
    return 'resource-collection';
  }

  if (ts.isTaggedTemplateExpression(value)) {
    return roleFromFactoryChain(readCallee(value.tag)) ??
      (isFnShellApplication(value) ? 'shader-helper' : 'unknown');
  }

  if (ts.isCallExpression(value)) {
    // `tgpu.fn(argTypes, returnType)` alone is a shell awaiting an
    // implementation, not a resolvable function.
    if (isFnShellCall(value)) return 'unknown';
    const direct = roleFromFactoryChain(readCallee(value.expression));
    if (direct) return direct;
    if (isFnShellApplication(value)) return 'shader-helper';
  }

  return 'unknown';
}

/** `tgpu.fn(...)` called directly, without the implementation call. */
function isResourceCollectionExpression(value: ts.Expression): boolean {
  if (ts.isArrayLiteralExpression(value) || ts.isObjectLiteralExpression(value)) {
    return true;
  }
  if (!ts.isCallExpression(value)) return false;
  const callee = readCallee(value.expression);
  const method = callee ? shortCallee(callee) : undefined;
  return method === 'map' || method === 'flatMap' || callee === 'Array.from';
}

function inferResourceRole(node: ts.Node): TypeGpuRole | undefined {
  const calls: string[] = [];
  collectCallees(node, calls);

  if (calls.some((callee) => shortCallee(callee) === 'createView')) {
    return 'texture-view';
  }
  if (calls.some((callee) => isTgpuFactoryCall(callee, 'bindGroupLayout'))) {
    return 'bind-group-layout';
  }
  if (calls.some((callee) => isTgpuFactoryCall(callee, 'vertexLayout'))) {
    return 'vertex-layout';
  }
  if (calls.some((callee) =>
    isTgpuFactoryCall(callee, 'accessor') ||
    isTgpuFactoryCall(callee, 'mutableAccessor') ||
    isTgpuFactoryCall(callee, 'slot'))) {
    return 'binding-resource';
  }
  if (calls.some((callee) =>
    isTgpuFactoryCall(callee, 'workgroupVar') ||
    isTgpuFactoryCall(callee, 'privateVar'))) {
    return 'gpu-variable';
  }
  if (calls.some((callee) => shortCallee(callee) === 'createBindGroup')) {
    return 'bind-group';
  }
  if (calls.some((callee) => shortCallee(callee) === 'createSampler')) {
    return 'sampler-resource';
  }
  if (calls.some((callee) => shortCallee(callee) === 'createComparisonSampler')) {
    return 'sampler-resource';
  }
  if (calls.some((callee) => shortCallee(callee) === 'createQuerySet')) {
    return 'query-resource';
  }
  if (calls.some((callee) => shortCallee(callee) === 'createTexture')) {
    return 'texture-resource';
  }
  if (calls.some((callee) =>
    shortCallee(callee) === 'createBuffer' ||
    shortCallee(callee) === 'createUniform' ||
    shortCallee(callee) === 'createMutable' ||
    shortCallee(callee) === 'createReadonly')) {
    return 'buffer-resource';
  }
  return undefined;
}

function shortCallee(callee: string): string {
  return callee.split('.').at(-1) ?? callee;
}

/** Matches `tgpu.<name>` written directly or through a bracket namespace. */
function collectCallees(node: ts.Node, output: string[]): void {
  if (ts.isCallExpression(node)) {
    const callee = readCallee(node.expression);
    if (callee) output.push(callee);
  }
  node.forEachChild((child) => collectCallees(child, output));
}

function pipelineSourceFromExpression(
  expression: ts.Expression | undefined,
  sourceFile: ts.SourceFile,
): { pipelineSource?: NonNullable<DiscoveredSymbol['pipelineSource']> } {
  if (!expression) return {};
  const call = findPipelineCreationCall(expression);
  if (!call) return {};
  const callee = readCallee(call.expression);
  const bindings = pipelineBindingsFromExpression(
    expression,
    call,
    sourceFile,
  );
  if (callee?.endsWith('.createGuardedComputePipeline')) {
    return {
      pipelineSource: {
        kind: 'compute-pipeline',
        ...(bindings.length > 0 ? { bindings } : {}),
      },
    };
  }
  const descriptor = call.arguments[0];
  if (!descriptor || !ts.isObjectLiteralExpression(descriptor)) return {};

  if (pipelineRoleFromCall(call) === 'compute-pipeline') {
    const compute = readObjectSelector(descriptor, 'compute', sourceFile);
    return {
      pipelineSource: {
        kind: 'compute-pipeline',
        ...(compute ? { compute } : {}),
        ...(bindings.length > 0 ? { bindings } : {}),
      },
    };
  }
  const vertex = readObjectSelector(descriptor, 'vertex', sourceFile);
  const fragment = readObjectSelector(descriptor, 'fragment', sourceFile);
  return {
    pipelineSource: {
      kind: 'render-pipeline',
      ...(vertex ? { vertex } : {}),
      ...(fragment ? { fragment } : {}),
      ...(bindings.length > 0 ? { bindings } : {}),
    },
  };
}

function pipelineBindingsFromExpression(
  expression: ts.Expression,
  pipelineCall: ts.CallExpression,
  sourceFile: ts.SourceFile,
): PipelineSourceBinding[] {
  const calls: ts.CallExpression[] = [];
  collectCallExpressions(expression, calls);
  return calls
    .filter((call) =>
      shortCallee(readCallee(call.expression) ?? '') === 'with' &&
      (
        callChainContains(call, pipelineCall) ||
        callChainContains(pipelineCall, call)
      )
    )
    .sort((left, right) => left.getStart(sourceFile) - right.getStart(sourceFile))
    .flatMap((call): PipelineSourceBinding[] => {
      const source = call.arguments[0];
      if (!source) return [];
      const value = call.arguments[1];
      return [{
        source: authoredExpressionLabel(source, sourceFile),
        ...(value
          ? { value: authoredExpressionLabel(value, sourceFile) }
          : {}),
      }];
    });
}

function collectCallExpressions(
  node: ts.Node,
  output: ts.CallExpression[],
): void {
  if (ts.isCallExpression(node)) output.push(node);
  node.forEachChild((child) => collectCallExpressions(child, output));
}

function callChainContains(
  outer: ts.CallExpression,
  expected: ts.CallExpression,
): boolean {
  let current: ts.CallExpression | undefined = outer;
  while (current) {
    if (current === expected) return true;
    const callee = unwrap(current.expression);
    if (
      !ts.isPropertyAccessExpression(callee) &&
      !ts.isElementAccessExpression(callee)
    ) {
      return false;
    }
    const receiver = unwrap(callee.expression);
    current = ts.isCallExpression(receiver) ? receiver : undefined;
  }
  return false;
}

function authoredExpressionLabel(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
): string {
  const text = expression.getText(sourceFile).replace(/\s+/g, ' ').trim();
  return text.length <= 80 ? text : `${text.slice(0, 77)}…`;
}

function isPipelineCreationCallee(callee: string | undefined): boolean {
  if (!callee) return false;
  return callee.endsWith('.createRenderPipeline') ||
    callee.endsWith('.createComputePipeline') ||
    callee.endsWith('.createGuardedComputePipeline') ||
    callee.endsWith('.createPipeline');
}

/**
 * Finds the pipeline constructor producing `node`'s own value, following only
 * the direct value path (parens, `await`, both conditional branches, a
 * `.with(...)` chain head) — never into array/object literals or callback
 * bodies, since a pipeline created *inside* a collection doesn't make the
 * collection one.
 */
function findPipelineCreationCall(
  node: ts.Node,
): ts.CallExpression | undefined {
  const value = ts.isExpression(node) ? unwrap(node) : node;

  if (ts.isAwaitExpression(value)) {
    return findPipelineCreationCall(value.expression);
  }
  if (ts.isConditionalExpression(value)) {
    return findPipelineCreationCall(value.whenTrue) ??
      findPipelineCreationCall(value.whenFalse);
  }
  if (!ts.isCallExpression(value)) return undefined;

  if (isPipelineCreationCallee(readCallee(value.expression))) return value;

  const target = unwrap(value.expression);
  if (
    ts.isPropertyAccessExpression(target) ||
    ts.isElementAccessExpression(target)
  ) {
    return findPipelineCreationCall(target.expression);
  }
  return undefined;
}

function containsPipelineCreationCall(node: ts.Node): boolean {
  return containsCall(node, isPipelineCreationCallee);
}

function hasObjectProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): boolean {
  return object.properties.some((property) =>
    property.name !== undefined &&
    ts.isPropertyName(property.name) &&
    propertyNameText(property.name) === name
  );
}

/**
 * `root.createPipeline` is the unified constructor: the descriptor decides
 * whether it produces a compute or a render pipeline.
 */
function pipelineRoleFromCall(
  call: ts.CallExpression,
): 'compute-pipeline' | 'render-pipeline' | undefined {
  const callee = readCallee(call.expression);
  if (!callee) return undefined;
  if (callee.endsWith('.createRenderPipeline')) return 'render-pipeline';
  if (
    callee.endsWith('.createComputePipeline') ||
    callee.endsWith('.createGuardedComputePipeline')
  ) {
    return 'compute-pipeline';
  }
  if (!callee.endsWith('.createPipeline')) return undefined;
  const descriptor = call.arguments[0];
  return descriptor &&
      ts.isObjectLiteralExpression(descriptor) &&
      hasObjectProperty(descriptor, 'compute')
    ? 'compute-pipeline'
    : 'render-pipeline';
}

function readObjectSelector(
  object: ts.ObjectLiteralExpression,
  name: string,
  sourceFile: ts.SourceFile,
): string | undefined {
  for (const property of object.properties) {
    if (
      ts.isShorthandPropertyAssignment(property) &&
      property.name.text === name
    ) {
      return property.name.text;
    }
    if (
      ts.isPropertyAssignment(property) &&
      propertyNameText(property.name) === name
    ) {
      return expressionSelector(property.initializer, sourceFile);
    }
  }
  return undefined;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function pairRenderStages(
  vertices: DiscoveredSymbol[],
  fragments: DiscoveredSymbol[],
): Array<[DiscoveredSymbol, DiscoveredSymbol]> {
  if (vertices.length === 1 && fragments.length === 1) {
    return [[vertices[0]!, fragments[0]!]];
  }

  const pairs: Array<[DiscoveredSymbol, DiscoveredSymbol]> = [];
  const claimedFragments = new Set<string>();
  for (const vertex of vertices) {
    const stem = renderStageStem(vertex.name);
    const matches = fragments.filter(
      (fragment) =>
        !claimedFragments.has(fragment.name) &&
        renderStageStem(fragment.name) === stem,
    );
    if (matches.length === 1) {
      const fragment = matches[0]!;
      pairs.push([vertex, fragment]);
      claimedFragments.add(fragment.name);
    }
  }
  return pairs;
}

function renderStageStem(name: string): string {
  return name
    .replace(/(?:vertex|vert|fragment|frag|vs|fs)(?:main|shader|fn)?$/i, '')
    .replace(/(?:main|shader|fn)$/i, '')
    .toLowerCase();
}

function roleFromCallee(callee: string | undefined): TypeGpuRole | undefined {
  const short = callee?.split('.').at(-1);
  if (short === 'computeFn') return 'compute-entrypoint';
  if (short === 'vertexFn') return 'vertex-entrypoint';
  if (short === 'fragmentFn') return 'fragment-entrypoint';
  return undefined;
}

function roleFromFactoryChain(callee: string | undefined): TypeGpuRole | undefined {
  if (!callee) return undefined;
  const parts = calleeSegments(callee);
  const typegpuFactory = parts[0] === 'tgpu' ? parts[1] : undefined;
  if (typegpuFactory === 'computeFn') return 'compute-entrypoint';
  if (typegpuFactory === 'vertexFn') return 'vertex-entrypoint';
  if (typegpuFactory === 'fragmentFn') return 'fragment-entrypoint';
  if (typegpuFactory === 'fn') return 'shader-helper';
  if (typegpuFactory === 'const' || typegpuFactory === 'comptime') {
    return 'shader-constant';
  }

  if (
    parts[0] === 'd' &&
    (parts[1] === 'struct' ||
      parts[1] === 'unstruct' ||
      parts[1] === 'arrayOf' ||
      parts[1] === 'disarrayOf')
  ) {
    return 'schema';
  }
  return roleFromCallee(callee);
}

function containsUseGpuDirective(node: ts.Node): boolean {
  return containsNode(node, (child) =>
    ts.isExpressionStatement(child) &&
    ts.isStringLiteral(child.expression) &&
    child.expression.text === 'use gpu');
}

function containsCall(
  node: ts.Node,
  predicate: (callee: string) => boolean,
  skipNestedFunctions = false,
): boolean {
  return containsNode(node, (child) => {
    if (!ts.isCallExpression(child)) return false;
    const callee = readCallee(child.expression);
    return callee ? predicate(callee) : false;
  }, skipNestedFunctions);
}

// `ts.forEachChild` walks only real nodes; `getChildren()` would materialize
// every token on a walk that runs on each keystroke.
function containsNode(
  node: ts.Node,
  predicate: (node: ts.Node) => boolean,
  skipNestedFunctions = false,
): boolean {
  if (predicate(node)) return true;
  return ts.forEachChild(node, (child) => {
    if (skipNestedFunctions && ts.isFunctionLike(child)) return undefined;
    return containsNode(child, predicate, skipNestedFunctions) || undefined;
  }) ?? false;
}

/** Value-level import and re-export edges in source order; type-only forms are skipped. */
function collectModuleImports(sourceFile: ts.SourceFile): ModuleImport[] {
  const imports: ModuleImport[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const clause = statement.importClause;
      if (!clause || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;
      const specifier = statement.moduleSpecifier.text;
      const bindings: ModuleImportBinding[] = [];
      if (clause.name) bindings.push({ imported: 'default', local: clause.name.text });
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        imports.push({ specifier });
        continue;
      }
      for (const element of clause.namedBindings?.elements ?? []) {
        if (element.isTypeOnly) continue;
        bindings.push({
          imported: (element.propertyName ?? element.name).text,
          local: element.name.text,
        });
      }
      if (bindings.length > 0) imports.push({ specifier, bindings });
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      !statement.isTypeOnly
    ) {
      const specifier = statement.moduleSpecifier.text;
      if (!statement.exportClause || ts.isNamespaceExport(statement.exportClause)) {
        imports.push({ specifier, reexport: true });
        continue;
      }
      const bindings = statement.exportClause.elements
        .filter((element) => !element.isTypeOnly)
        .map((element) => ({
          imported: (element.propertyName ?? element.name).text,
          local: element.name.text,
        }));
      if (bindings.length > 0) imports.push({ specifier, bindings, reexport: true });
    }
  }
  return imports;
}

function isExported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) ?? false);
}

function nodeRange(node: ts.Node, sourceFile: ts.SourceFile): Range {
  return {
    start: positionAt(node.getStart(sourceFile), sourceFile),
    end: positionAt(node.getEnd(), sourceFile),
  };
}

function hasGeneratedShaderSource(role: TypeGpuRole): boolean {
  return role === 'compute-entrypoint' ||
    role === 'vertex-entrypoint' ||
    role === 'fragment-entrypoint' ||
    role === 'shader-helper' ||
    role === 'shader-constant' ||
    role === 'compute-pipeline' ||
    role === 'render-pipeline';
}

function shaderSourceFields(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): Pick<DiscoveredSymbol, 'shaderSourceTokens' | 'shaderBodies'> {
  const shaderBodies = collectShaderBodies(node, sourceFile);
  return {
    shaderSourceTokens: collectShaderSourceTokens(node, sourceFile),
    ...(shaderBodies.length > 0 ? { shaderBodies } : {}),
  };
}

function collectShaderBodies(node: ts.Node, sourceFile: ts.SourceFile): ShaderBody[] {
  return useGpuBodies(node).flatMap((fn) => {
    const body = (fn as ts.FunctionLikeDeclaration).body;
    if (!body || !ts.isBlock(body)) return [];
    const statements: ShaderStatement[] = [];
    collectBlockStatements(body, [], statements, sourceFile, true);
    return [{ range: nodeRange(body, sourceFile), statements }];
  });
}

/**
 * Mirrors tinyest-for-wgsl: every statement of a block is one node, in
 * order, except the directive prologue of the function body, which Babel
 * keeps out of `body`. Multi-declarator declarations are rejected upstream.
 */
function collectBlockStatements(
  block: ts.Block,
  prefix: StatementPathSegment[],
  out: ShaderStatement[],
  sourceFile: ts.SourceFile,
  functionBody: boolean,
): void {
  let prologue = functionBody;
  let index = 0;
  for (const statement of block.statements) {
    if (
      prologue &&
      ts.isExpressionStatement(statement) &&
      ts.isStringLiteral(statement.expression)
    ) {
      continue;
    }
    prologue = false;
    collectStatement(statement, [...prefix, index], out, sourceFile);
    index += 1;
  }
}

function collectStatement(
  statement: ts.Statement,
  path: StatementPathSegment[],
  out: ShaderStatement[],
  sourceFile: ts.SourceFile,
): void {
  const range = nodeRange(statement, sourceFile);
  if (ts.isBlock(statement)) {
    out.push({ path, range, headRange: range });
    collectBlockStatements(statement, path, out, sourceFile, false);
    return;
  }
  if (ts.isIfStatement(statement)) {
    out.push({
      path,
      range,
      headRange: statementHeadRange(statement, statement.thenStatement, sourceFile),
    });
    collectStatement(statement.thenStatement, [...path, 'then'], out, sourceFile);
    if (statement.elseStatement) {
      collectStatement(statement.elseStatement, [...path, 'else'], out, sourceFile);
    }
    return;
  }
  if (ts.isForStatement(statement)) {
    out.push({
      path,
      range,
      headRange: statementHeadRange(statement, statement.statement, sourceFile),
    });
    if (statement.initializer) {
      const initializer = nodeRange(statement.initializer, sourceFile);
      out.push({ path: [...path, 'init'], range: initializer, headRange: initializer });
    }
    if (statement.incrementor) {
      const incrementor = nodeRange(statement.incrementor, sourceFile);
      out.push({ path: [...path, 'update'], range: incrementor, headRange: incrementor });
    }
    collectStatement(statement.statement, [...path, 'body'], out, sourceFile);
    return;
  }
  if (ts.isWhileStatement(statement) || ts.isForOfStatement(statement)) {
    out.push({
      path,
      range,
      headRange: statementHeadRange(statement, statement.statement, sourceFile),
    });
    collectStatement(statement.statement, [...path, 'body'], out, sourceFile);
    return;
  }
  out.push({ path, range, headRange: range });
}

/** From the statement's start through the `)` that closes its header. */
function statementHeadRange(
  statement: ts.Statement,
  body: ts.Statement,
  sourceFile: ts.SourceFile,
): Range {
  const start = statement.getStart(sourceFile);
  let end = body.getStart(sourceFile);
  while (end > start && sourceFile.text[end - 1] !== ')') end -= 1;
  return { start: positionAt(start, sourceFile), end: positionAt(end, sourceFile) };
}

function collectShaderSourceTokens(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): ShaderSourceToken[] {
  const tokens: ShaderSourceToken[] = [];
  const shaderBodies = useGpuBodies(node);
  const sourceRoots = shaderBodies.length > 0 ? shaderBodies : [node];
  for (const root of sourceRoots) {
    collectScannedShaderTokens(
      sourceFile.text,
      root.getStart(sourceFile),
      root.getEnd(),
      0,
      sourceFile,
      tokens,
    );
    visitNoSubstitutionTemplates(root, (template) => {
      collectScannedShaderTokens(
        template.text,
        0,
        template.text.length,
        template.getStart(sourceFile) + 1,
        sourceFile,
        tokens,
      );
    });
  }
  return tokens;
}

function useGpuBodies(node: ts.Node): ts.Node[] {
  const bodies: ts.Node[] = [];
  const visit = (current: ts.Node): void => {
    const functionBody = ts.isArrowFunction(current) ||
        ts.isFunctionExpression(current) ||
        ts.isFunctionDeclaration(current)
      ? current.body
      : undefined;
    if (
      functionBody &&
      ts.isBlock(functionBody) &&
      containsUseGpuDirective(functionBody)
    ) {
      bodies.push(current);
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return bodies;
}

function visitNoSubstitutionTemplates(
  node: ts.Node,
  onTemplate: (template: ts.NoSubstitutionTemplateLiteral) => void,
): void {
  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    onTemplate(node);
    return;
  }
  ts.forEachChild(node, (child) => visitNoSubstitutionTemplates(child, onTemplate));
}

function collectScannedShaderTokens(
  text: string,
  start: number,
  end: number,
  sourceOffset: number,
  sourceFile: ts.SourceFile,
  tokens: ShaderSourceToken[],
): void {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    sourceFile.languageVariant,
    text,
    undefined,
    start,
    Math.max(0, end - start),
  );
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    const sourceText = scanner.getTokenText();
    const mappedText = shaderTokenText(kind, sourceText);
    if (!mappedText) continue;
    tokens.push({
      text: mappedText,
      range: rangeFromOffsets(
        sourceFile,
        sourceOffset + scanner.getTokenPos(),
        sourceOffset + scanner.getTextPos(),
      ),
    });
  }
}

const MAPPABLE_SHADER_KEYWORDS = new Set([
  'break',
  'case',
  'continue',
  'default',
  'else',
  'false',
  'for',
  'if',
  'return',
  'switch',
  'true',
  'while',
]);

const MAPPABLE_SHADER_OPERATORS = new Set([
  '!',
  '!=',
  '%',
  '%=',
  '&',
  '&&',
  '&=',
  '*',
  '*=',
  '+',
  '++',
  '+=',
  '-',
  '--',
  '-=',
  '/',
  '/=',
  '<',
  '<<',
  '<<=',
  '<=',
  '=',
  '==',
  '>',
  '>=',
  '>>',
  '>>=',
  '^',
  '^=',
  '|',
  '|=',
  '||',
]);

function shaderTokenText(kind: ts.SyntaxKind, sourceText: string): string | undefined {
  if (kind === ts.SyntaxKind.Identifier || kind === ts.SyntaxKind.NumericLiteral) {
    return sourceText;
  }
  if (MAPPABLE_SHADER_KEYWORDS.has(sourceText)) return sourceText;
  if (sourceText === '===' || sourceText === '!==') return sourceText.slice(0, 2);
  return MAPPABLE_SHADER_OPERATORS.has(sourceText) ? sourceText : undefined;
}

function rangeFromOffsets(
  sourceFile: ts.SourceFile,
  start: number,
  end: number,
): Range {
  const startPosition = sourceFile.getLineAndCharacterOfPosition(start);
  const endPosition = sourceFile.getLineAndCharacterOfPosition(end);
  return {
    start: { line: startPosition.line, character: startPosition.character },
    end: { line: endPosition.line, character: endPosition.character },
  };
}

function positionAt(offset: number, sourceFile: ts.SourceFile): Position {
  const position = sourceFile.getLineAndCharacterOfPosition(offset);
  return { line: position.line, character: position.character };
}

function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx') || fileName.endsWith('.jsx')) {
    return ts.ScriptKind.TSX;
  }
  if (
    fileName.endsWith('.js') ||
    fileName.endsWith('.mjs') ||
    fileName.endsWith('.cjs')
  ) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}
