export type WgslBinding = {
  group: number;
  binding: number;
  name: string;
  addressSpace?: string;
  type: string;
};

export type WgslDeclaration = {
  kind: string;
  name: string;
  line: number;
};

export type WgslEntryPoint = {
  name: string;
  stage: 'compute' | 'vertex' | 'fragment';
  line: number;
  workgroupSize?: [string, string, string];
  workgroupInvocations?: number;
};

export type WgslOperationCounts = {
  textureSamples: number;
  textureLoads: number;
  textureStores: number;
  atomics: number;
  barriers: number;
  derivatives: number;
  discards: number;
  loops: number;
  branches: number;
};

export type WgslAnalysis = {
  utf8Bytes: number;
  characters: number;
  lines: number;
  bindings: WgslBinding[];
  declarations: WgslDeclaration[];
  entryPoints: WgslEntryPoint[];
  operations: WgslOperationCounts;
};

export function analyzeWgsl(wgsl: string): WgslAnalysis {
  const bindings: WgslBinding[] = [];
  const declarations: WgslDeclaration[] = [];
  const entryPoints: WgslEntryPoint[] = [];
  const source = stripWgslComments(wgsl);
  const lineStarts = buildLineStarts(source);

  const bindingPattern =
    /((?:@\w+(?:\([^)]*\))?\s*)+)\s*var(?:\s*<([^>]+)>)?\s+([A-Za-z_]\w*)\s*:\s*([^;]+);/g;
  for (const match of source.matchAll(bindingPattern)) {
    const attributes = match[1] ?? '';
    const group = /@group\((\d+)\)/.exec(attributes)?.[1];
    const binding = /@binding\((\d+)\)/.exec(attributes)?.[1];
    if (group === undefined || binding === undefined) continue;
    const addressSpace = match[2]?.trim();
    bindings.push({
      group: Number(group),
      binding: Number(binding),
      name: match[3] ?? '<anonymous>',
      ...(addressSpace ? { addressSpace } : {}),
      type: (match[4] ?? '<unknown>').trim(),
    });
  }

  const declarationPattern =
    /^\s*(?:@\w+(?:\([^)]*\))?\s*)*(struct|fn|const|override|alias|var)(?:\s*<[^>]+>)?\s+([A-Za-z_]\w*)/gm;
  for (const match of source.matchAll(declarationPattern)) {
    const index = match.index ?? 0;
    declarations.push({
      kind: match[1] ?? 'declaration',
      name: match[2] ?? '<anonymous>',
      line: lineAtOffset(lineStarts, index) + 1,
    });
  }

  const entryPointPattern =
    /((?:@\w+(?:\s*\([^)]*\))?\s*)+)\s*fn\s+([A-Za-z_]\w*)\s*\(/g;
  for (const match of source.matchAll(entryPointPattern)) {
    const attributes = match[1] ?? '';
    const stage = /@(compute|vertex|fragment)\b/.exec(attributes)?.[1];
    if (
      stage !== 'compute' &&
      stage !== 'vertex' &&
      stage !== 'fragment'
    ) {
      continue;
    }
    const workgroupSize = stage === 'compute'
      ? parseWorkgroupSize(attributes)
      : undefined;
    const workgroupInvocations = workgroupSize
      ? numericWorkgroupInvocations(workgroupSize)
      : undefined;
    entryPoints.push({
      name: match[2] ?? '<anonymous>',
      stage,
      line: lineAtOffset(lineStarts, match.index ?? 0) + 1,
      ...(workgroupSize ? { workgroupSize } : {}),
      ...(workgroupInvocations !== undefined ? { workgroupInvocations } : {}),
    });
  }

  bindings.sort((left, right) =>
    left.group - right.group || left.binding - right.binding);

  return {
    utf8Bytes: Buffer.byteLength(wgsl, 'utf8'),
    characters: countCodePoints(wgsl),
    lines: wgsl === '' ? 0 : wgsl.split(/\r?\n/).length,
    bindings,
    declarations,
    entryPoints,
    operations: countStaticOperations(source),
  };
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} kB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Offsets (into `text`) where each line begins; `lineStarts[0]` is always 0. */
function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

