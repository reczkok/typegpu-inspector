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
  | 'pipeline-result'
  | 'resource-result'
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
  probeArguments?: string[];
  probeArgumentPlan?: ProbeArgumentPlanEntry[];
  probeBindings?: ProbeBinding[];
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

export type ProbeSpecialization = {
  probeArguments: string[];
  signature: string;
};

export type SpecializationSynthesis = {
  emitted: number;
  limit: number;
  truncated: boolean;
};

/**
 * Each specialization becomes an independently resolved browser target. Keep
 * the default small: it is large enough for the common 2x2 and
 * 2x2x2 finite-generic cases without letting a broad union make every save
 * fan out into dozens of shader resolutions.
 */
export const MAX_SYNTHESIZED_SPECIALIZATIONS = 8;

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
      unwrap?: boolean;
      label: string;
      probeArguments?: string[];
      probeArgumentPlan?: ProbeArgumentPlanEntry[];
      probeBindings?: ProbeBinding[];
    };

export type InspectionTarget = {
  id: string;
  label: string;
  selector: InspectorSelector;
  symbolNames: string[];
  pipelineSource?: PipelineSource;
};

type FactoryOutput = {
  path: string[];
  role: TypeGpuRole;
  pipelineSource?: NonNullable<DiscoveredSymbol['pipelineSource']>;
};

type FactoryResultBinding = FactoryOutput & {
  factoryName: string;
  /** Concrete value produced by this factory call, before selecting an output leaf. */
  resultSelector: string;
  selector: string;
  resultName: string;
};

export type DiscoveredModule = {
  symbols: DiscoveredSymbol[];
  targets: InspectionTarget[];
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
  const probeBindingsByHelper = discoverZeroAccessorBindingsByHelper(sourceFile);
  const contextualProbeInputs = discoverContextualProbeInputs(sourceFile);
  const factoryOutputs = discoverFactoryOutputs(sourceFile);
  const factoryResultBindings = discoverFactoryResultBindings(
    sourceFile,
    factoryOutputs,
  );
  const factoryResultRoles = summarizeFactoryResultRoles(factoryResultBindings);

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) {
          for (const identifier of bindingIdentifiers(declaration.name)) {
            const role = factoryResultRoles.get(identifier.text);
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
          factoryResultRoles.get(declaration.name.text) ??
          (declaration.initializer
            ? inferExpressionRole(declaration.initializer)
            : 'unknown' as TypeGpuRole);
        const discovered = {
          role,
          range: nodeRange(declaration.name, sourceFile),
          ...(declaration.initializer && hasGeneratedShaderSource(role)
            ? shaderSourceFields(declaration.initializer, sourceFile)
            : {}),
          ...(contextualProbeInputs.get(declaration.name.text) ??
            probeArgumentsFromExpression(declaration.initializer, sourceFile)),
          ...(role === 'shader-helper' &&
              (probeBindingsByHelper.get(declaration.name.text)?.length ?? 0) > 0
            ? { probeBindings: probeBindingsByHelper.get(declaration.name.text)! }
            : {}),
          ...pipelineSourceFromExpression(declaration.initializer, sourceFile),
        };
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
        ...(contextualProbeInputs.get(statement.name.text) ??
          probeArgumentsFromParameters(
            statement.parameters,
            sourceFile,
            new Set(
              statement.typeParameters?.map((parameter) => parameter.name.text) ?? [],
            ),
          )),
        ...(role === 'shader-helper' &&
            (probeBindingsByHelper.get(statement.name.text)?.length ?? 0) > 0
          ? { probeBindings: probeBindingsByHelper.get(statement.name.text)! }
          : {}),
      };
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
      if (symbol.probeSpecializations?.length) {
        for (
          const [index, specialization] of symbol.probeSpecializations.entries()
        ) {
          const id = `resolvable:${symbol.name}:specialization:${index}`;
          const label = `${symbol.name}(${specialization.signature})`;
          targets.push({
            id,
            label,
            selector: {
              kind: 'resolvable',
              selector: runtimeName,
              unwrap: false,
              label,
              probeArguments: specialization.probeArguments,
              ...(symbol.probeBindings?.length
                ? { probeBindings: symbol.probeBindings }
                : {}),
            },
            symbolNames: [symbol.name],
          });
          symbol.targetIds.push(id);
        }
      } else {
        const id = `resolvable:${symbol.name}`;
        targets.push({
          id,
          label: symbol.name,
          selector: {
            kind: 'resolvable',
            selector: runtimeName,
            unwrap: false,
            label: symbol.name,
            ...(symbol.probeArguments?.length
              ? { probeArguments: symbol.probeArguments }
              : {}),
            ...(symbol.probeArgumentPlan?.length
              ? { probeArgumentPlan: symbol.probeArgumentPlan }
              : {}),
            ...(symbol.probeBindings?.length
              ? { probeBindings: symbol.probeBindings }
              : {}),
          },
          symbolNames: [symbol.name],
        });
        symbol.targetIds.push(id);
      }
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

  attachFactoryResultTargets(symbols, targets, factoryResultBindings);
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

  return {
    symbols: symbols.filter((symbol) => symbol.role !== 'unknown'),
    targets,
  };
}

