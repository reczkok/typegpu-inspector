import ts from 'typescript';
import { hasOwnUseGpuDirective, isRuntimeBinding, sourceBindings, unwrap } from './shaderSyntax.js';
import type { DiscoveredSymbol, InspectionTarget } from './discovery.js';
import type { HelperDeclarations } from './helperPlanning.js';

type Results = Map<string, string[]>;

/** Locate existing call results and aliases. Never inspect a factory's return shape. */
export function discoverFactoryResults(file: ts.SourceFile, isFactory: (fn: ts.FunctionLikeDeclaration) => boolean): Results {
  const checker = sourceBindings(file);
  const factories = new Map<ts.Symbol, string>();
  const results: Results = new Map();
  const bindings = (name: ts.BindingName): ts.Identifier[] => ts.isIdentifier(name) ? [name]
    : name.elements.flatMap(element => ts.isBindingElement(element) ? bindings(element.name) : []);
  for (const statement of file.statements) {
    const declarations = ts.isVariableStatement(statement) ? statement.declarationList.declarations : [statement];
    for (const declaration of declarations) {
      const value = ts.isVariableDeclaration(declaration) && declaration.initializer ? unwrap(declaration.initializer) : declaration;
      const name = (ts.isFunctionDeclaration(declaration) || ts.isVariableDeclaration(declaration)) ? declaration.name : undefined;
      if (!name || !ts.isIdentifier(name) || !(ts.isFunctionDeclaration(value) || ts.isFunctionExpression(value) || ts.isArrowFunction(value)) || !isFactory(value)) continue;
      const symbol = checker.getSymbolAtLocation(name);
      if (symbol) factories.set(symbol, name.text);
    }
  }
  // Aliases refer to the same declaration; bounded by the number of local declarations.
  const factoryName = (node: ts.Expression): string | undefined => {
    let current = unwrap(node);
    const seen = new Set<ts.Symbol>();
    while (ts.isIdentifier(current)) {
      const symbol = checker.getSymbolAtLocation(current);
      if (!symbol || seen.has(symbol)) return undefined;
      if (factories.has(symbol)) return factories.get(symbol);
      seen.add(symbol);
      const declaration = symbol.valueDeclaration;
      if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return undefined;
      current = unwrap(declaration.initializer);
    }
    return undefined;
  };
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!declaration.initializer) continue;
      const found = new Set<string>();
      const visit = (node: ts.Node) => {
        if (ts.isFunctionLike(node)) return;
        if (ts.isCallExpression(node)) {
          const name = factoryName(node.expression);
          if (name) found.add(name);
        }
        if (ts.isIdentifier(node)) {
          const symbol = checker.getSymbolAtLocation(node);
          const definition = symbol?.valueDeclaration;
          if (definition && ts.isVariableDeclaration(definition) && definition.parent.parent.parent === file) {
            for (const name of results.get(node.text) ?? []) found.add(name);
          }
        }
        node.forEachChild(visit);
      };
      visit(declaration.initializer);
      if (found.size) for (const name of bindings(declaration.name)) results.set(name.text, [...found]);
    }
  }
  return results;
}

export function attachFactoryResults(file: ts.SourceFile, symbols: DiscoveredSymbol[], targets: InspectionTarget[], results: Results, helpers: HelperDeclarations): void {
  const checker = sourceBindings(file);
  const moduleBindings = new Map(checker.getSymbolsInScope(file, ts.SymbolFlags.Value | ts.SymbolFlags.Alias).map(binding => [binding.name, binding]));
  for (const symbol of symbols) {
    const selector = symbol.runtimeName ?? symbol.name;
    const factories = results.get(selector);
    if (!factories) continue;
    let rootHelper = false;
    const binding = moduleBindings.get(selector);
    const declaration = binding?.valueDeclaration;
    if (declaration) {
      const type = checker.getTypeAtLocation(declaration);
      const signatures = type.getCallSignatures();
      const callable = !type.isUnionOrIntersection() && signatures.length === 1 ? signatures[0]!.getDeclaration() : undefined;
      if (callable && (ts.isArrowFunction(callable) || ts.isFunctionExpression(callable) || ts.isFunctionDeclaration(callable)) &&
        hasOwnUseGpuDirective(callable) && isUnconditionalReturn(callable) && callable.parameters.every(parameter => !parameter.type || moduleSchemaReferences(parameter.type, checker, moduleBindings))) {
        helpers.set(selector, callable);
        rootHelper = true;
      }
    }
    const id = `factory-result:${symbol.name}`;
    const label = `${factories.join(', ')} → ${symbol.name}`;
    const names = [...new Set([symbol.name, ...factories])];
    targets.push({ id, label, symbolNames: names, selector: { selector, inspectMembers: true, ...(rootHelper ? { member: [] } : {}), kind: 'resolvable', label } });
    for (const candidate of symbols) if (names.includes(candidate.name)) candidate.targetIds.push(id);
  }
}

/** Returned closures keep their values, but only module bindings are addressable by schema probes. */
function moduleSchemaReferences(node: ts.Node, checker: ts.TypeChecker, bindings: Map<string, ts.Symbol>): boolean {
  if (ts.isIdentifier(node)) {
    const binding = checker.getSymbolAtLocation(node);
    if (isRuntimeBinding(binding, true) && binding !== bindings.get(node.text)) return false;
  }
  return !ts.forEachChild(node, child => !moduleSchemaReferences(child, checker, bindings) || undefined);
}

/** Source-only typing can collapse unresolved branch types to any; require one authored return. */
function isUnconditionalReturn(callable: ts.FunctionExpression | ts.ArrowFunction | ts.FunctionDeclaration): boolean {
  let value: ts.Node = callable;
  while (ts.isExpression(value.parent) && unwrap(value.parent) === callable) value = value.parent;
  const parent = value.parent;
  if (ts.isArrowFunction(parent) && parent.body === value) return true;
  if (!ts.isReturnStatement(parent) || !ts.isBlock(parent.parent) || !ts.isFunctionLike(parent.parent.parent)) return false;
  const body = parent.parent;
  if (body.statements.at(-1) !== parent) return false;
  let returns = 0;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) returns++;
    node.forEachChild(visit);
  };
  visit(body);
  return returns === 1;
}
