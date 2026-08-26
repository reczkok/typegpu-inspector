import { tgpu } from 'typegpu';
import * as common from 'typegpu/common';
import * as d from 'typegpu/data';
import * as std from 'typegpu/std';
import {
  createBrowserWaitBudget,
  createGpuRecorder,
  sanitizeForJson,
  type BrowserWaitBudget,
  type GpuRecorder,
} from './gpuRecorder.ts';
import {
  inspectPipelineTargets,
  normalizeTargets,
  type TypeGpuInspectionTarget,
} from './targetInspector.ts';
import { isTaggedBindingSource } from './engine/providers.ts';
import type { RecordedBindingRegistry } from './engine/types.ts';
import type {
  BrowserInspectRequest,
  BrowserInspectResult,
  InspectionCause,
  TargetDiagnostic,
  TypeGpuTargetReport,
} from '../types.ts';
import { TYPEGPU_MCP_BINDING_SOURCES_PROP } from '../shared.ts';
import {
  installEnvironmentProviders,
  installGpuSessionProvider,
} from './environment.ts';

/**
 * Cap on GPU calls shipped across CDP. Overflow is reported separately via
 * `omittedCallCount` so callers never have to guess whether an array entry is
 * real or a truncation marker.
 */
const MAX_REPORTED_CALLS = 1_000;

/**
 * Fields that exist only on the wire, not on `BrowserInspectResult` itself —
 * `src/types.ts` is owned elsewhere, so these are attached structurally and
 * read defensively on the Node side.
 */
type BrowserInspectResultExtras = {
  omittedCallCount?: number | undefined;
};

const ADAPTER_INFO_KEYS = [
  'vendor',
  'architecture',
  'device',
  'description',
  'subgroupMinSize',
  'subgroupMaxSize',
] as const;

const SOFTWARE_GPU_MARKERS = [
  'swiftshader',
  'llvmpipe',
  'software rasterizer',
  'software adapter',
] as const;

type InspectContext = {
  root: ReturnType<typeof tgpu.initFromDevice>;
  device: GPUDevice;
  tgpu: typeof tgpu;
  d: typeof d;
  std: typeof std;
  common: typeof common;
};

type ExplicitInspectionResult = {
  reports: TypeGpuTargetReport[];
  moduleImport: NonNullable<BrowserInspectResult['moduleImport']>;
};

type LoadedInspectionModule = {
  mod: Record<string, unknown>;
  inspectFn?: ((ctx: InspectContext) => Promise<TypeGpuInspectionTarget[] | TypeGpuInspectionTarget>) | undefined;
  moduleImport: NonNullable<BrowserInspectResult['moduleImport']>;
};

declare global {
  interface Window {
    __TYPEGPU_INSPECT__?: (request: BrowserInspectRequest) => Promise<BrowserInspectResult>;
  }
}

window.__TYPEGPU_INSPECT__ = inspectTypegpuModuleInBrowser;