// Factory analysis is intentionally static and call-site driven. It describes
// values the application already created, but never invokes a host factory.
function discoverFactoryOutputs(
  sourceFile: ts.SourceFile,
): Map<string, FactoryOutput[]> {
  const factories = new Map<string, ts.FunctionLikeDeclaration>();
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      isFactoryRole(inferFunctionRole(statement))
    ) {
      factories.set(statement.name.text, statement);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const value = unwrap(declaration.initializer);
      if (
        (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) &&
        isFactoryRole(inferFunctionRole(value))
      ) {
        factories.set(declaration.name.text, value);
      }
    }
  }

  const outputs = new Map<string, FactoryOutput[]>();
  for (let pass = 0; pass < factories.size + 1; pass += 1) {
    let changed = false;
    for (const [name, factory] of factories) {
      const next = analyzeFactoryOutputs(factory, sourceFile, outputs);
      if (
        next.length > 0 &&
        factoryOutputKey(next) !== factoryOutputKey(outputs.get(name) ?? [])
      ) {
        outputs.set(name, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return outputs;
}

function analyzeFactoryOutputs(
  factory: ts.FunctionLikeDeclaration,
  sourceFile: ts.SourceFile,
  knownFactories: Map<string, FactoryOutput[]>,
): FactoryOutput[] {
  if (!factory.body) return [];
  const locals = collectFunctionLocalInitializers(factory.body);
  if (!ts.isBlock(factory.body)) {
    return describeFactoryExpression(
      factory.body,
      sourceFile,
      locals,
      knownFactories,
      new Set(),
    );
  }
  const returns: ts.Expression[] = [];

  const visit = (node: ts.Node): void => {
    if (node !== factory.body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) {
      returns.push(node.expression);
      return;
    }
    node.forEachChild(visit);
  };
  visit(factory.body);

  return mergeFactoryOutputs(
    returns.flatMap((expression) =>
      describeFactoryExpression(
        expression,
        sourceFile,
        locals,
        knownFactories,
        new Set(),
      )
    ),
  );
}

function collectFunctionLocalInitializers(
  body: ts.ConciseBody,
): Map<string, ts.Expression> {
  const locals = new Map<string, ts.Expression>();
  const visit = (node: ts.Node): void => {
    if (node !== body && ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      locals.set(node.name.text, node.initializer);
    }
    node.forEachChild(visit);
  };
  visit(body);
  return locals;
}

function describeFactoryExpression(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  locals: Map<string, ts.Expression>,
  knownFactories: Map<string, FactoryOutput[]>,
  resolving: Set<string>,
): FactoryOutput[] {
  const value = unwrap(expression);

  if (ts.isObjectLiteralExpression(value)) {
    const outputs: FactoryOutput[] = [];
    for (const property of value.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        outputs.push(
          ...prefixFactoryOutputs(
            property.name.text,
            describeFactoryExpression(
              property.name,
              sourceFile,
              locals,
              knownFactories,
              resolving,
            ),
          ),
        );
      } else if (ts.isPropertyAssignment(property)) {
        const name = propertyNameText(property.name);
        if (!name) continue;
        outputs.push(
          ...prefixFactoryOutputs(
            name,
            describeFactoryExpression(
              property.initializer,
              sourceFile,
              locals,
              knownFactories,
              resolving,
            ),
          ),
        );
      }
    }
    return mergeFactoryOutputs(outputs);
  }

  if (ts.isArrayLiteralExpression(value)) {
    return mergeFactoryOutputs(
      value.elements.flatMap((element, index) =>
        ts.isSpreadElement(element)
          ? []
          : prefixFactoryOutputs(
              String(index),
              describeFactoryExpression(
                element,
                sourceFile,
                locals,
                knownFactories,
                resolving,
              ),
            )
      ),
    );
  }

  if (ts.isConditionalExpression(value)) {
    return intersectFactoryOutputs(
      describeFactoryExpression(
        value.whenTrue,
        sourceFile,
        locals,
        knownFactories,
        new Set(resolving),
      ),
      describeFactoryExpression(
        value.whenFalse,
        sourceFile,
        locals,
        knownFactories,
        new Set(resolving),
      ),
    );
  }

  if (ts.isIdentifier(value)) {
    if (resolving.has(value.text)) return [];
    const initializer = locals.get(value.text);
    if (!initializer) return [];
    const nextResolving = new Set(resolving);
    nextResolving.add(value.text);
    return describeFactoryExpression(
      initializer,
      sourceFile,
      locals,
      knownFactories,
      nextResolving,
    );
  }

  if (ts.isPropertyAccessExpression(value)) {
    const base = describeFactoryExpression(
      value.expression,
      sourceFile,
      locals,
      knownFactories,
      new Set(resolving),
    );
    return base
      .filter((output) => output.path[0] === value.name.text)
      .map((output) => ({ ...output, path: output.path.slice(1) }));
  }

  if (ts.isElementAccessExpression(value) && value.argumentExpression) {
    const key = staticPropertyKey(value.argumentExpression);
    if (key !== undefined) {
      const base = describeFactoryExpression(
        value.expression,
        sourceFile,
        locals,
        knownFactories,
        new Set(resolving),
      );
      return base
        .filter((output) => output.path[0] === key)
        .map((output) => ({ ...output, path: output.path.slice(1) }));
    }
  }

  if (ts.isCallExpression(value)) {
    const callee = readCallee(value.expression);
    const known = callee && knownFactories.get(callee);
    if (known) return known.map(cloneFactoryOutput);

    if (ts.isPropertyAccessExpression(value.expression)) {
      const chained = describeFactoryExpression(
        value.expression.expression,
        sourceFile,
        locals,
        knownFactories,
        new Set(resolving),
      ).filter((output) => isPipelineRole(output.role));
      if (chained.length > 0) return chained;
    }

    const role = inferExpressionRole(value);
    if (isInspectableFactoryOutputRole(role)) {
      const pipelineSource = isPipelineRole(role)
        ? pipelineSourceFromExpression(value, sourceFile).pipelineSource
        : undefined;
      return [{
        path: [],
        role,
        ...(pipelineSource ? { pipelineSource } : {}),
      }];
    }
  }

  return [];
}

function discoverFactoryResultBindings(
  sourceFile: ts.SourceFile,
  factoryOutputs: Map<string, FactoryOutput[]>,
): FactoryResultBinding[] {
  const bindings: FactoryResultBinding[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!declaration.initializer) continue;
      const calls = findFactoryResultCalls(
        declaration.initializer,
        factoryOutputs,
        [],
      );
      for (const call of calls) {
        bindings.push(
          ...bindFactoryOutputs(
            declaration.name,
            call.path,
            call.factoryName,
            call.outputs,
          ),
        );
      }
    }
  }
  return dedupeFactoryBindings(bindings);
}

