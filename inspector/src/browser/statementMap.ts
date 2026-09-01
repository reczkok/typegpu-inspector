import { WgslGenerator } from 'typegpu/~internal';
import type {
  FunctionDefinitionOptions,
  ResolvedStatement,
  ShaderGenerator,
  ShaderGeneratorClass,
} from 'typegpu/~internal';
import type {
  StatementMap,
  StatementMapFailure,
  StatementMapFunction,
  StatementPathSegment,
} from '../types.ts';

type Block = FunctionDefinitionOptions['body'];
type Statement = Block[1][number];

// tinyest NodeTypeCatalog values; the package is not a direct dependency.
const NODE_BLOCK = 0;
const NODE_IF = 11;
const NODE_FOR = 14;
const NODE_WHILE = 15;
const NODE_FOR_OF = 18;

type RecordedStatement = {
  path: StatementPathSegment[];
  code: string;
};

type RecordedFunction = {
  name: string;
  /** Body code before the `#VAR_n#` keyword pass; statement codes are verbatim substrings. */
  bodyCode: string;
  statements: RecordedStatement[];
};

type FunctionFrame = {
  name: string;
  bodyPending: boolean;
  bodyCode: string;
  statements: RecordedStatement[];
  /** The base generator returns plain code (TypeGPU < 0.12); nothing to record. */
  legacy: boolean;
};

type GeneratorResult = ResolvedStatement | string;

/**
 * Generators before TypeGPU 0.12 return the code itself instead of a
 * `ResolvedStatement`. They still resolve through the recorder unchanged,
 * but yield no statement map.
 */
function resolvedCode(result: GeneratorResult): string | undefined {
  return typeof result === 'string' ? undefined : result.code;
}

export type StatementMapRecorder = {
  readonly sequence: number;
  readonly functions: RecordedFunction[];
  failure: StatementMapFailure | undefined;
};

type GeneratorClass = typeof WgslGenerator;
type WgslGeneratorClass = ShaderGeneratorClass<ShaderGenerator & { languageKey: 'wgsl' }>;

const BaseGenerator = WgslGenerator as GeneratorClass | undefined;
const RECENT_RECORDER_LIMIT = 32;

let nextSequence = 0;
const recentRecorders: StatementMapRecorder[] = [];

export function isStatementMapSupported(): boolean {
  return typeof BaseGenerator === 'function';
}

function createRecorder(): StatementMapRecorder {
  const recorder: StatementMapRecorder = {
    sequence: nextSequence++,
    functions: [],
    failure: undefined,
  };
  recentRecorders.push(recorder);
  if (recentRecorders.length > RECENT_RECORDER_LIMIT) recentRecorders.shift();
  return recorder;
}

/** Sequence number that recorders created from now on will exceed or equal. */
export function currentRecorderSequence(): number {
  return nextSequence;
}

function indexStatements(
  statement: Statement,
  path: StatementPathSegment[],
  paths: WeakMap<object, StatementPathSegment[]>,
): void {
  if (typeof statement !== 'object' || statement === null) return;
  paths.set(statement, path);
  const kind = statement[0];
  if (kind === NODE_BLOCK) {
    indexBlock(statement as Block, path, paths);
  } else if (kind === NODE_IF) {
    const [, , consequent, alternate] = statement as readonly [number, unknown, Statement, Statement?];
    indexStatements(consequent, [...path, 'then'], paths);
    if (alternate !== undefined) indexStatements(alternate, [...path, 'else'], paths);
  } else if (kind === NODE_FOR) {
    const [, init, , update, body] = statement as readonly [
      number,
      Statement | null,
      unknown,
      Statement | null,
      Statement,
    ];
    if (init) indexStatements(init, [...path, 'init'], paths);
    if (update) indexStatements(update, [...path, 'update'], paths);
    indexStatements(body, [...path, 'body'], paths);
  } else if (kind === NODE_WHILE) {
    indexStatements((statement as readonly [number, unknown, Statement])[2], [...path, 'body'], paths);
  } else if (kind === NODE_FOR_OF) {
    indexStatements(
      (statement as readonly [number, unknown, unknown, Statement])[3],
      [...path, 'body'],
      paths,
    );
  }
}