async function inspectTypegpuModuleInBrowser(
  request: BrowserInspectRequest,
): Promise<BrowserInspectResult> {
  const waitBudget = createBrowserWaitBudget(request.timeoutMs);
  const environmentLedger = installEnvironmentProviders();
  if (request.quiescent) {
    environmentLedger.push({
      tier: 'environment',
      kind: 'device-session',
      key: 'device-session:quiescent-run',
      status: 'satisfied',
      discoveredBy: 'shape',
      provider: 'synthesis',
      provenance:
        'Quiescent run: animation frames, ResizeObserver, queue submits, and pipeline dispatch/draw were stubbed before import. Targets validated statically; no application frame was executed.',
    });
  }

  if (!navigator.gpu) {
    throw new Error('WebGPU is not supported by this browser.');
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error('Could not find a compatible GPU adapter.');
  }

  const unsupportedFeatures = request.features.filter(
    (feature) => !adapter.features.has(feature as GPUFeatureName),
  );
  if (unsupportedFeatures.length > 0) {
    throw new Error(`Unsupported requested WebGPU features: ${unsupportedFeatures.join(', ')}`);
  }

  const rawDevice = await adapter.requestDevice({
    requiredFeatures: request.features as GPUFeatureName[],
  });
  try {
    const deviceErrors: string[] = [];
    rawDevice.addEventListener('uncapturederror', (event) => {
      deviceErrors.push(event.error.message);
    });

    // A lost device makes every later WebGPU call fail for reasons unrelated to
    // the inspected code; capture the real cause so it can be reported directly.
    let deviceLost: GPUDeviceLostInfo | undefined;
    void rawDevice.lost.then((info) => {
      deviceLost = info;
    });

    const recorder = createGpuRecorder(rawDevice, { waitBudget });
    installGpuSessionProvider(rawDevice, environmentLedger);
    const root = tgpu.initFromDevice({
      device: recorder.device,
      unstable_names: request.strictNames ? 'strict' : 'random',
    });

    await applyBrowserSetup(request, { root, device: recorder.device, tgpu, d, std, common });

    const loaded = await loadInspectionModule(request);
    const recordedAfterImport = (globalThis as {
      __typegpuMcpRecording?: RecordedBindingRegistry;
    }).__typegpuMcpRecording;
    if (recordedAfterImport?.usedInspectorDevice) {
      environmentLedger.push({
        tier: 'environment',
        kind: 'device-session',
        key: 'device-session:shared-with-application',
        status: 'satisfied',
        discoveredBy: 'shape',
        provider: 'recorded-app-bindings',
        provenance: 'Application TypeGPU initialization reused the inspector device to avoid a competing session.',
      });
    }
    const inspected = await inspectExplicitTargets(request, loaded, root, recorder, waitBudget);

    await recorder.flushCompilationInfo();
    const adapterInfo = await readAdapterInfo(adapter);
    const userAgent = navigator.userAgent;

    const calls = recorder.calls.slice(0, MAX_REPORTED_CALLS);
    const omittedCallCount = recorder.calls.length - calls.length;
    const lostDiagnostic = deviceLost === undefined
      ? undefined
      : createDeviceLostDiagnostic(deviceLost);
    let lostCause: InspectionCause | undefined;
    if (lostDiagnostic) {
      const lostLedger = {
        tier: 'environment' as const,
        kind: 'device-session' as const,
        key: 'device-session:lost',
        status: 'unsatisfied' as const,
        discoveredBy: 'failure' as const,
        detail: { reason: deviceLost?.reason, message: deviceLost?.message },
      };
      environmentLedger.push(lostLedger);
      lostCause = {
        id: 'device-session-cause-1',
        tier: 'environment',
        code: lostDiagnostic.code,
        message: lostDiagnostic.message,
        diagnostics: [lostDiagnostic],
        ledger: [{ ...lostLedger }],
      };
      for (const target of inspected.reports) {
        const hasIndependentFailure = target.diagnostics?.some(
          (diagnostic) => diagnostic.severity !== 'note',
        );
        if (!hasIndependentFailure) {
          target.ok = false;
          target.diagnostics = [{ ...lostDiagnostic }, ...(target.diagnostics ?? [])];
          target.causeId = lostCause.id;
          target.outcome = 'blocked';
        }
      }
      deviceErrors.push(`${lostDiagnostic.message} ${lostDiagnostic.hint ?? ''}`.trim());
    }

    return toSerializableResult(
      {
        ok:
          inspected.reports.every((target) => target.ok) &&
          deviceErrors.length === 0 &&
          lostDiagnostic === undefined,
        moduleImport: inspected.moduleImport,
        causes: lostCause ? [lostCause] : undefined,
        ledger: environmentLedger.length > 0 ? environmentLedger : undefined,
        environment: {
          userAgent,
          adapterInfo,
          gpuType: inferGpuType(adapterInfo, userAgent),
          requestedFeatures: request.features,
          enabledFeatures: [...rawDevice.features],
          limits: serializeLimits(rawDevice.limits),
          typegpuVersion: request.typegpuVersion,
        },
        targets: inspected.reports,
        stats: recorder.summarize(),
        calls,
        omittedCallCount: omittedCallCount > 0 ? omittedCallCount : undefined,
        console: [],
        pageErrors: deviceErrors,
      },
      request,
    );
  } finally {
    delete (globalThis as { __typegpuMcpInspectorDevice?: GPUDevice }).__typegpuMcpInspectorDevice;
    rawDevice.destroy();
  }
}