function findFactoryResultCalls(
  expression: ts.Expression,
  factoryOutputs: Map<string, FactoryOutput[]>,
  path: string[],
): Array<{ factoryName: string; path: string[]; outputs: FactoryOutput[] }> {
  const value = unwrap(expression);
  if (ts.isCallExpression(value)) {
    const factoryName = readCallee(value.expression);
    const outputs = factoryName
      ? factoryOutputs.get(factoryName)
      : undefined;
    return factoryName && outputs?.length
      ? [{ factoryName, path, outputs }]
      : [];
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.flatMap((element, index) =>
      ts.isSpreadElement(element)
        ? []
        : findFactoryResultCalls(
            element,
            factoryOutputs,
            [...path, String(index)],
          )
    );
  }
  if (ts.isObjectLiteralExpression(value)) {
    return value.properties.flatMap((property) => {
      if (!ts.isPropertyAssignment(property)) return [];
      const name = propertyNameText(property.name);
      return name
        ? findFactoryResultCalls(
            property.initializer,
            factoryOutputs,
            [...path, name],
          )
        : [];
    });
  }
  if (ts.isConditionalExpression(value)) {
    return [
      ...findFactoryResultCalls(value.whenTrue, factoryOutputs, path),
      ...findFactoryResultCalls(value.whenFalse, factoryOutputs, path),
    ];
  }
  return [];
}

function bindFactoryOutputs(
  name: ts.BindingName,
  callPath: string[],
  factoryName: string,
  outputs: FactoryOutput[],
): FactoryResultBinding[] {
  if (ts.isIdentifier(name)) {
    return outputs.map((output) => ({
      ...cloneFactoryOutput(output),
      factoryName,
      resultName: name.text,
      resultSelector: [name.text, ...callPath].join('.'),
      selector: [name.text, ...callPath, ...output.path].join('.'),
    }));
  }

  if (callPath.length > 0) return [];
  const bindings: FactoryResultBinding[] = [];
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (element.dotDotDotToken || !ts.isIdentifier(element.name)) continue;
    const sourceKey = ts.isObjectBindingPattern(name)
      ? propertyNameText(element.propertyName ?? element.name)
      : String(name.elements.indexOf(element));
    if (sourceKey === undefined) continue;
    for (const output of outputs) {
      if (output.path[0] !== sourceKey) continue;
      const remaining = output.path.slice(1);
      bindings.push({
        path: remaining,
        role: output.role,
        factoryName,
        resultName: element.name.text,
        resultSelector: element.name.text,
        selector: [element.name.text, ...remaining].join('.'),
        ...(output.pipelineSource
          ? { pipelineSource: clonePipelineSource(output.pipelineSource) }
          : {}),
      });
    }
  }
  return bindings;
}

function summarizeFactoryResultRoles(
  bindings: FactoryResultBinding[],
): Map<string, TypeGpuRole> {
  const byResult = new Map<string, FactoryResultBinding[]>();
  for (const binding of bindings) {
    const current = byResult.get(binding.resultName) ?? [];
    current.push(binding);
    byResult.set(binding.resultName, current);
  }

  const roles = new Map<string, TypeGpuRole>();
  for (const [name, results] of byResult) {
    const uniqueRoles = new Set(results.map((result) => result.role));
    if (results.length === 1 && results[0]!.selector === name) {
      roles.set(name, results[0]!.role);
    } else if ([...uniqueRoles].every(isPipelineRole)) {
      roles.set(name, 'pipeline-result');
    } else {
      roles.set(name, 'resource-result');
    }
  }
  return roles;
}

