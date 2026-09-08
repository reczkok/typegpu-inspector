import ts from 'typescript';
import { sourceBindings, unwrap } from './shaderSyntax.js';
import type { DiscoveredSymbol, InspectionTarget } from './discovery.js';

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

export function attachFactoryResults(symbols: DiscoveredSymbol[], targets: InspectionTarget[], results: Results): void {
  for (const symbol of symbols) {
    const selector = symbol.runtimeName ?? symbol.name;
    const factories = results.get(selector);
    if (!factories) continue;
    const id = `factory-result:${symbol.name}`;
    const label = `${factories.join(', ')} → ${symbol.name}`;
    const names = [...new Set([symbol.name, ...factories])];
    targets.push({ id, label, symbolNames: names, selector: { selector, inspectMembers: true, kind: 'resolvable', label } });
    for (const candidate of symbols) if (names.includes(candidate.name)) candidate.targetIds.push(id);
  }
}