/** 0-indexed line number containing `offset`, via binary search over `lineStarts`. */
function lineAtOffset(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((lineStarts[mid] ?? 0) <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

/** Code-point count matching `[...text].length` without allocating an array. */
function countCodePoints(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
      }
    }
    count += 1;
  }
  return count;
}

function parseWorkgroupSize(
  attributes: string,
): [string, string, string] | undefined {
  const contents = /@workgroup_size\s*\(([^)]*)\)/.exec(attributes)?.[1];
  if (!contents) return undefined;
  const dimensions = contents
    .split(',')
    .map((dimension) => dimension.trim())
    .filter(Boolean);
  if (dimensions.length === 0 || dimensions.length > 3) return undefined;
  return [
    dimensions[0] ?? '1',
    dimensions[1] ?? '1',
    dimensions[2] ?? '1',
  ];
}

function numericWorkgroupInvocations(
  dimensions: [string, string, string],
): number | undefined {
  const values = dimensions.map((dimension) =>
    /^\d+u?$/.test(dimension)
      ? Number(dimension.replace(/u$/, ''))
      : undefined
  );
  const [x, y, z] = values;
  return x !== undefined && y !== undefined && z !== undefined
    ? x * y * z
    : undefined;
}

function countStaticOperations(source: string): WgslOperationCounts {
  const output: WgslOperationCounts = {
    textureSamples: 0,
    textureLoads: 0,
    textureStores: 0,
    atomics: 0,
    barriers: 0,
    derivatives: 0,
    discards: countKeyword(source, 'discard'),
    loops:
      countKeyword(source, 'loop') +
      countKeyword(source, 'for') +
      countKeyword(source, 'while'),
    branches: countKeyword(source, 'if') + countKeyword(source, 'switch'),
  };

  for (const match of source.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    const name = match[1] ?? '';
    if (/^texture(?:Sample|Gather)/.test(name)) {
      output.textureSamples += 1;
    } else if (name === 'textureLoad') {
      output.textureLoads += 1;
    } else if (name === 'textureStore') {
      output.textureStores += 1;
    } else if (/^atomic[A-Z]/.test(name)) {
      output.atomics += 1;
    } else if (
      name === 'workgroupBarrier' ||
      name === 'storageBarrier' ||
      name === 'textureBarrier'
    ) {
      output.barriers += 1;
    } else if (/^(?:dpdx|dpdy|fwidth)(?:Coarse|Fine)?$/.test(name)) {
      output.derivatives += 1;
    }
  }
  return output;
}

function countKeyword(source: string, keyword: string): number {
  return [...source.matchAll(new RegExp(`\\b${keyword}\\b`, 'g'))].length;
}

function stripWgslComments(source: string): string {
  let output = '';
  let index = 0;
  let blockDepth = 0;
  let lineComment = false;
  while (index < source.length) {
    const current = source[index] ?? '';
    const next = source[index + 1] ?? '';
    if (lineComment) {
      if (current === '\n') {
        lineComment = false;
        output += '\n';
      } else {
        output += ' ';
      }
      index += 1;
      continue;
    }
    if (blockDepth > 0) {
      if (current === '/' && next === '*') {
        blockDepth += 1;
        output += '  ';
        index += 2;
      } else if (current === '*' && next === '/') {
        blockDepth -= 1;
        output += '  ';
        index += 2;
      } else {
        output += current === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }
    if (current === '/' && next === '/') {
      lineComment = true;
      output += '  ';
      index += 2;
    } else if (current === '/' && next === '*') {
      blockDepth = 1;
      output += '  ';
      index += 2;
    } else {
      output += current;
      index += 1;
    }
  }
  return output;
}
