import type {
  BindingStats,
  CompilationMessageStats,
  InspectionStats,
  RecordedGpuCall,
  SerializedError,
  ShaderCompilationMessage,
} from '../types.ts';

type ShaderModuleRecord = {
  call: RecordedGpuCall;
  module: GPUShaderModule;
  code: string;
};

type RecorderState = {
  calls: RecordedGpuCall[];
  shaderModules: ShaderModuleRecord[];
  nextCallId: number;
  nextObjectId: number;
  objectIds: WeakMap<object, string>;
};

const recordedDeviceMethods = new Set([
  'createShaderModule',
  'createPipelineLayout',
  'createBindGroupLayout',
  'createComputePipeline',
  'createRenderPipeline',
  'createBuffer',
  'createTexture',
  'createSampler',
  'createBindGroup',
]);

const recordedQueueMethods = new Set(['submit', 'writeBuffer', 'writeTexture']);
const MAX_SERIALIZED_DEPTH = 8;
const MAX_PIPELINE_DESCRIPTOR_DEPTH = 12;
const MAX_SERIALIZED_ENTRIES = 80;
const MAX_SERIALIZED_STRING_LENGTH = 16_000;

/**
 * Arrays that carry the inspection payload itself, not an unbounded GPU
 * descriptor — capped via {@link MAX_SERIALIZED_LARGE_ARRAY_ENTRIES} since the
 * default {@link MAX_SERIALIZED_ENTRIES} would silently drop calls and target
 * reports the caller explicitly asked for.
 */
const LARGE_ARRAY_FIELD_NAMES = new Set([
  'calls',
  'targets',
  'console',
  'pageErrors',
  'diagnostics',
  'compilationMessages',
]);
export const MAX_SERIALIZED_LARGE_ARRAY_ENTRIES = 2_000;

/**
 * Fields that carry generated shader source. They must survive serialization
 * intact so the Node-side report (and the LSP source mapping built on top of
 * it) sees the same WGSL the GPU saw.
 */
const CODE_FIELD_NAMES = new Set(['wgsl', 'code']);
export const DEFAULT_MAX_SERIALIZED_CODE_LENGTH = 8_000_000;

/** Floor for in-page waits when the caller's remaining budget is smaller. */
export const MIN_BROWSER_WAIT_MS = 5_000;

export type BrowserWaitBudget = () => number;

/**
 * Derives in-page waits from the caller's remaining timeout budget, never
 * dropping below {@link MIN_BROWSER_WAIT_MS} so a nearly-exhausted budget still
 * gives WebGPU a chance to answer instead of failing instantly.
 */
export function createBrowserWaitBudget(timeoutMs: number | undefined): BrowserWaitBudget {
  const startedAtMs = performance.now();
  const totalMs =
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : undefined;

  return () => {
    if (totalMs === undefined) {
      return MIN_BROWSER_WAIT_MS;
    }
    return Math.max(MIN_BROWSER_WAIT_MS, totalMs - (performance.now() - startedAtMs));
  };
}

export type GpuRecorder = {
  device: GPUDevice;
  calls: RecordedGpuCall[];
  flushCompilationInfo(): Promise<void>;
  summarize(): InspectionStats;
};

export function createGpuRecorder(
  device: GPUDevice,
  options: { waitBudget?: BrowserWaitBudget | undefined } = {},
): GpuRecorder {
  const waitBudget = options.waitBudget ?? (() => MIN_BROWSER_WAIT_MS);
  const state: RecorderState = {
    calls: [],
    shaderModules: [],
    nextCallId: 1,
    nextObjectId: 1,
    objectIds: new WeakMap(),
  };

  const queueProxy = createMethodRecordingProxy(state, device.queue, 'queue', recordedQueueMethods);
  const deviceProxy = new Proxy(device, {
    get(target, prop) {
      if (prop === 'queue') {
        return queueProxy;
      }

      const value = Reflect.get(target, prop, target);
      if (typeof prop !== 'string' || typeof value !== 'function') {
        return value;
      }

      if (!recordedDeviceMethods.has(prop)) {
        return value.bind(target);
      }

      return (...args: unknown[]) =>
        recordCall(state, `device.${prop}`, args[0], () => value.apply(target, args), prop);
    },
  });

  return {
    device: deviceProxy,
    calls: state.calls,
    async flushCompilationInfo() {
      await Promise.all(
        state.shaderModules.map(async ({ call, module }) => {
          if (call.compilationMessages) {
            return;
          }
          try {
            const info = await withBrowserTimeout(
              module.getCompilationInfo(),
              waitBudget(),
              `Timed out while reading compilation info for call ${call.id}.`,
            );
            call.compilationMessages = info.messages.map(serializeCompilationMessage);
          } catch (error) {
            call.error = serializeError(error);
          }
        }),
      );
    },
    summarize() {
      return summarizeCalls(state.calls);
    },
  };
}