function attachFactoryResultTargets(
  symbols: DiscoveredSymbol[],
  targets: InspectionTarget[],
  bindings: FactoryResultBinding[],
): void {
  const aggregated = new Set<FactoryResultBinding>();
  const groups = new Map<string, FactoryResultBinding[]>();
  for (const binding of bindings) {
    const key = `${binding.factoryName}\0${binding.resultSelector}`;
    const current = groups.get(key) ?? [];
    current.push(binding);
    groups.set(key, current);
  }

  for (const group of groups.values()) {
    const first = group[0]!;
    const isResourceBundle = group.every((binding) => !isPipelineRole(binding.role));
    const hasNestedOutputs = group.some(
      (binding) => binding.selector !== binding.resultSelector,
    );
    if (!isResourceBundle || (group.length === 1 && !hasNestedOutputs)) {
      continue;
    }

    const label = `${first.factoryName} → ${first.resultSelector}`;
    const target: InspectionTarget = {
      id: `factory-result:${first.factoryName}:${first.resultSelector}`,
      label,
      selector: {
        kind: 'resource',
        selector: first.resultSelector,
        label,
      },
      symbolNames: [],
    };
    targets.push(target);
    for (const binding of group) {
      aggregated.add(binding);
      attachFactoryResultSymbols(symbols, target, binding);
    }
  }

  for (const binding of bindings) {
    if (aggregated.has(binding)) continue;
    const kind = isPipelineRole(binding.role)
      ? binding.role
      : 'resource';
    let target = targets.find((candidate) =>
      'selector' in candidate.selector &&
      candidate.selector.selector === binding.selector &&
      candidate.selector.kind === kind
    );
    if (!target) {
      const label = `${binding.factoryName} → ${binding.selector}`;
      target = {
        id: `factory-result:${binding.factoryName}:${binding.selector}`,
        label,
        selector: {
          kind,
          selector: binding.selector,
          label,
        },
        symbolNames: [],
        ...(binding.pipelineSource
          ? { pipelineSource: clonePipelineSource(binding.pipelineSource) }
          : {}),
      };
      targets.push(target);
    } else if (!target.pipelineSource && binding.pipelineSource) {
      target.pipelineSource = clonePipelineSource(binding.pipelineSource);
    }

    attachFactoryResultSymbols(symbols, target, binding);
    attachPipelineSourceSymbols(symbols, target, binding.pipelineSource);
  }
}

