import ts from 'typescript';
import MagicString from 'magic-string';

/** Add access to lexical bindings without changing the module URL or shader bodies. */
export function instrumentSymbols(path: string, source: string, runtimeUrl: string, declarations: readonly number[]) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true,
    /\.[jt]sx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const code = new MagicString(source);
  const requested = new Set(declarations);
  let prefix = '__typegpuInspectorSymbols';
  while (source.includes(prefix)) prefix += '_';
  const scope = (names: Iterable<string>) => `() => ({${[...new Set(names)].map(name =>
    `get ${JSON.stringify(name)}() { return ${name}; }`).join(',')}})`;
  const moduleNames = scopeNames(file);
  code.append(`\n;${prefix}Module(${JSON.stringify(path)}, ${scope(moduleNames)});\n`);
  const registrations = new Map<number, string[]>();
  function insert(at: number, text: string) {
    const lines = registrations.get(at) ?? [];
    lines.push(text);
    registrations.set(at, lines);
  }
  function visit(node: ts.Node, names: string[], insideFunction: boolean, parameters: string[] = []): void {
    if (isGpuFunction(node)) return; // Never inject CPU registration into TGSL.
    let visible = names;
    if (ts.isBlock(node) || ts.isSourceFile(node)) visible = [...names, ...scopeNames(node)];
    if (isFunction(node)) {
      const localParameters = node.parameters.flatMap(p => boundNames(p.name));
      parameters = [...parameters, ...localParameters];
      visible = [...visible, ...localParameters];
      insideFunction = true;
    }
    if ((ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      node.initializer && ts.isVariableDeclarationList(node.initializer)) {
      visible = [...visible, ...node.initializer.declarations.flatMap(d => boundNames(d.name))];
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      visible = [...visible, ...boundNames(node.variableDeclaration.name)];
    }
    if (insideFunction && ts.isVariableStatement(node) && (ts.isBlock(node.parent) || ts.isSourceFile(node.parent))) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer && requested.has(declaration.name.getStart(file))) {
          insert(node.end, `;${prefix}Instance(${JSON.stringify(path)}, ${declaration.name.getStart(file)}, ${declaration.name.text}, ${scope(visible)}, ${JSON.stringify([...new Set(parameters)])});`);
        }
      }
    }
    // Register hoisted declarations at block entry, before a possible early return.
    if (ts.isBlock(node)) {
      for (const statement of node.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name && requested.has(statement.name.getStart(file))) {
          insert(directiveEnd(node), `;${prefix}Instance(${JSON.stringify(path)}, ${statement.name.getStart(file)}, ${statement.name.text}, ${scope(visible)}, ${JSON.stringify([...new Set(parameters)])});`);
        }
      }
    }
    node.forEachChild(child => visit(child, visible, insideFunction, parameters));
  }
  if (requested.size > 0) visit(file, [], false);
  for (const [at, lines] of registrations) code.appendLeft(at, lines.join('\n'));
  // Imports may follow a directive prologue; preserving the prologue matters to transforms.
  let importAt = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0;
  for (const statement of file.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    importAt = statement.end;
  }
  code.appendLeft(importAt, `\nimport { registerModule as ${prefix}Module, registerInstance as ${prefix}Instance } from ${JSON.stringify(runtimeUrl)};\n`);
  return { code: code.toString(), map: code.generateMap({ hires: true, source: path, includeContent: true }) };
}

function boundNames(name: ts.BindingName): string[] {
  return ts.isIdentifier(name) ? [name.text] : name.elements.flatMap(e => ts.isBindingElement(e) ? boundNames(e.name) : []);
}

function scopeNames(node: ts.SourceFile | ts.Block): string[] {
  return node.statements.flatMap(statement => {
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.flatMap(d => boundNames(d.name));
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) return [statement.name.text];
    if (ts.isImportDeclaration(statement) && statement.importClause && !statement.importClause.isTypeOnly) {
      const clause = statement.importClause;
      const bindings = clause.namedBindings;
      return [...(clause.name ? [clause.name.text] : []), ...(bindings
        ? ts.isNamespaceImport(bindings) ? [bindings.name.text] : bindings.elements.filter(e => !e.isTypeOnly).map(e => e.name.text) : [])];
    }
    return [];
  });
}

function isFunction(node: ts.Node): node is ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
}

function isGpuFunction(node: ts.Node): boolean {
  if (!isFunction(node) || !node.body || !ts.isBlock(node.body)) return false;
  for (const statement of node.body.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    if (statement.expression.text === 'use gpu') return true;
  }
  return false;
}

function directiveEnd(block: ts.Block): number {
  let end = block.getStart() + 1;
  for (const statement of block.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    end = statement.end;
  }
  return end;
}