export async function withBrowserTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = window.setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      window.clearTimeout(timeout);
    }
  }
}

function createMethodRecordingProxy<T extends object>(
  state: RecorderState,
  target: T,
  namespace: string,
  recordedMethods: Set<string>,
): T {
  return new Proxy(target, {
    get(rawTarget, prop) {
      const value = Reflect.get(rawTarget, prop, rawTarget);
      if (typeof prop !== 'string' || typeof value !== 'function') {
        return value;
      }
      if (!recordedMethods.has(prop)) {
        return value.bind(rawTarget);
      }
      return (...args: unknown[]) =>
        recordCall(state, `${namespace}.${prop}`, args[0], () => value.apply(rawTarget, args), prop);
    },
  });
}

function recordCall<T>(
  state: RecorderState,
  name: string,
  descriptor: unknown,
  invoke: () => T,
  methodName: string,
): T {
  const startedAtMs = performance.now();
  const call: RecordedGpuCall = {
    id: state.nextCallId++,
    name,
    ok: false,
    startedAtMs,
    durationMs: 0,
    descriptor: sanitizeForJson(
      descriptor,
      new WeakSet(),
      0,
      methodName === 'createRenderPipeline' || methodName === 'createComputePipeline'
        ? MAX_PIPELINE_DESCRIPTOR_DEPTH
        : MAX_SERIALIZED_DEPTH,
    ),
  };
  state.calls.push(call);

  try {
    const result = invoke();
    call.ok = true;
    call.durationMs = performance.now() - startedAtMs;

    if (result && typeof result === 'object') {
      call.resultId = getObjectId(state, result);
    }

    if (methodName === 'createShaderModule' && isShaderModule(result)) {
      const code = getShaderModuleCode(descriptor);
      state.shaderModules.push({ call, module: result, code });
    }

    return result;
  } catch (error) {
    call.ok = false;
    call.durationMs = performance.now() - startedAtMs;
    call.error = serializeError(error);
    throw error;
  }
}

function getObjectId(state: RecorderState, value: object): string {
  const existing = state.objectIds.get(value);
  if (existing) {
    return existing;
  }
  const prefix = value.constructor?.name || 'Object';
  const next = `${prefix}#${state.nextObjectId++}`;
  state.objectIds.set(value, next);
  return next;
}

function isShaderModule(value: unknown): value is GPUShaderModule {
  return !!value && typeof value === 'object' && 'getCompilationInfo' in value;
}

function getShaderModuleCode(descriptor: unknown): string {
  if (
    descriptor &&
    typeof descriptor === 'object' &&
    'code' in descriptor &&
    typeof descriptor.code === 'string'
  ) {
    return descriptor.code;
  }
  return '';
}

export function serializeCompilationMessage(
  message: GPUCompilationMessage,
): ShaderCompilationMessage {
  return {
    type: message.type,
    message: message.message,
    lineNum: message.lineNum,
    linePos: message.linePos,
    offset: message.offset,
    length: message.length,
  };
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: sanitizeForJson(error.cause),
    };
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return {
      name: error.constructor?.name,
      message: String((error as { message: unknown }).message),
      cause: sanitizeForJson((error as { cause?: unknown }).cause),
    };
  }
  return { message: String(error) };
}

export type SanitizeJsonOptions = {
  /**
   * Character budget for known code-bearing fields ('wgsl', 'code'). Defaults
   * to {@link DEFAULT_MAX_SERIALIZED_CODE_LENGTH} so shader source is not cut
   * before the Node-side `maxWgslBytes` shaping ever sees it.
   */
  maxCodeLength?: number | undefined;
};

type SanitizeState = {
  seen: WeakSet<object>;
  maxDepth: number;
  maxCodeLength: number;
};