function attachFactoryResultSymbols(
  symbols: DiscoveredSymbol[],
  target: InspectionTarget,
  binding: FactoryResultBinding,
): void {
  for (const name of [binding.factoryName, binding.resultName]) {
    if (!target.symbolNames.includes(name)) target.symbolNames.push(name);
    const symbol = symbols.find((candidate) => candidate.name === name);
    if (symbol && !symbol.targetIds.includes(target.id)) {
      symbol.targetIds.push(target.id);
    }
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

function isFactoryRole(role: TypeGpuRole): boolean {
  return role === 'pipeline-factory' || role === 'resource-factory';
}

function isPipelineRole(
  role: TypeGpuRole,
): role is 'compute-pipeline' | 'render-pipeline' {
  return role === 'compute-pipeline' || role === 'render-pipeline';
}

function isInspectableFactoryOutputRole(role: TypeGpuRole): boolean {
  return isPipelineRole(role) || new Set<TypeGpuRole>([
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
  ]).has(role);
}

function prefixFactoryOutputs(
  prefix: string,
  outputs: FactoryOutput[],
): FactoryOutput[] {
  return outputs.map((output) => ({
    ...output,
    path: [prefix, ...output.path],
  }));
}

function intersectFactoryOutputs(
  left: FactoryOutput[],
  right: FactoryOutput[],
): FactoryOutput[] {
  const rightKeys = new Set(right.map(factoryOutputEntryKey));
  return left
    .filter((output) => rightKeys.has(factoryOutputEntryKey(output)))
    .map(cloneFactoryOutput);
}

function mergeFactoryOutputs(outputs: FactoryOutput[]): FactoryOutput[] {
  const seen = new Set<string>();
  return outputs.filter((output) => {
    const key = factoryOutputEntryKey(output);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeFactoryBindings(
  bindings: FactoryResultBinding[],
): FactoryResultBinding[] {
  const seen = new Set<string>();
  return bindings.filter((binding) => {
    const key = [
      binding.factoryName,
      binding.selector,
      binding.role,
      binding.resultName,
    ].join(':');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function factoryOutputKey(outputs: FactoryOutput[]): string {
  return outputs.map(factoryOutputEntryKey).sort().join('|');
}

function factoryOutputEntryKey(output: FactoryOutput): string {
  return [
    output.role,
    output.path.join('.'),
    JSON.stringify(output.pipelineSource ?? null),
  ].join(':');
}

function cloneFactoryOutput(output: FactoryOutput): FactoryOutput {
  return {
    role: output.role,
    path: [...output.path],
    ...(output.pipelineSource
      ? { pipelineSource: clonePipelineSource(output.pipelineSource) }
      : {}),
  };
}

function clonePipelineSource(source: PipelineSource): PipelineSource {
  return {
    ...source,
    ...(source.bindings
      ? { bindings: source.bindings.map((binding) => ({ ...binding })) }
      : {}),
  };
}

function staticPropertyKey(expression: ts.Expression): string | undefined {
  const value = unwrap(expression);
  if (ts.isStringLiteral(value) || ts.isNumericLiteral(value)) {
    return value.text;
  }
  return undefined;
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
  return containsUseGpuDirective(node) ? 'shader-helper' : 'unknown';
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
    return roleFromFactoryChain(readCallee(value.tag)) ?? 'unknown';
  }

  if (ts.isCallExpression(value)) {
    const direct = roleFromFactoryChain(readCallee(value.expression));
    if (direct) return direct;
  }

  return 'unknown';
}

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
function isTgpuFactoryCall(callee: string, name: string): boolean {
  const parts = calleeSegments(callee);
  return parts.length === 2 && parts[0] === 'tgpu' && parts[1] === name;
}

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

function expressionSelector(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
): string | undefined {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) return value.text;
  if (ts.isPropertyAccessExpression(value)) {
    return value.getText(sourceFile);
  }
  return undefined;
}

function probeArgumentsFromExpression(
  expression: ts.Expression | undefined,
  sourceFile: ts.SourceFile,
): { probeArguments?: string[] } {
  if (!expression) return {};
  const value = unwrap(expression);
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
    return probeArgumentsFromParameters(
      value.parameters,
      sourceFile,
      new Set(
        value.typeParameters?.map((parameter) => parameter.name.text) ?? [],
      ),
    );
  }
  if (ts.isCallExpression(value)) {
    const isShellCallee = (callee: string | undefined): boolean =>
      callee !== undefined && isTgpuFactoryCall(callee, 'fn');
    const shellCall =
      ts.isCallExpression(value.expression) &&
        isShellCallee(readCallee(value.expression.expression))
        ? value.expression
        : isShellCallee(readCallee(value.expression))
          ? value
          : undefined;
    const argList = shellCall?.arguments[0];
    if (argList && ts.isArrayLiteralExpression(argList)) {
      const selectors = argList.elements
        .map((element) =>
          ts.isSpreadElement(element)
            ? undefined
            : schemaSelectorFromExpression(element, sourceFile))
        .filter((selector): selector is string => selector !== undefined);
      return selectors.length === argList.elements.length && selectors.length > 0
        ? { probeArguments: selectors }
        : {};
    }
  }
  return {};
}

function discoverZeroAccessorBindingsByHelper(
  sourceFile: ts.SourceFile,
): Map<string, ProbeBinding[]> {
  const accessors = new Map<string, ProbeBinding>();
  const helpers = new Map<string, ts.Node>();

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      if (inferFunctionRole(statement) === 'shader-helper') {
        helpers.set(statement.name.text, statement);
      }
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const value = unwrap(declaration.initializer);
        const accessorCallee = ts.isCallExpression(value)
          ? readCallee(value.expression)
          : undefined;
        if (
          ts.isCallExpression(value) &&
          accessorCallee !== undefined &&
          isTgpuFactoryCall(accessorCallee, 'accessor') &&
          value.arguments.length === 1
        ) {
          const schema = value.arguments[0] &&
            schemaSelectorFromExpression(value.arguments[0], sourceFile);
          if (schema) {
            accessors.set(declaration.name.text, {
              slot: declaration.name.text,
              schema,
            });
          }
        } else if (inferExpressionRole(value) === 'shader-helper') {
          helpers.set(declaration.name.text, value);
        }
      }
    }
  }

  const result = new Map<string, ProbeBinding[]>();
  for (const helperName of helpers.keys()) {
    const queue = [helperName];
    const visited = new Set<string>();
    const bindings = new Map<string, ProbeBinding>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const node = helpers.get(current);
      if (!node) continue;

      walkIdentifiers(node, (identifier) => {
        const accessor = accessors.get(identifier);
        if (accessor) bindings.set(identifier, accessor);
        if (helpers.has(identifier) && !visited.has(identifier)) {
          queue.push(identifier);
        }
      });
    }

    if (bindings.size > 0) {
      result.set(helperName, [...bindings.values()]);
    }
  }
  return result;
}

function walkIdentifiers(node: ts.Node, visit: (identifier: string) => void): void {
  if (ts.isIdentifier(node)) visit(node.text);
  node.forEachChild((child) => walkIdentifiers(child, visit));
}

function probeArgumentsFromParameters(
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
  sourceFile: ts.SourceFile,
  typeParameterNames: ReadonlySet<string> = new Set(),
): { probeArguments?: string[] } {
  if (parameters.length === 0) return {};
  const selectors = parameters.map((parameter) =>
    schemaSelectorFromType(parameter.type, sourceFile, typeParameterNames));
  return selectors.every((selector): selector is string => selector !== undefined)
    ? { probeArguments: selectors }
    : {};
}

function discoverContextualProbeInputs(
  sourceFile: ts.SourceFile,
): Map<
  string,
  {
    probeArguments?: string[];
    probeArgumentPlan?: ProbeArgumentPlanEntry[];
    probeSpecializations?: ProbeSpecialization[];
    specializationSynthesis?: SpecializationSynthesis;
  }
> {
  type Helper = {
    body: ts.ConciseBody;
    parameters: ts.NodeArray<ts.ParameterDeclaration>;
    typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> | undefined;
  };

  const helpers = new Map<string, Helper>();
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      statement.body &&
      inferFunctionRole(statement) === 'shader-helper'
    ) {
      helpers.set(statement.name.text, {
        body: statement.body,
        parameters: statement.parameters,
        typeParameters: statement.typeParameters,
      });
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const value = unwrap(declaration.initializer);
      if (
        (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) &&
        inferFunctionRole(value) === 'shader-helper'
      ) {
        helpers.set(declaration.name.text, {
          body: value.body,
          parameters: value.parameters,
          typeParameters: value.typeParameters,
        });
      }
    }
  }

  const selectors = new Map<string, Array<string | undefined>>();
  for (const [name, helper] of helpers) {
    const typeParameterNames = new Set(
      helper.typeParameters?.map((parameter) => parameter.name.text) ?? [],
    );
    selectors.set(
      name,
      helper.parameters.map((parameter) =>
        schemaSelectorFromType(parameter.type, sourceFile, typeParameterNames)),
    );
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, helper] of helpers) {
      const helperSelectors = selectors.get(name)!;
      const numericAliases = collectNumericAliases(helper.body);
      for (const [index, parameter] of helper.parameters.entries()) {
        if (
          helperSelectors[index] !== 'ctx.d.f32' ||
          !ts.isIdentifier(parameter.name)
        ) {
          continue;
        }
        const inferred = inferNumberParameterSchema(
          helper.body,
          parameter.name.text,
          selectors,
          numericAliases,
        );
        if (inferred) {
          helperSelectors[index] = inferred;
          changed = true;
        }
      }
    }
  }

  const callSiteValues = discoverCallSiteArgumentValues(sourceFile, helpers);
  const result = new Map<
    string,
    {
      probeArguments?: string[];
      probeArgumentPlan?: ProbeArgumentPlanEntry[];
      probeSpecializations?: ProbeSpecialization[];
      specializationSynthesis?: SpecializationSynthesis;
    }
  >();

  for (const [name, helper] of helpers) {
    const synthesis = synthesizeProbeSpecializations(helper, sourceFile);
    if (synthesis) {
      if (synthesis.specializations.length === 1 && !synthesis.truncated) {
        result.set(name, {
          probeArguments: synthesis.specializations[0]!.probeArguments,
        });
      } else {
        result.set(name, {
          probeSpecializations: synthesis.specializations,
          specializationSynthesis: {
            emitted: synthesis.specializations.length,
            limit: MAX_SYNTHESIZED_SPECIALIZATIONS,
            truncated: synthesis.truncated,
          },
        });
      }
      continue;
    }

    const helperSelectors = selectors.get(name)!;
    const refParameterIndexes = new Set(
      helper.parameters.flatMap((parameter, index) =>
        isNumberRefType(parameter.type, sourceFile) ? [index] : []
      ),
    );
    if (
      helperSelectors.length > 0 &&
      refParameterIndexes.size === 0 &&
      helperSelectors.every(
        (selector): selector is string => selector !== undefined,
      )
    ) {
      result.set(name, { probeArguments: helperSelectors });
      continue;
    }

    const values = callSiteValues.get(name);
    const plan = helper.parameters.map((parameter, index) => {
      const schema = helperSelectors[index];
      if (schema && refParameterIndexes.has(index)) {
        return { refSchema: schema } satisfies ProbeArgumentPlanEntry;
      }
      if (schema) return { schema } satisfies ProbeArgumentPlanEntry;
      const value = values?.[index];
      if (value && isGpuResourceType(parameter.type, sourceFile)) {
        return { value } satisfies ProbeArgumentPlanEntry;
      }
      return undefined;
    });
    if (
      plan.length > 0 &&
      plan.every(
        (entry): entry is ProbeArgumentPlanEntry => entry !== undefined,
      )
    ) {
      result.set(name, { probeArgumentPlan: plan });
    }
  }

  return result;
}