function createDeviceLostDiagnostic(info: GPUDeviceLostInfo): TargetDiagnostic {
  return {
    code: 'webgpu-device-lost',
    message: `The WebGPU device was lost (${info.reason || 'unknown'}) during inspection.`,
    hint: info.message ||
      'Later WebGPU failures in this report are consequences of the lost device, not of the inspected code.',
  };
}

async function applyBrowserSetup(
  request: BrowserInspectRequest,
  ctx: InspectContext,
): Promise<void> {
  if (request.documentHtml !== undefined) {
    document.body.innerHTML = request.documentHtml;
  }

  if (request.browserSetup === undefined) {
    return;
  }

  const setup = new Function(
    'root',
    'device',
    'tgpu',
    'd',
    'std',
    'common',
    `"use strict"; return (async () => {\n${request.browserSetup}\n})();`,
  ) as (
    root: InspectContext['root'],
    device: GPUDevice,
    tgpu: InspectContext['tgpu'],
    d: InspectContext['d'],
    std: InspectContext['std'],
    common: InspectContext['common'],
  ) => Promise<void>;

  await setup(ctx.root, ctx.device, ctx.tgpu, ctx.d, ctx.std, ctx.common);
}

async function inspectExplicitTargets(
  request: BrowserInspectRequest,
  loaded: LoadedInspectionModule,
  root: ReturnType<typeof tgpu.initFromDevice>,
  recorder: GpuRecorder,
  waitBudget: BrowserWaitBudget,
): Promise<ExplicitInspectionResult> {
  const { mod, inspectFn, moduleImport } = loaded;

  if (typeof inspectFn !== 'function') {
    return { reports: [], moduleImport };
  }

  const exportedTargets = await inspectFn({ root, device: recorder.device, tgpu, d, std, common });
  // Symbols-mode wrappers attach their setup roots, the inspected module
  // namespace, and re-imported dependency namespaces (tagged with origins) to
  // the returned array; user-authored modules don't, but their own namespace
  // (`mod`) is harvestable directly. Legacy raw entries tag as module-scope.
  const sideChannel = Array.isArray(exportedTargets)
    ? (exportedTargets as unknown as Record<string, unknown>)[TYPEGPU_MCP_BINDING_SOURCES_PROP]
    : undefined;
  const bindingSources = [
    ...(Array.isArray(sideChannel) ? sideChannel : []).map((entry) =>
      isTaggedBindingSource(entry) ? entry : { value: entry, origin: 'module-scope' as const }
    ),
    { value: mod, origin: 'module-scope' as const },
  ];
  // Everything the app bound during module import and setup is recorded by
  // now; freeze so the inspector's own pipeline re-creations don't pollute
  // the registry mid-inspection.
  const recorded = (globalThis as { __typegpuMcpRecording?: RecordedBindingRegistry })
    .__typegpuMcpRecording;
  if (recorded) recorded.frozen = true;
  return {
    reports: await inspectPipelineTargets(
      normalizeTargets(exportedTargets),
      root,
      recorder,
      request.strictNames,
      {
        waitBudget,
        bindingSources,
        recorded,
        autoBind: request.autoBind,
      },
    ),
    moduleImport,
  };
}