export function sanitizeForJson(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
  maxDepth = MAX_SERIALIZED_DEPTH,
  options: SanitizeJsonOptions = {},
): unknown {
  const maxCodeLength =
    typeof options.maxCodeLength === 'number' &&
      Number.isFinite(options.maxCodeLength) &&
      options.maxCodeLength > 0
      ? Math.max(options.maxCodeLength, MAX_SERIALIZED_STRING_LENGTH)
      : DEFAULT_MAX_SERIALIZED_CODE_LENGTH;

  return sanitizeValue(value, undefined, depth, { seen, maxDepth, maxCodeLength });
}

function sanitizeValue(
  value: unknown,
  key: string | undefined,
  depth: number,
  state: SanitizeState,
): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return limitString(value, stringLimitFor(key, state));
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'function') {
    return `[Function ${value.name || 'anonymous'}]`;
  }
  if (typeof value !== 'object') {
    return String(value);
  }
  if (depth >= state.maxDepth) {
    return `[MaxDepth ${value.constructor?.name ?? 'Object'}]`;
  }
  if (state.seen.has(value)) {
    return {
      __repeatedReference: value.constructor?.name ?? 'Object',
    };
  }
  state.seen.add(value);

  if (ArrayBuffer.isView(value)) {
    return {
      type: value.constructor.name,
      byteLength: value.byteLength,
      length: 'length' in value ? value.length : undefined,
    };
  }
  if (value instanceof ArrayBuffer) {
    return { type: 'ArrayBuffer', byteLength: value.byteLength };
  }
  if (Array.isArray(value)) {
    const budget = arrayEntryLimitFor(key);
    const out: unknown[] = value
      .slice(0, budget)
      .map((item) => sanitizeValue(item, undefined, depth + 1, state));
    if (value.length > budget) {
      // A structural sentinel: a bare string here is spread into an object of
      // numeric character keys by downstream `{ ...entry }` formatting.
      out.push({ __truncated: value.length - budget });
    }
    return out;
  }

  if (!isPlainObject(value)) {
    return {
      __object: value.constructor?.name ?? 'Object',
      label: readOptionalLabel(value),
    };
  }

  const out: Record<string, unknown> = {};
  let entries: [string, unknown][];
  try {
    entries = Object.entries(value);
  } catch (error) {
    return {
      __object: value.constructor?.name ?? 'Object',
      error: serializeError(error),
    };
  }

  for (const [nestedKey, nestedValue] of entries.slice(0, MAX_SERIALIZED_ENTRIES)) {
    out[nestedKey] = sanitizeValue(nestedValue, nestedKey, depth + 1, state);
    if (
      CODE_FIELD_NAMES.has(nestedKey) &&
      typeof nestedValue === 'string' &&
      nestedValue.length > stringLimitFor(nestedKey, state)
    ) {
      out[`${nestedKey}Truncated`] = true;
    }
  }
  if (entries.length > MAX_SERIALIZED_ENTRIES) {
    out.__truncated = `${entries.length - MAX_SERIALIZED_ENTRIES} more keys`;
  }
  return out;
}

function stringLimitFor(key: string | undefined, state: SanitizeState): number {
  return key !== undefined && CODE_FIELD_NAMES.has(key)
    ? state.maxCodeLength
    : MAX_SERIALIZED_STRING_LENGTH;
}

function arrayEntryLimitFor(key: string | undefined): number {
  return key !== undefined && LARGE_ARRAY_FIELD_NAMES.has(key)
    ? MAX_SERIALIZED_LARGE_ARRAY_ENTRIES
    : MAX_SERIALIZED_ENTRIES;
}