function inferNumberParameterSchema(
  node: ts.Node,
  parameterName: string,
  helperSelectors: Map<string, Array<string | undefined>>,
  aliases: Map<string, ts.Expression>,
): 'ctx.d.i32' | 'ctx.d.u32' | undefined {
  if (
    ts.isBinaryExpression(node) &&
    isBitwiseOperator(node.operatorToken.kind) &&
    (containsParameterReference(node.left, parameterName, aliases) ||
      containsParameterReference(node.right, parameterName, aliases))
  ) {
    return 'ctx.d.u32';
  }

  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    isParameterReference(node.argumentExpression, parameterName)
  ) {
    return 'ctx.d.i32';
  }

  if (ts.isCallExpression(node)) {
    const callee = readCallee(node.expression);
    const short = callee?.split('.').at(-1);
    if (
      (short === 'u32' || short === 'i32') &&
      node.arguments.some((argument) => containsParameterReference(argument, parameterName, aliases))
    ) {
      return short === 'u32' ? 'ctx.d.u32' : 'ctx.d.i32';
    }
    const integerArgument =
      short === 'textureSampleLevel' &&
        node.arguments.length >= 5 &&
        isClearlyScalarExpression(node.arguments[4]!)
        ? node.arguments[3]
        : short === 'textureSample' && node.arguments.length >= 4
        ? node.arguments[3]
        : short === 'textureLoad' && node.arguments.length >= 4
        ? node.arguments[2]
        : undefined;
    if (
      integerArgument &&
      isParameterReference(integerArgument, parameterName)
    ) {
      return 'ctx.d.i32';
    }

    const calledHelper = callee && helperSelectors.get(callee);
    if (calledHelper) {
      for (const [index, argument] of node.arguments.entries()) {
        const calledSchema = calledHelper[index];
        if (
          (calledSchema === 'ctx.d.i32' || calledSchema === 'ctx.d.u32') &&
          isParameterReference(argument, parameterName)
        ) {
          return calledSchema;
        }
      }
    }
  }

  let inferred: 'ctx.d.i32' | 'ctx.d.u32' | undefined;
  ts.forEachChild(node, (child) => {
    if (!inferred) {
      inferred = inferNumberParameterSchema(child, parameterName, helperSelectors, aliases);
    }
  });
  return inferred;
}

function isBitwiseOperator(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.AmpersandToken ||
    kind === ts.SyntaxKind.BarToken ||
    kind === ts.SyntaxKind.CaretToken ||
    kind === ts.SyntaxKind.LessThanLessThanToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken;
}

