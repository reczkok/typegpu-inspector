import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import ts from 'typescript';

const OPTIMIZER_FAILURE_MARKER = 'Error during dependency optimization';
const MAX_DEPENDENCY_DEPTH = 3;

/** Vite's dependency optimizer reports a failed prebundle with this prefix. */
export function isDependencyOptimizationError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(OPTIMIZER_FAILURE_MARKER);
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

export type DependencyFailure = {
  /** The compiler's one-line reason, `Flow is not supported` for instance. */
  reason: string;
  /** The package the failing file belongs to, when the report names one. */
  packageName?: string;
  /** The failing file, relative to its `node_modules` entry. */
  file?: string;
};

/**
 * The part of rolldown's report worth reading: its first `[CODE] reason`
 * line and the file it points at. The rest is a source excerpt drawn in box
 * characters and colors.
 */
export function summarizeDependencyFailure(message: string): DependencyFailure {
  const plain = stripAnsi(message);
  const coded = /\[[A-Z_]+\]\s*([^\n]+)/.exec(plain);
  let reason = coded?.[1]?.trim();
  if (!reason) {
    const lines = plain.split('\n').map((line) => line.trim()).filter(Boolean);
    const start = lines.findIndex((line) => line.includes(OPTIMIZER_FAILURE_MARKER));
    reason = lines.slice(start + 1).find((line) => !/^Build failed with/.test(line)) ??
      lines[0] ?? 'the dependency could not be bundled';
  }
  const pathToken = /[^\s[\]│╭╰─]*node_modules\/[^\s[\]│╭╰─:]+/.exec(plain)?.[0];
  if (!pathToken) return { reason };
  const segments = pathToken.split('node_modules/');
  const inside = segments[segments.length - 1] ?? '';
  const parts = inside.split('/');
  const packageName = parts[0]?.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (!packageName) return { reason };
  const rest = parts.slice(packageName.startsWith('@') ? 2 : 1).join('/');
  return { reason, packageName, file: rest ? `node_modules/${packageName}/${rest}` : `node_modules/${packageName}` };
}

export type ImportChain = {
  /** 1-based line of the import in the module. */
  line: number;
  /** The packages from the imported one down to the failing one. */
  packages: string[];
};

/**
 * The first runtime import in `source` whose package is, or depends on (a
 * few levels deep), `packageName`. Type-only imports are erased before the
 * module runs and never count.
 */
export function findImportChain(
  modulePath: string,
  source: string,
  packageName: string,
): ImportChain | undefined {
  const scriptKind = /\.[cm]?jsx$|\.tsx$/.test(modulePath) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(modulePath, source, ts.ScriptTarget.Latest, false, scriptKind);
  const imports: Array<{ line: number; specifier: string }> = [];
  const add = (node: ts.Node, specifier: string) => {
    if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) return;
    imports.push({
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      specifier,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      if (!isTypeOnlyClause(node.importClause)) add(node, node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      !node.isTypeOnly
    ) {
      add(node, node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      add(node, node.arguments[0].text);
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);

  const moduleDir = dirname(modulePath);
  for (const { line, specifier } of imports) {
    const imported = packageNameOf(specifier);
    if (imported === packageName) return { line, packages: [packageName] };
    const path = dependencyPath(moduleDir, imported, packageName, MAX_DEPENDENCY_DEPTH, new Set());
    if (path) return { line, packages: path };
  }
  return undefined;
}

function isTypeOnlyClause(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  if (clause.name || !bindings || !ts.isNamedImports(bindings)) return false;
  return bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
}

function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0] ?? specifier;
}

/** Breadth-first through declared dependencies, from `fromDir`'s resolution scope. */
function dependencyPath(
  fromDir: string,
  packageName: string,
  target: string,
  depth: number,
  seen: Set<string>,
): string[] | undefined {
  if (depth === 0 || seen.has(packageName)) return undefined;
  seen.add(packageName);
  const packageDir = findPackageDir(fromDir, packageName);
  if (!packageDir) return undefined;
  const dependencies = declaredDependencies(packageDir);
  if (dependencies.includes(target)) return [packageName, target];
  for (const dependency of dependencies) {
    const path = dependencyPath(packageDir, dependency, target, depth - 1, seen);
    if (path) return [packageName, ...path];
  }
  return undefined;
}

function findPackageDir(fromDir: string, packageName: string): string | undefined {
  let current = fromDir;
  while (true) {
    const candidate = join(current, 'node_modules', packageName);
    if (existsSync(join(candidate, 'package.json'))) {
      try {
        return realpathSync(candidate);
      } catch {
        return candidate;
      }
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function declaredDependencies(packageDir: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return [];
    const record = parsed as Record<string, unknown>;
    return ['dependencies', 'peerDependencies', 'optionalDependencies'].flatMap((key) => {
      const group = record[key];
      return group && typeof group === 'object' ? Object.keys(group) : [];
    });
  } catch {
    return [];
  }
}

/**
 * One paragraph for the person reading the diagnostic: what failed, which
 * import of theirs pulled the package in, and what to do about it.
 */
export function describeDependencyFailure(
  error: Error,
  module: { path: string; source: string | undefined; cwd: string },
): string {
  const failure = summarizeDependencyFailure(error.message);
  const parts = [
    `Dependency optimization failed: ${failure.reason}${failure.file ? ` (${failure.file})` : ''}.`,
  ];
  const chain = failure.packageName && module.source !== undefined
    ? findImportChain(module.path, module.source, failure.packageName)
    : undefined;
  if (chain) {
    const [first, ...rest] = chain.packages;
    const shown = displayPath(module.path, module.cwd);
    parts.push(
      `${shown}:${chain.line} imports '${first}'${
        rest.map((name) => `, which depends on '${name}'`).join('')
      }.`,
    );
  }
  parts.push(
    'The inspector runs the module in a browser build, so this package cannot be imported at runtime; make the import type-only or keep it out of shader modules.',
  );
  return parts.join(' ');
}

function displayPath(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? path : rel;
}
