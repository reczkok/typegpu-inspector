/**
 * WGSL `enable` extensions and the WebGPU feature that unlocks each. TypeGPU
 * adds these directives itself when it builds a pipeline, keyed on the root's
 * enabled features, but a standalone `resolveWithContext` call does not; the
 * inspector mirrors the pipeline behaviour so an f16 or subgroup helper
 * compiles the same way it would inside its pipeline.
 */
export const WGSL_EXTENSION_FEATURES = {
  f16: 'shader-f16',
  clip_distances: 'clip-distances',
  dual_source_blending: 'dual-source-blending',
  subgroups: 'subgroups',
  primitive_index: 'primitive-index',
} as const;

export type WgslExtension = keyof typeof WGSL_EXTENSION_FEATURES;

/** Features the inspector requests when the adapter offers them. */
export const OPTIONAL_EXTENSION_FEATURES: readonly string[] = Object.values(
  WGSL_EXTENSION_FEATURES,
);

/** The `enable` extensions a device with `features` can compile. */
export function wgslExtensionsFor(features: Iterable<string>): WgslExtension[] {
  const enabled = new Set(features);
  return (Object.keys(WGSL_EXTENSION_FEATURES) as WgslExtension[]).filter((extension) =>
    enabled.has(WGSL_EXTENSION_FEATURES[extension])
  );
}

const MISSING_EXTENSION_PATTERNS = [
  /type used without '([a-z0-9_]+)' extension enabled/,
  /without extension '([a-z0-9_]+)'/,
  /extension '?([a-z0-9_]+)'? is not (?:allowed|supported|enabled)/i,
  /Extension ([a-z0-9_]+) is not allowed on the Device/,
];

type CompilationMessageLike = { type: string; message: string };

/**
 * Splits compiler errors caused by a WGSL extension the inspecting device
 * cannot enable from the rest. An f16 helper on an adapter without
 * `shader-f16` is an environment limit, not a defect in the shader.
 */
export function partitionUnavailableExtensionErrors<T extends CompilationMessageLike>(
  messages: readonly T[],
  features: Iterable<string>,
): { messages: T[]; unavailableFeatures: string[] } {
  const enabled = new Set(features);
  const unavailable = new Set<string>();
  const kept: T[] = [];
  for (const message of messages) {
    const extension = message.type === 'error' ? missingExtension(message.message) : undefined;
    const feature = extension && WGSL_EXTENSION_FEATURES[extension as WgslExtension];
    if (feature && !enabled.has(feature)) {
      unavailable.add(feature);
      continue;
    }
    kept.push(message);
  }
  return { messages: kept, unavailableFeatures: [...unavailable] };
}

/** The device feature an error message says is missing, when the device really lacks it. */
export function unavailableExtensionFeature(
  message: string,
  features: Iterable<string>,
): string | undefined {
  const extension = missingExtension(message);
  const feature = extension && WGSL_EXTENSION_FEATURES[extension as WgslExtension];
  return feature && !new Set(features).has(feature) ? feature : undefined;
}

function missingExtension(message: string): string | undefined {
  for (const pattern of MISSING_EXTENSION_PATTERNS) {
    const match = pattern.exec(message);
    if (match?.[1]) return match[1];
  }
  return undefined;
}
