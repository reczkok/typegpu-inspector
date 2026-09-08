import ts from 'typescript';
import { discoverShaderCallSchemas, type ShaderCallSchemas } from './callerSchemas.js';
import type { DiscoveredSymbol, InspectionTarget, ProbeArgumentPlanEntry, ProbeSpecialization } from './discovery.js';
import { expressionSelector, findFnShell, sourceBindings, isRuntimeBinding, isTgpuFactoryCall, readCallee, unwrap } from './shaderSyntax.js';

export const MAX_SYNTHESIZED_SPECIALIZATIONS = 8;
export type HelperDeclarations = Map<string, ts.Expression | ts.FunctionDeclaration>;
type ProbeInputs = Pick<DiscoveredSymbol, 'probeContext' | 'probeArgumentPlan' | 'probeSpecializations' | 'specializationSynthesis'>;

/** Discovery supplies shader declarations. Planning never discovers or executes factories. */
export function applyHelperPlans(file: ts.SourceFile, declarations: HelperDeclarations, symbols: DiscoveredSymbol[], targets: InspectionTarget[]): void {
  const plans = discoverContextualProbeInputs(file, declarations);
  for (const [name, value] of declarations) {
    if (!plans.has(name)) plans.set(name, ts.isFunctionDeclaration(value)
      ? probeArgumentsFromParameters(value.parameters, file, new Set(value.typeParameters?.map(parameter => parameter.name.text)))
      : probeArgumentsFromExpression(value, file));
  }
  const replacements = new Map<string, InspectionTarget[]>();
  const byId = new Map(targets.map(target => [target.id, target]));
  for (const symbol of symbols) {
    const plan = plans.get(declarations.has(symbol.name) ? symbol.name : symbol.runtimeName ?? symbol.name);
    if (!plan) continue;
    Object.assign(symbol, plan);
    for (const id of symbol.targetIds) {
      const target = byId.get(id);
      if (!target || !target.symbolNames.includes(symbol.name) || !('selector' in target.selector) || target.selector.kind !== 'resolvable') continue;
      if (plan.probeSpecializations?.length) {
        replacements.set(target.id, plan.probeSpecializations.map((variant, index) => {
          const label = `${target.label}(${variant.signature})`;
          return { ...target, id: `${target.id}:specialization:${index}`, label,
            selector: { ...target.selector, label, probeArgumentPlan: variant.probeArgumentPlan, probeContext: variant.probeContext ?? { origin: 'schema' as const } } };
        }));
      } else Object.assign(target.selector, { ...(plan.probeArgumentPlan ? { probeArgumentPlan: plan.probeArgumentPlan } : {}), ...(plan.probeContext ? { probeContext: plan.probeContext } : {}) });
    }
  }
  const expand = (ids: string[]) => ids.flatMap(id => replacements.get(id)?.map(target => target.id) ?? [id]);
  for (const symbol of symbols) symbol.targetIds = expand(symbol.targetIds);
  targets.splice(0, targets.length, ...targets.flatMap(target => replacements.get(target.id) ?? [target]));
}

function probeArgumentsFromExpression(
  expression: ts.Expression | undefined,
  sourceFile: ts.SourceFile,
): ProbeInputs {
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
          : findFnShell(value);
    const argList = shellCall?.arguments[0];
    if (argList && ts.isArrayLiteralExpression(argList)) {
      const selectors = argList.elements
        .map((element) =>
          ts.isSpreadElement(element)
            ? undefined
            : schemaSelectorFromExpression(element, sourceFile))
        .filter((selector): selector is string => selector !== undefined);
      return selectors.length === argList.elements.length && selectors.length > 0
        ? { probeArgumentPlan: selectors.map(schema => ({ schema })), probeContext: { origin: 'schema' } }
        : {};
    }
  }
  return {};
}