function limitString(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}... [truncated ${value.length - limit} chars]`;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function readOptionalLabel(value: object): string | undefined {
  try {
    const maybeLabel = (value as { label?: unknown }).label;
    return typeof maybeLabel === 'string' ? maybeLabel : undefined;
  } catch {
    return undefined;
  }
}

export function summarizeCalls(calls: RecordedGpuCall[]): InspectionStats {
  const bindGroupLayoutCalls = calls.filter((call) => call.name === 'device.createBindGroupLayout');
  const catchallLayouts = bindGroupLayoutCalls.filter((call) =>
    descriptorLabel(call.descriptor).includes('Automatic Bind Group'),
  );
  const bindingCounts = summarizeBindings(bindGroupLayoutCalls);
  const computePipelineCount = calls.filter(
    (call) => call.name === 'device.createComputePipeline',
  ).length;
  const renderPipelineCount = calls.filter(
    (call) => call.name === 'device.createRenderPipeline',
  ).length;
  const compilationMessages = summarizeCompilationMessages(
    calls.flatMap((call) => call.compilationMessages ?? []),
  );

  return {
    shaderModuleCount: calls.filter((call) => call.name === 'device.createShaderModule').length,
    computePipelineCount,
    renderPipelineCount,
    pipelineCount: computePipelineCount + renderPipelineCount,
    bindGroupLayoutCount: bindGroupLayoutCalls.length,
    explicitBindGroupLayoutCount: bindGroupLayoutCalls.length - catchallLayouts.length,
    inferredCatchallBindGroupLayoutCount: catchallLayouts.length,
    bindingCounts,
    compilationMessageCount: compilationMessages.total,
    compilationErrorCount: compilationMessages.errorCount,
    compilationWarningCount: compilationMessages.warningCount,
    compilationInfoCount: compilationMessages.infoCount,
    compilationMessages,
    consoleMessageCount: 0,
    consoleWarningCount: 0,
    consoleErrorCount: 0,
    consoleInfoCount: 0,
    consoleDebugCount: 0,
    consoleMessages: summarizeCompilationMessages([]),
  };
}

export function summarizeCompilationMessages(
  messages: ShaderCompilationMessage[],
): CompilationMessageStats {
  const stats: CompilationMessageStats = {
    total: messages.length,
    errorCount: 0,
    warningCount: 0,
    infoCount: 0,
    byType: {},
  };

  for (const message of messages) {
    increment(stats.byType, message.type);
    if (message.type === 'error') {
      stats.errorCount++;
    } else if (message.type === 'warning') {
      stats.warningCount++;
    } else if (message.type === 'info') {
      stats.infoCount++;
    }
  }

  return stats;
}

function descriptorLabel(descriptor: unknown): string {
  if (
    descriptor &&
    typeof descriptor === 'object' &&
    'label' in descriptor &&
    typeof descriptor.label === 'string'
  ) {
    return descriptor.label;
  }
  return '';
}

function summarizeBindings(bindGroupLayoutCalls: RecordedGpuCall[]): BindingStats {
  const byResourceType: Record<string, number> = {};
  const byVisibility: Record<string, number> = {};
  let total = 0;

  for (const call of bindGroupLayoutCalls) {
    const entries = readEntries(call.descriptor);
    for (const entry of entries) {
      total++;
      increment(byResourceType, getBindingResourceType(entry));
      for (const visibility of getVisibilityLabels(entry.visibility)) {
        increment(byVisibility, visibility);
      }
    }
  }

  return { total, byResourceType, byVisibility };
}

function readEntries(descriptor: unknown): Array<Record<string, unknown>> {
  if (
    descriptor &&
    typeof descriptor === 'object' &&
    'entries' in descriptor &&
    Array.isArray(descriptor.entries)
  ) {
    return descriptor.entries.filter(
      (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object',
    );
  }
  return [];
}

function getBindingResourceType(entry: Record<string, unknown>): string {
  if ('buffer' in entry) {
    const buffer = entry.buffer as { type?: unknown } | undefined;
    return `buffer:${typeof buffer?.type === 'string' ? buffer.type : 'uniform'}`;
  }
  if ('sampler' in entry) {
    const sampler = entry.sampler as { type?: unknown } | undefined;
    return `sampler:${typeof sampler?.type === 'string' ? sampler.type : 'filtering'}`;
  }
  if ('texture' in entry) {
    const texture = entry.texture as { sampleType?: unknown } | undefined;
    return `texture:${typeof texture?.sampleType === 'string' ? texture.sampleType : 'unknown'}`;
  }
  if ('storageTexture' in entry) {
    const texture = entry.storageTexture as { access?: unknown } | undefined;
    return `storageTexture:${typeof texture?.access === 'string' ? texture.access : 'unknown'}`;
  }
  if ('externalTexture' in entry) {
    return 'externalTexture';
  }
  return 'unknown';
}

function getVisibilityLabels(value: unknown): string[] {
  if (typeof value !== 'number') {
    return ['unknown'];
  }
  const labels: string[] = [];
  if ((value & 1) !== 0) labels.push('vertex');
  if ((value & 2) !== 0) labels.push('fragment');
  if ((value & 4) !== 0) labels.push('compute');
  return labels.length > 0 ? labels : ['none'];
}

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}