function containsParameterReference(
  node: ts.Node,
  parameterName: string,
  aliases: Map<string, ts.Expression>,
  seen = new Set<string>(),
): boolean {
  if (ts.isIdentifier(node)) {
    if (node.text === parameterName) return true;
    const initializer = aliases.get(node.text);
    if (initializer && !seen.has(node.text)) {
      seen.add(node.text);
      if (containsParameterReference(initializer, parameterName, aliases, seen)) return true;
    }
  }
  return ts.forEachChild(node, (child) =>
    containsParameterReference(child, parameterName, aliases, seen) || undefined
  ) ?? false;
}

function collectNumericAliases(body: ts.ConciseBody): Map<string, ts.Expression> {
  const aliases = new Map<string, ts.Expression>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      aliases.set(node.name.text, node.initializer);
    }
    node.forEachChild(visit);
  };
  visit(body);
  return aliases;
}

function isNumberRefType(
  type: ts.TypeNode | undefined,
  sourceFile: ts.SourceFile,
): boolean {
  if (!type) return false;
  return /^(?:d\.)?ref<number>$/.test(type.getText(sourceFile).replace(/\s+/g, ''));
}

function discoverCallSiteArgumentValues(
  sourceFile: ts.SourceFile,
  helpers: Map<
    string,
    {
      body: ts.ConciseBody;
      parameters: ts.NodeArray<ts.ParameterDeclaration>;
    }
  >,
): Map<string, Array<string | undefined>> {
  const values = new Map<string, Array<string | undefined>>();
  const topLevelNames = collectTopLevelRuntimeNames(sourceFile);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const helperName = readCallee(node.expression);
      if (helperName) {
        const helper = helpers.get(helperName);
        if (helper) {
          const current =
            values.get(helperName) ??
            new Array<string | undefined>(helper.parameters.length);
          for (const [index, argument] of node.arguments.entries()) {
            if (index >= helper.parameters.length || current[index]) continue;
            const selector = expressionSelector(argument, sourceFile);
            const root = selector?.split('.')[0];
            if (root && topLevelNames.has(root)) {
              current[index] = selector;
            }
          }
          values.set(helperName, current);
        }
      }
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return values;
}

function collectTopLevelRuntimeNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      names.add(statement.name.text);
    } else if (ts.isImportDeclaration(statement) && statement.importClause) {
      const clause = statement.importClause;
      if (clause.name && !clause.isTypeOnly) names.add(clause.name.text);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        names.add(bindings.name.text);
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (!element.isTypeOnly) names.add(element.name.text);
        }
      }
    }
  }
  return names;
}

function isGpuResourceType(
  type: ts.TypeNode | undefined,
  sourceFile: ts.SourceFile,
): boolean {
  if (!type) return false;
  const text = type.getText(sourceFile).replace(/\s+/g, '');
  return /^(?:d\.)?(?:sampler|comparisonSampler|texture(?:Storage|Depth|Multisampled|External)?[A-Za-z0-9]*)(?:<.*>)?$/.test(
    text,
  );
}

function isClearlyScalarExpression(expression: ts.Expression): boolean {
  const value = unwrap(expression);
  if (ts.isNumericLiteral(value)) return true;
  if (
    ts.isPrefixUnaryExpression(value) &&
    (value.operator === ts.SyntaxKind.PlusToken ||
      value.operator === ts.SyntaxKind.MinusToken) &&
    ts.isNumericLiteral(value.operand)
  ) {
    return true;
  }
  if (!ts.isCallExpression(value)) return false;
  const callee = readCallee(value.expression)?.split('.').at(-1);
  return callee === 'f32' || callee === 'i32' || callee === 'u32';
}

function isParameterReference(
  expression: ts.Expression,
  parameterName: string,
): boolean {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) return value.text === parameterName;
  return ts.isPropertyAccessExpression(value) &&
    value.name.text === '$' &&
    ts.isIdentifier(value.expression) &&
    value.expression.text === parameterName;
}

function synthesizeProbeSpecializations(
  helper: {
    parameters: ts.NodeArray<ts.ParameterDeclaration>;
    typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> | undefined;
  },
  sourceFile: ts.SourceFile,
): {
  specializations: ProbeSpecialization[];
  truncated: boolean;
} | undefined {
  if (helper.parameters.length === 0) return undefined;

  const typeParameters = helper.typeParameters ?? [];
  const typeParameterNames = new Set(
    typeParameters.map((parameter) => parameter.name.text),
  );
  const typeParameterChoices = new Map<string, string[]>();
  let isPolymorphic = typeParameters.length > 0;

  for (const parameter of typeParameters) {
    const choices = schemaAlternativesFromType(
      parameter.constraint,
      sourceFile,
      typeParameterNames,
    );
    if (!choices?.length) return undefined;
    if (choices.length > 1) isPolymorphic = true;
    typeParameterChoices.set(parameter.name.text, choices);
  }

  const specializations: ProbeSpecialization[] = [];
  const seen = new Set<string>();
  let truncated = false;

  const addArguments = (probeArguments: string[]): void => {
    const key = probeArguments.join('\u0000');
    if (seen.has(key)) return;
    seen.add(key);
    if (specializations.length >= MAX_SYNTHESIZED_SPECIALIZATIONS) {
      truncated = true;
      return;
    }
    specializations.push({
      probeArguments,
      signature: probeArguments.map(probeSchemaDisplayName).join(', '),
    });
  };

  const expandParameters = (
    substitution: ReadonlyMap<string, string>,
  ): void => {
    const choices = helper.parameters.map((parameter) =>
      schemaAlternativesFromType(
        parameter.type,
        sourceFile,
        typeParameterNames,
        substitution,
      ));
    if (choices.some((alternatives) => !alternatives?.length)) return;
    if (choices.some((alternatives) => alternatives!.length > 1)) {
      isPolymorphic = true;
    }

    const args: string[] = [];
    const visit = (index: number): void => {
      if (truncated) return;
      if (index === choices.length) {
        addArguments([...args]);
        return;
      }
      for (const choice of choices[index]!) {
        args.push(choice);
        visit(index + 1);
        args.pop();
        if (truncated) return;
      }
    };
    visit(0);
  };

  const substitution = new Map<string, string>();
  const visitTypeParameters = (index: number): void => {
    if (truncated) return;
    if (index === typeParameters.length) {
      expandParameters(substitution);
      return;
    }
    const name = typeParameters[index]!.name.text;
    for (const choice of typeParameterChoices.get(name) ?? []) {
      substitution.set(name, choice);
      visitTypeParameters(index + 1);
      if (truncated) return;
    }
    substitution.delete(name);
  };

  visitTypeParameters(0);
  return isPolymorphic && specializations.length > 0
    ? { specializations, truncated }
    : undefined;
}