function probeArgumentsFromParameters(
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
  sourceFile: ts.SourceFile,
  typeParameterNames: ReadonlySet<string> = new Set(),
): ProbeInputs {
  if (parameters.length === 0) return {};
  const selectors = parameters.map((parameter) =>
    schemaSelectorFromType(parameter.type, sourceFile, typeParameterNames));
  return selectors.every((selector): selector is string => selector !== undefined)
    ? { probeArgumentPlan: selectors.map(schema => ({ schema })), probeContext: { origin: 'schema' } }
    : {};
}

function discoverContextualProbeInputs(
  sourceFile: ts.SourceFile,
  declarations: HelperDeclarations,
): Map<string, ProbeInputs> {
  type Helper = {
    body: ts.ConciseBody;
    symbol?: ts.Symbol | undefined;
    parameters: ts.NodeArray<ts.ParameterDeclaration>;
    typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> | undefined;
  };

  const helpers = new Map<string, Helper>();
  const checker = sourceBindings(sourceFile);
  const moduleBindings = new Map(checker.getSymbolsInScope(sourceFile, ts.SymbolFlags.Value | ts.SymbolFlags.Alias).map(binding => [binding.name, binding]));
  for (const [name, declaration] of declarations) {
    const value = ts.isFunctionDeclaration(declaration) ? declaration : unwrap(declaration);
    if ((ts.isFunctionDeclaration(value) || ts.isArrowFunction(value) || ts.isFunctionExpression(value)) && value.body) {
      const identifier = ts.isFunctionDeclaration(value) ? value.name : ts.isVariableDeclaration(value.parent) ? value.parent.name : undefined;
      helpers.set(name, { symbol: identifier ? checker.getSymbolAtLocation(identifier) : moduleBindings.get(name), body: value.body, parameters: value.parameters, typeParameters: value.typeParameters });
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

  const schemasByBinding = new Map([...helpers].flatMap(([name, helper]) => helper.symbol ? [[helper.symbol, selectors.get(name)!] as const] : []));
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
        const parameterSymbol = sourceBindings(sourceFile).getSymbolAtLocation(parameter.name);
        if (!parameterSymbol) continue;
        const inferred = inferNumberParameterSchema(
          helper.body,
          parameterSymbol,
          schemasByBinding,
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
  const callerSchemas = discoverShaderCallSchemas(sourceFile);
  const result = new Map<string, ProbeInputs>();

  for (const [name, helper] of helpers) {
    if (helper.parameters.length === 0) { result.set(name, {}); continue; }
    const synthesis = synthesizeProbeSpecializations(helper, sourceFile);
    if (synthesis) {
      if (synthesis.specializations.length === 1 && !synthesis.truncated) {
        result.set(name, {
          probeArgumentPlan: synthesis.specializations[0]!.probeArgumentPlan,
          probeContext: { origin: 'schema' },
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
    const callerPlan = numericCallerPlan(helper.parameters, helperSelectors, helper.symbol ? callerSchemas.get(helper.symbol) ?? [] : []);
    if (callerPlan) { result.set(name, callerPlan); continue; }
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
      result.set(name, { probeArgumentPlan: helperSelectors.map(schema => ({ schema })), probeContext: { origin: 'schema' } });
      continue;
    }

    const makePlan = (values: Array<string | undefined> = []) => helper.parameters.map((parameter, index) => {
      const schema = helperSelectors[index];
      if (schema) return refParameterIndexes.has(index) ? { refSchema: schema } : { schema };
      const value = values[index];
      return value && isGpuResourceType(parameter.type, sourceFile) ? { value } : undefined;
    });
    const variants: ProbeSpecialization[] = [];
    const seen = new Set<string>();
    for (const call of callSiteValues.get(name) ?? []) {
      const plan = makePlan(call.values);
      if (!plan.length || !plan.every((entry): entry is ProbeArgumentPlanEntry => entry !== undefined)) continue;
      const key = JSON.stringify(plan);
      if (seen.has(key)) continue;
      seen.add(key);
      variants.push({ probeArgumentPlan: plan, signature: `call ${call.line}:${call.column}`,
        probeContext: { origin: 'call-site', line: call.line, column: call.column } });
      if (variants.length > MAX_SYNTHESIZED_SPECIALIZATIONS) break;
    }
    if (variants.length === 1) {
      const variant = variants[0]!;
      result.set(name, { probeArgumentPlan: variant.probeArgumentPlan, ...(variant.probeContext ? { probeContext: variant.probeContext } : {}) });
    }
    else if (variants.length > 1) result.set(name, {
      probeSpecializations: variants.slice(0, MAX_SYNTHESIZED_SPECIALIZATIONS),
      specializationSynthesis: { emitted: Math.min(variants.length, MAX_SYNTHESIZED_SPECIALIZATIONS),
        limit: MAX_SYNTHESIZED_SPECIALIZATIONS, truncated: variants.length > MAX_SYNTHESIZED_SPECIALIZATIONS },
      probeContext: { origin: 'call-site' },
    });
    else {
      const plan = makePlan();
      if (plan.length && plan.every((entry): entry is ProbeArgumentPlanEntry => entry !== undefined)) {
        result.set(name, { probeArgumentPlan: plan, probeContext: { origin: 'schema' } });
      } else result.set(name, { probeContext: { origin: 'schema', missing: plan.flatMap((entry, index) => entry ? [] : [{
        index, parameter: helper.parameters[index]!.name.getText(sourceFile),
        reason: isGpuResourceType(helper.parameters[index]!.type, sourceFile)
          ? 'No complete call-site resource tuple is available; supply a context argument value.'
          : 'No runtime schema is known; supply a context argument value, schema, or reference schema.',
      }]) } });
    }
  }

  return result;
}

/** Preserve complete caller tuples; unknown calls keep the independent schema probe. */
function numericCallerPlan(parameters: ts.NodeArray<ts.ParameterDeclaration>, defaults: Array<string | undefined>, calls: ShaderCallSchemas[]): ProbeInputs | undefined {
  if (!parameters.some(parameter => parameter.type?.kind === ts.SyntaxKind.NumberKeyword) ||
    !defaults.every((schema): schema is string => schema !== undefined)) return undefined;
  const variants = new Map<string, ProbeSpecialization>();
  let unknown = false;
  for (const call of calls) {
    if (call.schemas.length !== parameters.length || !call.schemas.every((schema, index) => schema &&
      (parameters[index]!.type?.kind === ts.SyntaxKind.NumberKeyword ? /^ctx\.d\.(?:u32|i32|f32|f16)$/.test(schema) : schema === defaults[index]))) {
      unknown = true;
      continue;
    }
    const schemas = call.schemas as string[];
    const key = schemas.join(',');
    if (!variants.has(key)) variants.set(key, {
      probeArgumentPlan: schemas.map(schema => ({ schema })), signature: schemas.map(probeSchemaDisplayName).join(', '),
      probeContext: { origin: 'call-site', line: call.line, column: call.column },
    });
  }
  if (!variants.size) return undefined;
  if (unknown && !variants.has(defaults.join(','))) variants.set(defaults.join(','), {
    probeArgumentPlan: defaults.map(schema => ({ schema })), signature: `${defaults.map(probeSchemaDisplayName).join(', ')} · schema probe`,
    probeContext: { origin: 'schema' },
  });
  const emitted = [...variants.values()].slice(0, MAX_SYNTHESIZED_SPECIALIZATIONS);
  if (variants.size === 1) return { probeArgumentPlan: emitted[0]!.probeArgumentPlan, probeContext: emitted[0]!.probeContext! };
  return {
    probeSpecializations: emitted, probeContext: { origin: 'call-site' },
    specializationSynthesis: { emitted: emitted.length, limit: MAX_SYNTHESIZED_SPECIALIZATIONS, truncated: variants.size > emitted.length },
  };
}

function inferNumberParameterSchema(
  node: ts.Node,
  parameterSymbol: ts.Symbol,
  helperSelectors: Map<ts.Symbol, Array<string | undefined>>,
  aliases: Map<ts.Symbol, ts.Expression>,
): 'ctx.d.i32' | 'ctx.d.u32' | undefined {
  if (
    ts.isBinaryExpression(node) &&
    isBitwiseOperator(node.operatorToken.kind) &&
    (containsParameterReference(node.left, parameterSymbol, aliases) ||
      containsParameterReference(node.right, parameterSymbol, aliases))
  ) {
    return 'ctx.d.u32';
  }

  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    isParameterReference(node.argumentExpression, parameterSymbol)
  ) {
    return 'ctx.d.i32';
  }

  if (ts.isCallExpression(node)) {
    const callee = readCallee(node.expression);
    const short = callee?.split('.').at(-1);
    if (
      (short === 'u32' || short === 'i32') &&
      node.arguments.some((argument) => containsParameterReference(argument, parameterSymbol, aliases))
    ) {
      return short === 'u32' ? 'ctx.d.u32' : 'ctx.d.i32';
    }
    // `std.bitcast(from, to)(value)`: the parameter has the `from` schema.
    const bitcastSource = bitcastSourceSchema(node);
    if (
      bitcastSource &&
      node.arguments.length === 1 &&
      isParameterReference(node.arguments[0]!, parameterSymbol)
    ) {
      return bitcastSource;
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
      isParameterReference(integerArgument, parameterSymbol)
    ) {
      return 'ctx.d.i32';
    }

    const calledSymbol = sourceBindings(node.getSourceFile()).getSymbolAtLocation(node.expression);
    const calledHelper = calledSymbol && helperSelectors.get(calledSymbol);
    if (calledHelper) {
      for (const [index, argument] of node.arguments.entries()) {
        const calledSchema = calledHelper[index];
        if (
          (calledSchema === 'ctx.d.i32' || calledSchema === 'ctx.d.u32') &&
          isParameterReference(argument, parameterSymbol)
        ) {
          return calledSchema;
        }
      }
    }
  }

  let inferred: 'ctx.d.i32' | 'ctx.d.u32' | undefined;
  ts.forEachChild(node, (child) => {
    if (!inferred && !ts.isFunctionLike(child)) {
      inferred = inferNumberParameterSchema(child, parameterSymbol, helperSelectors, aliases);
    }
  });
  return inferred;
}

function bitcastSourceSchema(node: ts.CallExpression): 'ctx.d.i32' | 'ctx.d.u32' | undefined {
  const inner = unwrap(node.expression);
  if (!ts.isCallExpression(inner) || inner.arguments.length !== 2) return undefined;
  if (readCallee(inner.expression)?.split('.').at(-1) !== 'bitcast') return undefined;
  const from = readCallee(inner.arguments[0]!)?.split('.').at(-1);
  return from === 'u32' ? 'ctx.d.u32' : from === 'i32' ? 'ctx.d.i32' : undefined;
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
  parameterSymbol: ts.Symbol,
  aliases: Map<ts.Symbol, ts.Expression>,
  seen = new Set<ts.Symbol>(),
): boolean {
  if (ts.isIdentifier(node)) {
    const symbol = sourceBindings(node.getSourceFile()).getSymbolAtLocation(node);
    if (symbol === parameterSymbol) return true;
    const initializer = symbol && aliases.get(symbol);
    if (symbol && initializer && !seen.has(symbol)) {
      seen.add(symbol);
      if (containsParameterReference(initializer, parameterSymbol, aliases, seen)) return true;
    }
  }
  // A call's result has its own type (`bitcast(f32, u32)(value)` is a u32
  // whatever `value` is), so an operator on it says nothing about the parameter.
  if (ts.isCallExpression(node)) return false;
  return ts.forEachChild(node, (child) =>
    containsParameterReference(child, parameterSymbol, aliases, seen) || undefined
  ) ?? false;
}

function collectNumericAliases(body: ts.ConciseBody): Map<ts.Symbol, ts.Expression> {
  const aliases = new Map<ts.Symbol, ts.Expression>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const symbol = sourceBindings(node.getSourceFile()).getSymbolAtLocation(node.name);
      if (symbol) aliases.set(symbol, node.initializer);
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
  helpers: Map<string, { body: ts.ConciseBody; parameters: ts.NodeArray<ts.ParameterDeclaration> }>,
): Map<string, Array<{ values: Array<string | undefined>; line: number; column: number }>> {
  const values = new Map<string, Array<{ values: Array<string | undefined>; line: number; column: number }>>();
  const checker = sourceBindings(sourceFile);
  const topLevel = new Map(checker.getSymbolsInScope(sourceFile, ts.SymbolFlags.Value | ts.SymbolFlags.Alias)
    .map(symbol => [symbol.name, symbol]));
  const moduleReference = (node: ts.Expression): string | undefined => {
    const selector = expressionSelector(node, sourceFile);
    let root = unwrap(node);
    while (ts.isPropertyAccessExpression(root)) root = unwrap(root.expression);
    if (!ts.isIdentifier(root) || !isRuntimeBinding(checker.getSymbolAtLocation(root))) return undefined;
    return checker.getSymbolAtLocation(root) === topLevel.get(root.text) ? selector : undefined;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      const helper = helpers.get(name);
      if (helper && checker.getSymbolAtLocation(node.expression) === topLevel.get(name)) {
        const calls = values.get(name) ?? [];
        const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        calls.push({ values: helper.parameters.map((_, index) => node.arguments[index] ? moduleReference(node.arguments[index]!) : undefined),
          line: location.line + 1, column: location.character + 1 });
        values.set(name, calls);
      }
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return values;
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
  parameterSymbol: ts.Symbol,
): boolean {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) return sourceBindings(value.getSourceFile()).getSymbolAtLocation(value) === parameterSymbol;
  return ts.isPropertyAccessExpression(value) &&
    value.name.text === '$' &&
    ts.isIdentifier(value.expression) &&
    sourceBindings(value.getSourceFile()).getSymbolAtLocation(value.expression) === parameterSymbol;
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
      probeArgumentPlan: probeArguments.map(schema => ({ schema })),
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

  // A module-rooted selector must name a binding the probe can turn into a
  // value: a variable, or an import (the runtime re-imports a type-only
  // import's value twin). An interface, type alias, class, or global
  // (Float32Array) would reach the probe as undefined or a non-schema callable.
  const infer = /^(?:d\.)?Infer(?:GPU)?<typeof([A-Za-z_$][\w$]*)>$/.exec(text);
  if (infer) {
    return hasRuntimeSchemaReference(type, infer[1]!, sourceFile) ? `module.${infer[1]}` : undefined;
  }

  if (/^[A-Za-z_$][\w$]*$/.test(text)) {
    return !typeParameterNames.has(text) && hasRuntimeSchemaReference(type, text, sourceFile)
      ? `module.${text}`
      : undefined;
  }
  return undefined;
}

function hasRuntimeSchemaReference(type: ts.TypeNode, name: string, file: ts.SourceFile): boolean {
  const checker = sourceBindings(file);
  const visit = (node: ts.Node): boolean =>
    (ts.isIdentifier(node) && node.text === name && isRuntimeBinding(checker.getSymbolAtLocation(node), true)) ||
    (ts.forEachChild(node, child => visit(child) || undefined) ?? false);
  return visit(type);
}

function schemaSelectorFromExpression(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
): string | undefined {
  const text = expression.getText(sourceFile).replace(/\s+/g, '');
  if (/^d\.[A-Za-z_$][\w$]*$/.test(text)) {
    return `ctx.${text}`;
  }
  if (ts.isIdentifier(expression) && isRuntimeBinding(sourceBindings(sourceFile).getSymbolAtLocation(expression), true)) return `module.${text}`;
  return undefined;
}

function runtimeSchemaName(typeName: string): string {
  if (/^v[234][fhiu]$/.test(typeName)) return `vec${typeName.slice(1)}`;
  if (/^m[234]x[234][fh]$/.test(typeName)) return `mat${typeName.slice(1)}`;
  return typeName;
}