async function loadInspectionModule(request: BrowserInspectRequest): Promise<LoadedInspectionModule> {
  const mod = await import(/* @vite-ignore */ request.moduleUrl) as Record<string, unknown>;
  const inspectFn = mod[request.exportName] as LoadedInspectionModule['inspectFn'];
  const moduleImport: LoadedInspectionModule['moduleImport'] = {
    sourceKind: request.sourceKind,
    moduleImported: true,
    inspectExportFound: typeof inspectFn === 'function',
    importOnly: false,
    exportName: request.exportName,
  };

  if (typeof inspectFn !== 'function') {
    if (request.diagnosticsOnly && request.sourceKind === 'modulePath') {
      return { mod, inspectFn, moduleImport: { ...moduleImport, importOnly: true } };
    }

    throw new Error(
      `Module '${request.moduleUrl}' does not export an inspection function named '${request.exportName}'. ` +
        "Expected: export async function inspect({ root, device, tgpu, d, std, common }) { return { label, kind, value }; }. " +
        "For ad hoc MCP probes, pass inspectBody with only the function body instead of inlineCode.",
    );
  }

  return { mod, inspectFn, moduleImport };
}

async function readAdapterInfo(adapter: GPUAdapter): Promise<unknown> {
  const adapterWithInfo = adapter as GPUAdapter & {
    info?: unknown;
    requestAdapterInfo?: () => Promise<unknown>;
  };

  if (adapterWithInfo.info) {
    return serializeAdapterInfo(adapterWithInfo.info);
  }
  if (typeof adapterWithInfo.requestAdapterInfo === 'function') {
    return serializeAdapterInfo(await adapterWithInfo.requestAdapterInfo());
  }
  return undefined;
}

function serializeAdapterInfo(info: unknown): unknown {
  if (!info || typeof info !== 'object') {
    return sanitizeForJson(info);
  }

  const readable: Record<string, unknown> = {};
  for (const key of ADAPTER_INFO_KEYS) {
    try {
      const value = (info as Record<string, unknown>)[key];
      if (typeof value === 'string' || typeof value === 'number') {
        readable[key] = value;
      }
    } catch {
      // Some browser GPU objects expose getters that may throw in unusual runtimes.
    }
  }

  return Object.keys(readable).length > 0 ? readable : sanitizeForJson(info);
}

function inferGpuType(
  adapterInfo: unknown,
  userAgent: string,
): 'hardware' | 'software' | 'unknown' {
  const haystack = `${JSON.stringify(adapterInfo ?? {})} ${userAgent}`.toLowerCase();
  if (SOFTWARE_GPU_MARKERS.some((marker) => haystack.includes(marker))) {
    return 'software';
  }
  if (adapterInfo && typeof adapterInfo === 'object') {
    return 'hardware';
  }
  return 'unknown';
}

function serializeLimits(limits: GPUSupportedLimits): Record<string, number> {
  const keys = [
    'maxTextureDimension1D',
    'maxTextureDimension2D',
    'maxTextureDimension3D',
    'maxTextureArrayLayers',
    'maxBindGroups',
    'maxBindGroupsPlusVertexBuffers',
    'maxBindingsPerBindGroup',
    'maxDynamicUniformBuffersPerPipelineLayout',
    'maxDynamicStorageBuffersPerPipelineLayout',
    'maxSampledTexturesPerShaderStage',
    'maxSamplersPerShaderStage',
    'maxStorageBuffersPerShaderStage',
    'maxStorageTexturesPerShaderStage',
    'maxUniformBuffersPerShaderStage',
    'maxUniformBufferBindingSize',
    'maxStorageBufferBindingSize',
    'minUniformBufferOffsetAlignment',
    'minStorageBufferOffsetAlignment',
    'maxVertexBuffers',
    'maxBufferSize',
  ];

  return Object.fromEntries(
    keys
      .map((key) => [key, (limits as unknown as Record<string, number>)[key]] as const)
      .filter((entry): entry is readonly [string, number] => typeof entry[1] === 'number'),
  );
}

function toSerializableResult(
  result: BrowserInspectResult & BrowserInspectResultExtras,
  request: BrowserInspectRequest,
): BrowserInspectResult {
  // The report envelope nests deeper than the already-bounded GPU descriptors,
  // so keep the recorder's deeper limit here rather than the default.
  return sanitizeForJson(result, new WeakSet(), 0, 16, {
    maxCodeLength: request.maxWgslBytes,
  }) as BrowserInspectResult;
}
