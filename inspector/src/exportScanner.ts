import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Names kept in sync with unplugin-typegpu's canonical `resourceConstructors`
// list plus the WGSL directive; bracket-namespace forms (tgpu['~unstable'])
// are matched by the bare method names below.
const TYPEGPU_HINT_PATTERN =
  /\b(tgpu\.(fn|computeFn|vertexFn|fragmentFn|bindGroupLayout|vertexLayout|accessor|mutableAccessor|slot|const|comptime|privateVar|workgroupVar)|createPipeline|createRenderPipeline|createComputePipeline|createGuardedComputePipeline|createBuffer|createMutable|createReadonly|createUniform|createQuerySet|createTexture|createSampler|createComparisonSampler|createView)\b|\bd\.(struct|unstruct|arrayOf|disarrayOf|texture|texture2d|textureDepth2d)\b|'use gpu'|"use gpu"/;

export type TypegpuExportRole =
  | 'compute-entrypoint'
  | 'vertex-entrypoint'
  | 'fragment-entrypoint'
  | 'pipeline-factory'
  | 'resource-factory'
  | 'bind-group-layout'
  | 'vertex-layout'
  | 'binding-resource'
  | 'schema'
  | 'shader-helper'
  | 'shader-constant'
  | 'unknown';

export type TypegpuExportInfo = {
  name: string;
  exportKind: 'const' | 'function' | 'class' | 'type' | 'reexport' | 'default' | 'unknown';
  likelyTypegpu: boolean;
  typegpuRole: TypegpuExportRole;
  suggestedTargetKind?: 'compute-pipeline' | 'render-pipeline' | 'resolvable' | 'probe' | undefined;
  usageHint?: string | undefined;
  line: number;
  character: number;
  source?: string | undefined;
};

export type TypegpuModuleImportInfo = {
  specifier: string;
  locals: string[];
  typeOnly: boolean;
};

export type TypegpuExportScan = {
  modulePath: string;
  exports: TypegpuExportInfo[];
  likelyTypegpuExports: TypegpuExportInfo[];
  suggestedSymbolTargets: TypegpuSuggestedSymbolTarget[];
  /** The module's imports — auto-binding harvests these modules' exports too. */
  imports: TypegpuModuleImportInfo[];
};

export type TypegpuSuggestedSymbolTarget = {
  label: string;
  kind: 'compute-pipeline' | 'render-pipeline' | 'resolvable' | 'probe';
  target?: Record<string, unknown> | undefined;
  note: string;
};

export async function listTypegpuExportsFromFile(modulePath: string): Promise<TypegpuExportScan> {
  const sourceText = await readFile(modulePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    modulePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFromPath(modulePath),
  );
  const exports: TypegpuExportInfo[] = [];
  const imports: TypegpuModuleImportInfo[] = [];

  for (const statement of sourceFile.statements) {
    collectStatementExports(statement, sourceFile, exports);
    collectStatementImports(statement, imports);
  }

  return {
    modulePath,
    exports,
    likelyTypegpuExports: exports.filter((entry) => entry.likelyTypegpu),
    suggestedSymbolTargets: createSuggestedSymbolTargets(exports),
    imports,
  };
}

function collectStatementImports(
  statement: ts.Statement,
  out: TypegpuModuleImportInfo[],
): void {
  if (
    !ts.isImportDeclaration(statement) ||
    !ts.isStringLiteral(statement.moduleSpecifier) ||
    !statement.importClause
  ) {
    return;
  }
  const clause = statement.importClause;
  const locals: string[] = [];
  let hasRuntimeBinding = false;
  if (clause.name) {
    locals.push(clause.name.text);
    hasRuntimeBinding ||= !clause.isTypeOnly;
  }
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      locals.push(element.name.text);
      hasRuntimeBinding ||= !clause.isTypeOnly && !element.isTypeOnly;
    }
  } else if (bindings && ts.isNamespaceImport(bindings)) {
    locals.push(bindings.name.text);
    hasRuntimeBinding ||= !clause.isTypeOnly;
  }
  out.push({
    specifier: statement.moduleSpecifier.text,
    locals,
    typeOnly: !hasRuntimeBinding,
  });
}

