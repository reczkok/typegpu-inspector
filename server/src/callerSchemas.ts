import ts from 'typescript';
import { hasOwnUseGpuDirective, sourceBindings, unwrap } from './shaderSyntax.js';

export type ShaderCallSchemas = { schemas: Array<string | undefined>; line: number; column: number };
type Shape = string | Map<string, string>;
const scalars = /^(?:f32|f16|i32|u32|bool|vec[234][fiuh])$/;
const builtins = new Map<string, string>([
  ...['globalInvocationId', 'localInvocationId', 'workgroupId', 'numWorkgroups'].map(name => [name, 'vec3u'] as const),
  ...['vertexIndex', 'instanceIndex', 'localInvocationIndex', 'globalInvocationIndex', 'workgroupIndex', 'sampleIndex', 'sampleMask', 'primitiveIndex', 'subgroupInvocationId', 'subgroupSize', 'subgroupId', 'numSubgroups'].map(name => [name, 'u32'] as const),
  ['position', 'vec4f'], ['frontFacing', 'bool'], ['fragDepth', 'f32'],
]);

/** Only concrete shader expressions: no CPU values, numeric-literal guesses, or arithmetic inference. */
export function discoverShaderCallSchemas(file: ts.SourceFile): Map<ts.Symbol, ShaderCallSchemas[]> {
  const checker = sourceBindings(file);
  const calls = new Map<ts.Symbol, ShaderCallSchemas[]>();
  const importedNamespace = (node: ts.Expression, kind: 'd' | 'tgpu'): boolean => {
    if (!ts.isIdentifier(node)) return false;
    const declaration = checker.getSymbolAtLocation(node)?.declarations?.[0];
    if (!declaration) return false;
    let imported: string | undefined;
    if (ts.isImportSpecifier(declaration) && !declaration.isTypeOnly) imported = (declaration.propertyName ?? declaration.name).text;
    else if (ts.isNamespaceImport(declaration)) imported = '*';
    else if (ts.isImportClause(declaration)) imported = 'default';
    let parent: ts.Node = declaration;
    while (!ts.isImportDeclaration(parent) && parent.parent) {
      if (ts.isImportClause(parent) && parent.isTypeOnly) return false;
      parent = parent.parent;
    }
    if (!ts.isImportDeclaration(parent) || !ts.isStringLiteral(parent.moduleSpecifier)) return false;
    const path = parent.moduleSpecifier.text;
    return (path === 'typegpu' && (imported === kind || (kind === 'tgpu' && imported === 'default'))) ||
      (path === 'typegpu/data' && kind === 'd' && imported === '*');
  };
  const field = (object: ts.Expression | undefined, key: string): ts.Expression | undefined => {
    if (!object || !ts.isObjectLiteralExpression(unwrap(object))) return undefined;
    const properties = (unwrap(object) as ts.ObjectLiteralExpression).properties;
    // Spreads, getters and duplicate fields do not establish one definite schema.
    if (properties.some(property => !ts.isPropertyAssignment(property))) return undefined;
    const matches = properties.filter((property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === key);
    return matches.length === 1 ? matches[0]!.initializer : undefined;
  };
  const schema = (expression: ts.Expression): string | undefined => {
    const value = unwrap(expression);
    if (!ts.isPropertyAccessExpression(value)) return undefined;
    if (importedNamespace(value.expression, 'd') && scalars.test(value.name.text)) return value.name.text;
    const base = value.expression;
    return ts.isPropertyAccessExpression(base) && base.name.text === 'builtin' && importedNamespace(base.expression, 'd')
      ? builtins.get(value.name.text) : undefined;
  };
  const owner = (node: ts.Node): ts.FunctionLikeDeclaration | undefined => {
    for (let parent = node.parent; parent; parent = parent.parent) if (ts.isFunctionLike(parent)) return parent as ts.FunctionLikeDeclaration;
    return undefined;
  };
  const inputs = (fn: ts.FunctionLikeDeclaration): Map<string, string> | undefined => {
    const parent = fn.parent;
    if (!ts.isCallExpression(parent)) return undefined;
    const shell = unwrap(parent.expression);
    if (!ts.isCallExpression(shell) || !ts.isPropertyAccessExpression(shell.expression) ||
      !['computeFn', 'vertexFn', 'fragmentFn'].includes(shell.expression.name.text) || !importedNamespace(shell.expression.expression, 'tgpu')) return undefined;
    const input = field(shell.arguments[0], 'in');
    if (!input || !ts.isObjectLiteralExpression(unwrap(input))) return undefined;
    const result = new Map<string, string>();
    for (const property of (unwrap(input) as ts.ObjectLiteralExpression).properties) {
      if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) return undefined;
      const value = field(input, property.name.text);
      const known = value && schema(value);
      if (known) result.set(property.name.text, known);
    }
    return result;
  };
  const infer = (expression: ts.Expression, fn: ts.FunctionLikeDeclaration, input: Map<string, string> | undefined, seen = new Set<ts.Symbol>()): Shape | undefined => {
    const value = unwrap(expression);
    if (ts.isCallExpression(value)) return schema(value.expression);
    if (ts.isPropertyAccessExpression(value)) {
      const base = infer(value.expression, fn, input, seen);
      if (base instanceof Map) return base.get(value.name.text);
      const vector = typeof base === 'string' && /^vec([234])([fiuh])$/.exec(base);
      if (vector && 'xyzw'.slice(0, Number(vector[1])).includes(value.name.text) && value.name.text.length === 1) {
        return { f: 'f32', i: 'i32', u: 'u32', h: 'f16' }[vector[2]!];
      }
      return undefined;
    }
    if (!ts.isIdentifier(value)) return undefined;
    const binding = checker.getSymbolAtLocation(value);
    if (!binding || seen.has(binding)) return undefined;
    seen.add(binding);
    const declaration = binding.valueDeclaration;
    if (!declaration || owner(declaration) !== fn) return undefined;
    if (ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & ts.NodeFlags.Const) && declaration.initializer) return infer(declaration.initializer, fn, input, seen);
    if (ts.isParameter(declaration) && fn.parameters[0] === declaration) return input;
    if (ts.isBindingElement(declaration) && !declaration.dotDotDotToken && !declaration.initializer &&
      ts.isObjectBindingPattern(declaration.parent) && declaration.parent.parent === fn.parameters[0]) {
      const key = declaration.propertyName ?? declaration.name;
      if (ts.isIdentifier(key) || ts.isStringLiteral(key)) return input?.get(key.text);
    }
    return undefined;
  };
  const visit = (node: ts.Node, fn?: ts.FunctionLikeDeclaration, input?: Map<string, string>) => {
    if (ts.isFunctionLike(node)) {
      fn = node as ts.FunctionLikeDeclaration;
      input = inputs(fn);
      if (!hasOwnUseGpuDirective(fn) && !input) fn = undefined;
    }
    if (fn && ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const binding = checker.getSymbolAtLocation(node.expression);
      if (binding) {
        const location = file.getLineAndCharacterOfPosition(node.getStart(file));
        const schemas = node.arguments.map(argument => {
          const shape = infer(argument, fn!, input);
          return typeof shape === 'string' ? `ctx.d.${shape}` : undefined;
        });
        const entries = calls.get(binding) ?? [];
        entries.push({ schemas, line: location.line + 1, column: location.character + 1 });
        calls.set(binding, entries);
      }
    }
    node.forEachChild(child => visit(child, fn, input));
  };
  visit(file);
  return calls;
}
