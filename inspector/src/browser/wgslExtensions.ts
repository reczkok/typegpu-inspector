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

// WGSL extension uses: https://www.w3.org/TR/WGSL/#enable-extensions
// Match language tokens/attributes, not words in comments or longer identifiers.
const EXTENSION_USES: Record<WgslExtension, RegExp> = {
  f16: /\b(?:f16|vec[234]h|mat[234]x[234]h)\b|\b(?:0[xX](?:[\da-fA-F]+(?:\.[\da-fA-F]*)?|\.[\da-fA-F]+)[pP][+-]?\d+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)h\b/,
  clip_distances: /@\s*builtin\s*\(\s*clip_distances\b/,
  dual_source_blending: /@\s*blend_src\s*\(/,
  subgroups: /@\s*builtin\s*\(\s*(?:subgroup_invocation_id|subgroup_size|subgroup_id|num_subgroups)\b|\b(?:subgroup(?:Add|All|And|Any|Ballot|Broadcast|BroadcastFirst|Elect|ExclusiveAdd|ExclusiveMul|InclusiveAdd|InclusiveMul|Max|Min|Mul|Or|Shuffle|ShuffleDown|ShuffleUp|ShuffleXor|Xor)|quad(?:Broadcast|SwapX|SwapY|SwapDiagonal))\s*\(/,
  primitive_index: /@\s*builtin\s*\(\s*primitive_index\b/,
};

/**
 * TypeGPU prepends one directive per enabled device feature, even for unused
 * features. Prune that simple header before compilation, never in a renderer.
 * Unknown/unavailable extensions and nonstandard headers stay untouched so
 * their validation errors cannot be hidden. The shader body is unchanged.
 */
export function pruneUnusedWgslExtensions(code: string, features: Iterable<string>): string {
  const header = /^(?:enable\s+[a-z][a-z0-9_]*\s*;\s*)+/.exec(code)?.[0];
  if (!header) return code;
  const body = code.slice(header.length);
  const source = withoutComments(body);
  if (source === undefined) return code;
  const available = new Set(wgslExtensionsFor(features));
  const directives = [...header.matchAll(/enable\s+([a-z][a-z0-9_]*)\s*;/g)];
  const kept = directives.filter(match => {
    const extension = match[1] as WgslExtension;
    return !available.has(extension) || EXTENSION_USES[extension].test(source);
  });
  if (kept.length === directives.length) return code;
  return (kept.length ? `${kept.map(match => match[0]).join('\n')}\n\n` : '') + body;
}

/** Nested WGSL block comments must not make commented-out features look used. */
function withoutComments(code: string): string | undefined {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '/' || (code[i + 1] !== '/' && code[i + 1] !== '*')) continue;
    parts.push(code.slice(start, i), ' ');
    if (code[i + 1] === '/') {
      i += 2;
      while (i < code.length && code[i] !== '\n' && code[i] !== '\r') i++;
    } else {
      let depth = 1;
      i += 2;
      while (i < code.length && depth) {
        const pair = code.slice(i, i + 2);
        if (pair === '/*') { depth++; i += 2; }
        else if (pair === '*/') { depth--; i += 2; }
        else i++;
      }
      if (depth) return undefined;
    }
    start = i;
    i--;
  }
  parts.push(code.slice(start));
  return parts.join('');
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