function createSuggestedSymbolTargets(exports: TypegpuExportInfo[]): TypegpuSuggestedSymbolTarget[] {
  const likely = exports.filter((entry) => entry.likelyTypegpu);
  const suggestions: TypegpuSuggestedSymbolTarget[] = [];

  for (const entry of likely) {
    if (entry.typegpuRole === 'compute-entrypoint') {
      suggestions.push({
        label: entry.name,
        kind: 'compute-pipeline',
        target: { kind: 'compute-pipeline', compute: entry.name, label: entry.name },
        note: 'Ready to use in inspect_typegpu target.kind="symbols"; missing slots/accessors are auto-bound with zero or borrowed values when possible - add `with` bindings to control values explicitly.',
      });
    } else if (entry.typegpuRole === 'schema' || entry.typegpuRole === 'shader-constant') {
      suggestions.push({
        label: entry.name,
        kind: 'resolvable',
        target: { kind: 'resolvable', selector: entry.name, label: entry.name },
        note: 'Useful for checking WGSL type/value resolution.',
      });
    } else if (entry.typegpuRole === 'shader-helper') {
      suggestions.push({
        label: entry.name,
        kind: 'resolvable',
        target: { kind: 'resolvable', selector: entry.name, label: entry.name, unwrap: false },
        note: 'Ready to try as a resolvable symbol. If diagnostics say a wrapper is required, retry with a probe that calls it with concrete arguments.',
      });
    } else if (
      entry.typegpuRole === 'pipeline-factory' ||
      entry.typegpuRole === 'resource-factory'
    ) {
      suggestions.push({
        label: entry.name,
        kind: 'probe',
        note: entry.usageHint ??
          'Wrap this export in a probe or setupBody before inspection.',
      });
    }
  }

  const vertices = likely.filter((entry) => entry.typegpuRole === 'vertex-entrypoint');
  const fragments = likely.filter((entry) => entry.typegpuRole === 'fragment-entrypoint');
  if (vertices.length > 0 && fragments.length > 0) {
    for (const vertex of vertices) {
      for (const fragment of fragments) {
        suggestions.push({
          label: `${vertex.name} + ${fragment.name}`,
          kind: 'render-pipeline',
          target: {
            kind: 'render-pipeline',
            vertex: vertex.name,
            fragment: fragment.name,
            label: `${vertex.name} + ${fragment.name}`,
          },
          note: 'Starting render-pipeline target; add descriptor.targets, attribs, layout, or depthStencil if the pipeline requires them.',
        });
      }
    }
  } else {
    for (const vertex of vertices) {
      suggestions.push({
        label: vertex.name,
        kind: 'render-pipeline',
        target: { kind: 'render-pipeline', vertex: vertex.name, label: vertex.name },
        note: 'Vertex entrypoint found without an exported fragment pair; add fragment/descriptor fields if needed.',
      });
      suggestions.push({
        label: `${vertex.name} WGSL`,
        kind: 'resolvable',
        target: { kind: 'resolvable', selector: vertex.name, label: `${vertex.name} WGSL`, unwrap: false },
        note: 'Fallback target for checking vertex WGSL without constructing a full render pipeline.',
      });
    }
  }

  if (vertices.length === 0 && fragments.length > 0) {
    for (const fragment of fragments) {
      suggestions.push({
        label: `${fragment.name} WGSL`,
        kind: 'resolvable',
        target: { kind: 'resolvable', selector: fragment.name, label: `${fragment.name} WGSL`, unwrap: false },
        note: 'Fallback target for checking fragment WGSL without constructing a full render pipeline.',
      });
    }
  }

  return suggestions.slice(0, 12);
}