function schemaAlternativesFromType(
  type: ts.TypeNode | undefined,
  sourceFile: ts.SourceFile,
  typeParameterNames: ReadonlySet<string>,
  substitution: ReadonlyMap<string, string> = new Map(),
): string[] | undefined {
  if (!type) return undefined;
  if (ts.isParenthesizedTypeNode(type)) {
    return schemaAlternativesFromType(
      type.type,
      sourceFile,
      typeParameterNames,
      substitution,
    );
  }
  if (
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    typeParameterNames.has(type.typeName.text)
  ) {
    const selected = substitution.get(type.typeName.text);
    return selected ? [selected] : undefined;
  }
  if (ts.isUnionTypeNode(type)) {
    const members = type.types.map((member) =>
      schemaAlternativesFromType(
        member,
        sourceFile,
        typeParameterNames,
        substitution,
      ));
    if (members.some((alternatives) => !alternatives?.length)) return undefined;
    const alternatives = members.flatMap((member) => member!);
    return alternatives.length > 0 ? [...new Set(alternatives)] : undefined;
  }
  const selector = schemaSelectorFromType(type, sourceFile, typeParameterNames);
  return selector ? [selector] : undefined;
}

function probeSchemaDisplayName(selector: string): string {
  return selector.replace(/^(?:ctx\.d\.|module\.)/, '');
}

function schemaSelectorFromType(
  type: ts.TypeNode | undefined,
  sourceFile: ts.SourceFile,
  typeParameterNames: ReadonlySet<string> = new Set(),
): string | undefined {
  if (!type) return undefined;
  if (isNumberRefType(type, sourceFile)) return 'ctx.d.f32';
  if (type.kind === ts.SyntaxKind.NumberKeyword) return 'ctx.d.f32';
  if (type.kind === ts.SyntaxKind.BooleanKeyword) return 'ctx.d.bool';

  const text = type.getText(sourceFile).replace(/\s+/g, '');
  const scalarOrVector = /^(?:d\.)?([fiu](?:16|32)|bool|v[234][fhiu]|m[234]x[234][fh])$/.exec(
    text,
  );
  if (scalarOrVector) {
    return `ctx.d.${runtimeSchemaName(scalarOrVector[1]!)}`;
  }

  const infer = /^(?:d\.)?Infer(?:GPU)?<typeof([A-Za-z_$][\w$]*)>$/.exec(text);
  if (infer) return `module.${infer[1]}`;

  if (/^[A-Za-z_$][\w$]*$/.test(text)) {
    return typeParameterNames.has(text) ? undefined : `module.${text}`;
  }
  return undefined;
}

function schemaSelectorFromExpression(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
): string | undefined {
  const text = expression.getText(sourceFile).replace(/\s+/g, '');
  if (/^d\.[A-Za-z_$][\w$]*$/.test(text)) {
    return `ctx.${text}`;
  }
  if (/^[A-Za-z_$][\w$]*$/.test(text)) return `module.${text}`;
  return undefined;
}

function runtimeSchemaName(typeName: string): string {
  if (/^v[234][fhiu]$/.test(typeName)) return `vec${typeName.slice(1)}`;
  if (/^m[234]x[234][fh]$/.test(typeName)) return `mat${typeName.slice(1)}`;
  return typeName;
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

function readCallee(expression: ts.Expression): string | undefined {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) return value.text;
  if (ts.isTaggedTemplateExpression(value)) return readCallee(value.tag);
  if (ts.isPropertyAccessExpression(value)) {
    const left = readCallee(value.expression);
    return left ? `${left}.${value.name.text}` : value.name.text;
  }
  // Bracket namespaces (`root['~unstable'].createRenderPipeline`) must keep the
  // dotted shape so suffix matching still recognizes the constructor.
  if (ts.isElementAccessExpression(value)) {
    const left = readCallee(value.expression);
    const segment = (value.argumentExpression &&
      staticPropertyKey(value.argumentExpression)) ?? '?';
    return left ? `${left}.${segment}` : segment;
  }
  if (ts.isCallExpression(value)) return readCallee(value.expression);
  return undefined;
}

/**
 * Drops bracket-namespace segments (`~unstable`) so factory chains read the
 * same whether they were authored as `tgpu.fn` or `tgpu['~unstable'].fn`.
 */
function calleeSegments(callee: string): string[] {
  return callee.split('.').filter((part) => !part.startsWith('~'));
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
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
