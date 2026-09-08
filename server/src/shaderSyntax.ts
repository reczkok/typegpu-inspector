import ts from 'typescript';

export function staticPropertyKey(expression: ts.Expression): string | undefined {
  const value = unwrap(expression);
  if (ts.isStringLiteral(value) || ts.isNumericLiteral(value)) {
    return value.text;
  }
  return undefined;
}

export function isFnShellCall(value: ts.CallExpression): boolean {
  const callee = unwrap(value.expression);
  if (ts.isCallExpression(callee)) return false;
  const name = readCallee(callee);
  return name !== undefined && isTgpuFactoryCall(name, 'fn');
}

/** `shell(impl)` or `shell\`...\`` where `shell` is a top-level `tgpu.fn(...)` shell. */
export function isFnShellApplication(
  value: ts.CallExpression | ts.TaggedTemplateExpression,
): boolean {
  return findFnShell(value) !== undefined;
}

/** Resolve a shell's declaration through lexical binding identity, including nested scopes. */
export function findFnShell(value: ts.CallExpression | ts.TaggedTemplateExpression): ts.CallExpression | undefined {
  const callee = unwrap(ts.isCallExpression(value) ? value.expression : value.tag);
  if (!ts.isIdentifier(callee)) return undefined;
  const symbol = sourceBindings(value.getSourceFile()).getSymbolAtLocation(callee);
  const declaration = symbol?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return undefined;
  const initializer = unwrap(declaration.initializer);
  return ts.isCallExpression(initializer) && isFnShellCall(initializer) ? initializer : undefined;
}

export function isTgpuFactoryCall(callee: string, name: string): boolean {
  const parts = calleeSegments(callee);
  return parts.length === 2 && parts[0] === 'tgpu' && parts[1] === name;
}

export function readCallee(expression: ts.Expression): string | undefined {
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
export function calleeSegments(callee: string): string[] {
  return callee.split('.').filter((part) => !part.startsWith('~'));
}

export function unwrap(expression: ts.Expression): ts.Expression {
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

export function hasOwnUseGpuDirective(node: ts.FunctionLikeDeclaration): boolean {
  const body = node.body;
  if (!body || !ts.isBlock(body)) return false;
  for (const statement of body.statements) {
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isStringLiteral(statement.expression)
    ) {
      return false;
    }
    if (statement.expression.text === 'use gpu') return true;
  }
  return false;
}

export function expressionSelector(
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


const bindingCheckers = new WeakMap<ts.SourceFile, ts.TypeChecker>();

/** Bind this AST only: no dependency resolution, type checking, or source execution. */
export function sourceBindings(file: ts.SourceFile): ts.TypeChecker {
  const cached = bindingCheckers.get(file);
  if (cached) return cached;
  const options = { noLib: true, noResolve: true, allowJs: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = name => name === file.fileName ? file : undefined;
  const checker = ts.createProgram([file.fileName], options, host).getTypeChecker();
  bindingCheckers.set(file, checker);
  return checker;
}

/** Schema imports can recover their runtime value; call arguments cannot use erased imports. */
export function isRuntimeBinding(symbol: ts.Symbol | undefined, allowTypeOnly = false): boolean {
  return symbol?.declarations?.some(declaration => {
    if (ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration)) return true;
    if (!ts.isImportSpecifier(declaration) && !ts.isImportClause(declaration) && !ts.isNamespaceImport(declaration)) return false;
    for (let node: ts.Node | undefined = declaration; node && !ts.isSourceFile(node); node = node.parent) {
      if (!allowTypeOnly && (ts.isImportSpecifier(node) || ts.isImportClause(node)) && node.isTypeOnly) return false;
    }
    return true;
  }) ?? false;
}