function collectStatementExports(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
  out: TypegpuExportInfo[],
): void {
  if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        out.push(createExportInfo(declaration.name.text, 'const', declaration, sourceFile));
      }
    }
    return;
  }

  if (ts.isFunctionDeclaration(statement) && hasExportModifier(statement)) {
    out.push(
      createExportInfo(
        statement.name?.text ?? 'default',
        hasDefaultModifier(statement) ? 'default' : 'function',
        statement,
        sourceFile,
      ),
    );
    return;
  }

  if (ts.isClassDeclaration(statement) && hasExportModifier(statement)) {
    out.push(
      createExportInfo(
        statement.name?.text ?? 'default',
        hasDefaultModifier(statement) ? 'default' : 'class',
        statement,
        sourceFile,
      ),
    );
    return;
  }

  if (ts.isTypeAliasDeclaration(statement) && hasExportModifier(statement)) {
    out.push(createExportInfo(statement.name.text, 'type', statement, sourceFile));
    return;
  }

  if (ts.isInterfaceDeclaration(statement) && hasExportModifier(statement)) {
    out.push(createExportInfo(statement.name.text, 'type', statement, sourceFile));
    return;
  }

  if (ts.isExportAssignment(statement)) {
    out.push(createExportInfo('default', 'default', statement, sourceFile));
    return;
  }

  if (ts.isExportDeclaration(statement)) {
    const moduleSpecifier = statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : undefined;
    if (!statement.exportClause) {
      out.push(createExportInfo('*', 'reexport', statement, sourceFile, moduleSpecifier));
      return;
    }
    if (ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        out.push(
          createExportInfo(element.name.text, 'reexport', element, sourceFile, moduleSpecifier),
        );
      }
    }
  }
}

function createExportInfo(
  name: string,
  exportKind: TypegpuExportInfo['exportKind'],
  node: ts.Node,
  sourceFile: ts.SourceFile,
  source?: string | undefined,
): TypegpuExportInfo {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const text = node.getFullText(sourceFile);
  const typegpuRole = inferTypegpuExportRole(node);
  const isTypeOnly = exportKind === 'type';
  return {
    name,
    exportKind,
    likelyTypegpu:
      !isTypeOnly && (typegpuRole !== 'unknown' || TYPEGPU_HINT_PATTERN.test(text)),
    typegpuRole,
    suggestedTargetKind: suggestTargetKind(typegpuRole),
    usageHint: createUsageHint(typegpuRole),
    line: position.line + 1,
    character: position.character + 1,
    source,
  };
}

function inferTypegpuExportRole(node: ts.Node): TypegpuExportRole {
  if (ts.isVariableDeclaration(node)) {
    return node.initializer ? inferExpressionRole(node.initializer) : 'unknown';
  }
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    if (containsPipelineCreation(node)) {
      return 'pipeline-factory';
    }
    if (containsResourceCreation(node)) {
      return 'resource-factory';
    }
    return containsUseGpuDirective(node) ? 'shader-helper' : 'unknown';
  }
  if (ts.isExportAssignment(node)) {
    return inferExpressionRole(node.expression);
  }
  return 'unknown';
}

function inferExpressionRole(expression: ts.Expression): TypegpuExportRole {
  const unwrapped = unwrapExpression(expression);

  if (ts.isCallExpression(unwrapped)) {
    const callee = readCalleePath(unwrapped.expression);
    const role = inferTypegpuCalleeRole(callee);
    if (role) {
      return role;
    }
    if (callee === 'tgpu.bindGroupLayout') {
      return 'bind-group-layout';
    }
    if (callee === 'tgpu.vertexLayout') {
      return 'vertex-layout';
    }
    if (callee === 'tgpu.accessor' || callee === 'tgpu.slot') {
      return 'binding-resource';
    }
    if (callee === 'tgpu.fn') {
      return 'shader-helper';
    }
    if (callee === 'tgpu.const') {
      return 'shader-constant';
    }
    if (callee === 'd.struct' || callee === 'd.unstruct' || callee === 'd.arrayOf') {
      return 'schema';
    }
    if (callee === 'root.createRenderPipeline' || callee === 'root.createComputePipeline') {
      return 'pipeline-factory';
    }
  }

  if (ts.isTaggedTemplateExpression(unwrapped)) {
    const role = inferTypegpuTaggedTemplateRole(readCalleePath(unwrapped.tag));
    if (role) {
      return role;
    }
  }

  if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) {
    return inferTypegpuExportRole(unwrapped);
  }

  if (ts.isObjectLiteralExpression(unwrapped) && containsTypegpuConst(unwrapped)) {
    return 'shader-constant';
  }

  return 'unknown';
}

function inferTypegpuCalleeRole(callee: string | undefined): TypegpuExportRole | undefined {
  if (callee === 'tgpu.computeFn') {
    return 'compute-entrypoint';
  }
  if (callee === 'tgpu.vertexFn') {
    return 'vertex-entrypoint';
  }
  if (callee === 'tgpu.fragmentFn') {
    return 'fragment-entrypoint';
  }
  return undefined;
}

