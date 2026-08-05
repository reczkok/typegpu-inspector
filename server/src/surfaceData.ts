import type {
  InspectorOutput,
  InspectorTargetReport,
} from './protocol.js';

export type GpuPipelineState = {
  kind: 'compute' | 'render';
  primitive?: Record<string, unknown>;
  depthStencil?: Record<string, unknown>;
  multisample?: Record<string, unknown>;
  targets?: Array<Record<string, unknown>>;
  vertexBuffers?: Array<Record<string, unknown>>;
};

export type GpuBindGroupLayout = {
  group: number;
  label: string;
  entries: GpuBindGroupLayoutEntry[];
};

export type GpuBindGroupLayoutEntry = {
  binding: number;
  visibility: string;
  resource: string;
};

export function extractGpuBindGroupLayouts(
  output: InspectorOutput,
  report: InspectorTargetReport,
): GpuBindGroupLayout[] {
  const resolved = extractResolvedBindGroupLayouts(report);
  const callIds = new Set(report.callIds ?? []);
  const calls = (output.calls ?? []).filter((call) =>
    call.name === 'device.createBindGroupLayout' &&
    (callIds.size === 0 || (call.id !== undefined && callIds.has(call.id))) &&
    (call.targetLabel === undefined || call.targetLabel === report.label));

  const recorded = calls.flatMap((call, group) => {
    if (!isRecord(call.descriptor)) return [];
    const descriptor = call.descriptor;
    const entries = Array.isArray(descriptor.entries)
      ? descriptor.entries
        .filter(isRecord)
        .flatMap((entry): GpuBindGroupLayoutEntry[] => {
          if (typeof entry.binding !== 'number') return [];
          return [{
            binding: entry.binding,
            visibility: formatVisibility(entry.visibility),
            resource: formatLayoutResource(entry),
          }];
        })
      : [];
    return [{
      group,
      label: typeof descriptor.label === 'string'
        ? descriptor.label
        : `<group ${group}>`,
      entries,
    }];
  });
  return mergeBindGroupLayouts(resolved, recorded);
}

function extractResolvedBindGroupLayouts(
  report: InspectorTargetReport,
): GpuBindGroupLayout[] {
  return (report.bindGroupLayouts ?? []).flatMap((layout) => {
    if (typeof layout.group !== 'number' || !Array.isArray(layout.entries)) {
      return [];
    }
    const entries = layout.entries.flatMap((entry): GpuBindGroupLayoutEntry[] => {
      if (typeof entry.binding !== 'number' || !isRecord(entry.resource)) return [];
      return [{
        binding: entry.binding,
        visibility: formatVisibility(entry.visibility),
        resource: formatLayoutResource(entry.resource),
      }];
    });
    return [{
      group: layout.group,
      label: typeof layout.label === 'string'
        ? layout.label
        : `<resolved group ${layout.group}>`,
      entries,
    }];
  });
}

function mergeBindGroupLayouts(
  resolved: GpuBindGroupLayout[],
  recorded: GpuBindGroupLayout[],
): GpuBindGroupLayout[] {
  const layouts = new Map<number, GpuBindGroupLayout>();
  for (const layout of resolved) {
    layouts.set(layout.group, {
      ...layout,
      entries: [...layout.entries],
    });
  }
  for (const layout of recorded) {
    const existing = layouts.get(layout.group);
    if (!existing) {
      layouts.set(layout.group, layout);
      continue;
    }
    const entries = new Map(existing.entries.map((entry) => [entry.binding, entry]));
    for (const entry of layout.entries) entries.set(entry.binding, entry);
    layouts.set(layout.group, {
      ...layout,
      entries: [...entries.values()].sort((left, right) =>
        left.binding - right.binding
      ),
    });
  }
  return [...layouts.values()].sort((left, right) => left.group - right.group);
}

export function extractGpuPipelineState(
  output: InspectorOutput,
  report: InspectorTargetReport,
): GpuPipelineState | undefined {
  const callIds = new Set(report.callIds ?? []);
  const call = [...(output.calls ?? [])].reverse().find((candidate) =>
    (candidate.name === 'device.createRenderPipeline' ||
      candidate.name === 'device.createComputePipeline') &&
    (callIds.size === 0 || (candidate.id !== undefined && callIds.has(candidate.id))) &&
    (candidate.targetLabel === undefined || candidate.targetLabel === report.label));
  if (!call || !isRecord(call.descriptor)) return undefined;
  if (call.name === 'device.createComputePipeline') return { kind: 'compute' };

  const descriptor = call.descriptor;
  const vertex = isRecord(descriptor.vertex) ? descriptor.vertex : undefined;
  const fragment = isRecord(descriptor.fragment) ? descriptor.fragment : undefined;
  return {
    kind: 'render',
    ...(isRecord(descriptor.primitive) ? { primitive: descriptor.primitive } : {}),
    ...(isRecord(descriptor.depthStencil)
      ? { depthStencil: descriptor.depthStencil }
      : {}),
    ...(isRecord(descriptor.multisample)
      ? { multisample: descriptor.multisample }
      : {}),
    ...(Array.isArray(fragment?.targets)
      ? { targets: fragment.targets.filter(isRecord) }
      : {}),
    ...(Array.isArray(vertex?.buffers)
      ? { vertexBuffers: vertex.buffers.filter(isRecord) }
      : {}),
  };
}

function formatVisibility(value: unknown): string {
  if (Array.isArray(value)) {
    const stages = value.filter((stage): stage is string =>
      typeof stage === 'string'
    );
    if (
      stages.includes('vertex') &&
      stages.includes('fragment') &&
      stages.includes('compute')
    ) {
      return 'all stages';
    }
    return stages.join(' + ') || '—';
  }
  if (typeof value !== 'number') return '—';
  const stages = [
    value & 1 ? 'vertex' : undefined,
    value & 2 ? 'fragment' : undefined,
    value & 4 ? 'compute' : undefined,
  ].filter((stage): stage is string => Boolean(stage));
  if (stages.length === 3) return 'all stages';
  return stages.join(' + ') || String(value);
}

function formatLayoutResource(entry: Record<string, unknown>): string {
  for (const key of ['buffer', 'sampler', 'texture', 'storageTexture']) {
    const descriptor = entry[key];
    if (!isRecord(descriptor)) continue;
    return compactLayoutResource(key, descriptor);
  }
  if ('externalTexture' in entry) return 'externalTexture';
  return 'unknown resource';
}

function compactLayoutResource(
  kind: string,
  descriptor: Record<string, unknown>,
): string {
  let details: unknown[];
  switch (kind) {
    case 'buffer':
      details = [
        descriptor.type,
        descriptor.hasDynamicOffset === true ? 'dynamic offset' : undefined,
        typeof descriptor.minBindingSize === 'number' &&
            descriptor.minBindingSize > 0
          ? `${descriptor.minBindingSize} B minimum`
          : undefined,
      ];
      break;
    case 'sampler':
      details = [descriptor.type];
      break;
    case 'texture':
      details = [
        descriptor.sampleType,
        descriptor.viewDimension,
        descriptor.multisampled === true ? 'multisampled' : undefined,
      ];
      break;
    default:
      details = [
        descriptor.access,
        descriptor.format,
        descriptor.viewDimension,
      ];
  }
  return [kind, ...details]
    .filter((value) =>
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    )
    .map(String)
    .join(' · ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