function indexBlock(
  block: Block,
  prefix: StatementPathSegment[],
  paths: WeakMap<object, StatementPathSegment[]>,
): void {
  block[1].forEach((statement, index) => indexStatements(statement, [...prefix, index], paths));
}

function defineRecordingGenerator(Base: NonNullable<GeneratorClass>) {
  return class RecordingWgslGenerator extends Base {
    readonly recorder = createRecorder();
    readonly #paths = new WeakMap<object, StatementPathSegment[]>();
    readonly #frames: FunctionFrame[] = [];

    override functionDefinition(options: FunctionDefinitionOptions): string {
      indexBlock(options.body, [], this.#paths);
      const frame: FunctionFrame = {
        name: options.name,
        bodyPending: true,
        bodyCode: '',
        statements: [],
        legacy: false,
      };
      this.#frames.push(frame);
      try {
        const code = super.functionDefinition(options);
        if (!frame.legacy) {
          this.recorder.functions.push({
            name: frame.name,
            bodyCode: frame.bodyCode,
            statements: frame.statements,
          });
        }
        return code;
      } catch (error) {
        this.recorder.failure ??= { fn: frame.name, path: [] };
        throw error;
      } finally {
        this.#frames.pop();
      }
    }

    // Arguments pass through positionally: 0.12 takes (block, allowInlining,
    // externalMap), older generators (block, externalMap).
    protected override _block(...args: Parameters<WgslGenerator['_block']>): ResolvedStatement {
      const frame = this.#frames.at(-1);
      if (!frame || !frame.bodyPending) {
        return super._block(...args);
      }
      frame.bodyPending = false;
      const result: GeneratorResult = super._block(...args);
      const code = resolvedCode(result);
      if (code === undefined) {
        frame.legacy = true;
      } else {
        frame.bodyCode = code;
      }
      return result as ResolvedStatement;
    }

    protected override _statement(statement: Statement): ResolvedStatement {
      const frame = this.#frames.at(-1);
      const path = typeof statement === 'object' && statement !== null
        ? this.#paths.get(statement)
        : undefined;
      try {
        const result: GeneratorResult = super._statement(statement);
        const code = resolvedCode(result);
        if (frame && code === undefined) {
          frame.legacy = true;
        } else if (frame && path && code !== undefined && code.length > 0) {
          frame.statements.push({ path, code });
        }
        return result as ResolvedStatement;
      } catch (error) {
        if (frame && path) {
          this.recorder.failure ??= { fn: frame.name, path };
        }
        throw error;
      }
    }
  };
}

const RecordingGenerator = BaseGenerator ? defineRecordingGenerator(BaseGenerator) : undefined;

export const statementMapTestHooks = { defineRecordingGenerator };

/** Generator class for `tgpu.initFromDevice({ unstable_shaderGeneratorClass })`. */
export function statementMapGeneratorClass(): WgslGeneratorClass | undefined {
  return RecordingGenerator as unknown as WgslGeneratorClass | undefined;
}

/** A fresh recording generator for one `tgpu.resolveWithContext` call. */
export function createStatementMapGenerator():
  | { generator: WgslGenerator; recorder: StatementMapRecorder }
  | undefined {
  if (!RecordingGenerator) return undefined;
  const generator = new RecordingGenerator();
  return { generator, recorder: generator.recorder };
}

/**
 * Locates every recorded function in `code` and turns the recorded statement
 * codes into absolute line spans. Returns undefined when the recording does
 * not describe this code.
 */
export function buildStatementMap(
  recorder: StatementMapRecorder,
  code: string,
): StatementMap | undefined {
  if (recorder.functions.length === 0 && !recorder.failure) return undefined;
  const functions: StatementMapFunction[] = [];
  for (const fn of recorder.functions) {
    const headerOffset = findFunctionHeader(code, fn.name);
    if (headerOffset === undefined) return undefined;
    const headerLine = countLines(code, 0, headerOffset);
    functions.push({
      name: fn.name,
      line: headerLine,
      statements: placeStatements(fn, headerLine),
    });
  }
  return {
    functions,
    ...(recorder.failure ? { failure: recorder.failure } : {}),
  };
}

/**
 * Picks the most recent recording (at or after `sinceSequence`) whose
 * functions all appear in `code`, for shader modules TypeGPU resolved on its
 * own (root-created pipelines).
 */
export function findStatementMapForCode(
  code: string,
  sinceSequence: number,
): StatementMap | undefined {
  for (let index = recentRecorders.length - 1; index >= 0; index -= 1) {
    const recorder = recentRecorders[index]!;
    if (recorder.sequence < sinceSequence) break;
    if (recorder.functions.length === 0) continue;
    const map = buildStatementMap(recorder, code);
    if (map) return map;
  }
  return undefined;
}

/**
 * The failure of the newest recorder created at or after `sinceSequence`.
 * Only the last resolution can have aborted a target; earlier ones were
 * retried (auto-binding) and their failures are stale.
 */
export function findLatestRecordedFailure(sinceSequence: number): StatementMapFailure | undefined {
  const latest = recentRecorders.at(-1);
  return latest && latest.sequence >= sinceSequence ? latest.failure : undefined;
}

function findFunctionHeader(code: string, name: string): number | undefined {
  const pattern = new RegExp(`(?:^|[\\s)])fn\\s+${escapeRegExp(name)}\\s*\\(`, 'g');
  const match = pattern.exec(code);
  if (!match) return undefined;
  return match.index + match[0].indexOf('fn');
}

type PlacedStatement = { start: number; end: number };

function placeStatements(
  fn: RecordedFunction,
  headerLine: number,
): StatementMapFunction['statements'] {
  // Pre-order: a parent precedes its children, siblings keep source order,
  // so each child is searched inside its parent's span after its previous
  // sibling.
  const ordered = [...fn.statements].sort((left, right) => comparePaths(left.path, right.path));
  const placed = new Map<string, PlacedStatement>();
  const cursors = new Map<string, number>();
  const entries: StatementMapFunction['statements'] = [];
  for (const statement of ordered) {
    const parentKey = nearestPlacedAncestor(statement.path, placed);
    const region = parentKey === undefined
      ? { start: 0, end: fn.bodyCode.length }
      : placed.get(parentKey)!;
    const cursor = Math.max(region.start, cursors.get(parentKey ?? '') ?? region.start);
    const index = fn.bodyCode.indexOf(statement.code, cursor);
    if (index === -1 || index + statement.code.length > region.end) continue;
    const span = { start: index, end: index + statement.code.length };
    const key = pathKey(statement.path);
    placed.set(key, span);
    cursors.set(parentKey ?? '', span.end);
    entries.push({
      path: statement.path,
      line: headerLine + countLines(fn.bodyCode, 0, index),
      lineCount: countLines(statement.code, 0, statement.code.length) + 1,
    });
  }
  return entries;
}

function nearestPlacedAncestor(
  path: StatementPathSegment[],
  placed: Map<string, PlacedStatement>,
): string | undefined {
  for (let length = path.length - 1; length > 0; length -= 1) {
    const key = pathKey(path.slice(0, length));
    if (placed.has(key)) return key;
  }
  return undefined;
}

const SLOT_ORDER: Record<string, number> = { init: 0, update: 1, body: 2, then: 0, else: 1 };

function comparePaths(left: StatementPathSegment[], right: StatementPathSegment[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (a === b) continue;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (typeof a === 'string' && typeof b === 'string') {
      return (SLOT_ORDER[a] ?? 0) - (SLOT_ORDER[b] ?? 0) || a.localeCompare(b);
    }
    return typeof a === 'number' ? -1 : 1;
  }
  return left.length - right.length;
}

function pathKey(path: StatementPathSegment[]): string {
  return path.join('.');
}

function countLines(text: string, start: number, end: number): number {
  let count = 0;
  for (let index = start; index < end; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