function inferTypegpuTaggedTemplateRole(
  callee: string | undefined,
): TypegpuExportRole | undefined {
  if (callee === 'computeFn') {
    return 'compute-entrypoint';
  }
  if (callee === 'vertexFn') {
    return 'vertex-entrypoint';
  }
  if (callee === 'fragmentFn') {
    return 'fragment-entrypoint';
  }
  return inferTypegpuCalleeRole(callee);
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
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

function readCalleePath(expression: ts.Expression): string | undefined {
  const unwrapped = unwrapExpression(expression);
  if (ts.isCallExpression(unwrapped)) {
    return readCalleePath(unwrapped.expression);
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const left = readCalleePath(unwrapped.expression);
    return left ? `${left}.${unwrapped.name.text}` : unwrapped.name.text;
  }
  if (ts.isIdentifier(unwrapped)) {
    return unwrapped.text;
  }
  return undefined;
}

function containsPipelineCreation(node: ts.Node): boolean {
  return containsNode(node, (child) => {
    if (!ts.isCallExpression(child)) {
      return false;
    }
    const callee = readCalleePath(child.expression);
    return callee?.endsWith('.createRenderPipeline') === true ||
      callee?.endsWith('.createComputePipeline') === true;
  });
}

function containsResourceCreation(node: ts.Node): boolean {
  return containsNode(node, (child) => {
    if (!ts.isCallExpression(child)) {
      return false;
    }
    const callee = readCalleePath(child.expression);
    return callee?.endsWith('.createGuardedComputePipeline') === true ||
      callee?.endsWith('.createBuffer') === true ||
      callee?.endsWith('.createUniform') === true ||
      callee?.endsWith('.createTexture') === true ||
      callee?.endsWith('.createSampler') === true ||
      callee?.endsWith('.createBindGroup') === true;
  });
}

function containsUseGpuDirective(node: ts.Node): boolean {
  return containsNode(node, (child) =>
    ts.isExpressionStatement(child) &&
    ts.isStringLiteral(child.expression) &&
    child.expression.text === 'use gpu'
  );
}

function containsTypegpuConst(node: ts.Node): boolean {
  return containsNode(node, (child) =>
    ts.isCallExpression(child) && readCalleePath(child.expression) === 'tgpu.const'
  );
}

function containsNode(node: ts.Node, predicate: (node: ts.Node) => boolean): boolean {
  if (predicate(node)) {
    return true;
  }
  return node.getChildren().some((child) => containsNode(child, predicate));
}

function suggestTargetKind(
  role: TypegpuExportRole,
): TypegpuExportInfo['suggestedTargetKind'] {
  if (role === 'compute-entrypoint') {
    return 'compute-pipeline';
  }
  if (role === 'vertex-entrypoint' || role === 'fragment-entrypoint') {
    return 'render-pipeline';
  }
  if (role === 'pipeline-factory' || role === 'resource-factory' || role === 'shader-helper') {
    return 'probe';
  }
  if (role === 'schema' || role === 'shader-constant') {
    return 'resolvable';
  }
  return undefined;
}

function createUsageHint(role: TypegpuExportRole): string | undefined {
  if (role === 'bind-group-layout') {
    return 'Use this as a setup/binding resource with `with`; do not inspect it as a direct shader target.';
  }
  if (role === 'vertex-layout') {
    return 'Use this to provide render-pipeline `attribs`; do not inspect it as a direct shader target.';
  }
  if (role === 'binding-resource') {
    return 'Consumers of this slot/accessor are auto-bound during inspection (including across module imports); use `setupBody` or target `with` bindings to control the value explicitly.';
  }
  if (role === 'shader-helper') {
    return 'Wrap this helper in a probe with concrete arguments or a pipeline entrypoint before inspection.';
  }
  if (role === 'pipeline-factory') {
    return 'Call this from a probe or setupBody and return the created pipeline target.';
  }
  if (role === 'resource-factory') {
    return 'Call this from a probe or setupBody when you need the resources it creates; return a concrete pipeline or shader target for inspection.';
  }
  return undefined;
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
      false);
}

function hasDefaultModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ??
      false);
}

function scriptKindFromPath(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx') || path.endsWith('.jsx')) {
    return ts.ScriptKind.TSX;
  }
  if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}
