import type { Range } from 'vscode-languageserver';
import type {
  DiscoveredSymbol,
  InspectionTarget,
  ShaderSourceToken,
} from './discovery.js';
import type { CompilerMessage } from './protocol.js';

export type WgslMappingConfidence = 'high' | 'medium' | 'none';

export type WgslMappingStrategy =
  | 'generated-token'
  | 'generated-token-ordinal'
  | 'declaration-name'
  | 'ambiguous-declaration'
  | 'unmapped';

export type WgslDiagnosticMapping = {
  confidence: WgslMappingConfidence;
  strategy: WgslMappingStrategy;
  generatedRange?: Range;
  generatedDeclaration?: {
    kind: string;
    name: string;
    range: Range;
  };
  sourceRange?: Range;
  sourceSymbol?: string;
  generatedToken?: string;
};

type GeneratedDeclaration = {
  kind: string;
  name: string;
  stage?: 'compute' | 'vertex' | 'fragment';
  start: number;
  end: number;
  nameStart: number;
  nameEnd: number;
};

type SourceTokenMatch = {
  symbol: DiscoveredSymbol;
  token: ShaderSourceToken;
};

type GeneratedIdentifierSpan = {
  text: string;
  start: number;
  end: number;
};

type SymbolAssociation = {
  confidence: 'high' | 'medium' | 'none';
  symbols: DiscoveredSymbol[];
};

/**
 * Maps a WebGPU compiler location to authored TS source. There's no real
 * source map — the unplugin's metadata is a structural AST with no offsets —
 * so high confidence needs an unambiguous match: one authored occurrence, a
 * diagnostic-named token, a caret on an identifier, or a unique callee/token
 * in the selection. Repeated tokens map by ordinal only when generated and
 * authored occurrence counts agree, and stay medium confidence.
 */
export function mapWgslDiagnostic(
  wgsl: string,
  message: CompilerMessage,
  target: InspectionTarget,
  symbols: DiscoveredSymbol[],
): WgslDiagnosticMapping {
  const generatedRange = compilerGeneratedRange(wgsl, message);
  const messageOffset = compilerOffset(wgsl, message);
  const declaration = messageOffset === undefined
    ? undefined
    : generatedDeclarations(wgsl).find((candidate) =>
      messageOffset >= candidate.start && messageOffset <= candidate.end
    );
  const generatedDeclaration = declaration
    ? {
        kind: declaration.kind,
        name: declaration.name,
        range: offsetsToRange(wgsl, declaration.nameStart, declaration.nameEnd),
      }
    : undefined;
  const targetSymbols = symbols.filter((symbol) =>
    target.symbolNames.includes(symbol.name) || symbol.targetIds.includes(target.id)
  );
  const association = declaration
    ? associateGeneratedDeclaration(declaration, targetSymbols)
    : { confidence: 'none', symbols: [] } satisfies SymbolAssociation;
  const matchingSymbols = association.symbols;

  if (!declaration) {
    return {
      confidence: 'none',
      strategy: 'unmapped',
      ...(generatedRange ? { generatedRange } : {}),
      ...(generatedDeclaration ? { generatedDeclaration } : {}),
    };
  }
  const mappedDeclaration = generatedDeclaration!;

  const generatedToken = selectedGeneratedIdentifier(
    wgsl,
    message,
    new Set(
      matchingSymbols.flatMap((symbol) =>
        (symbol.shaderSourceTokens ?? []).map((token) => token.text)
      ),
    ),
  );
  const tokenMatches = generatedToken
    ? sourceTokenMatches(matchingSymbols, generatedToken)
    : [];

  if (generatedToken && tokenMatches.length === 1) {
    const { symbol, token } = tokenMatches[0]!;
    return {
      confidence: association.confidence === 'none'
        ? 'medium'
        : association.confidence,
      strategy: 'generated-token',
      sourceRange: token.range,
      sourceSymbol: symbol.name,
      generatedToken,
      ...(generatedRange ? { generatedRange } : {}),
      generatedDeclaration: mappedDeclaration,
    };
  }

  if (generatedToken && matchingSymbols.length === 1) {
    const ordinalMatch = matchingOrdinalToken(
      wgsl,
      declaration,
      messageOffset,
      matchingSymbols[0]!,
      generatedToken,
    );
    if (ordinalMatch) {
      return {
        confidence: 'medium',
        strategy: 'generated-token-ordinal',
        sourceRange: ordinalMatch.range,
        sourceSymbol: matchingSymbols[0]!.name,
        generatedToken,
        ...(generatedRange ? { generatedRange } : {}),
        generatedDeclaration: mappedDeclaration,
      };
    }
  }

  if (matchingSymbols.length > 1) {
    return {
      confidence: 'none',
      strategy: 'ambiguous-declaration',
      ...(generatedToken ? { generatedToken } : {}),
      ...(generatedRange ? { generatedRange } : {}),
      generatedDeclaration: mappedDeclaration,
    };
  }

  const symbol = matchingSymbols[0];
  if (!symbol) {
    return {
      confidence: 'none',
      strategy: 'unmapped',
      ...(generatedToken ? { generatedToken } : {}),
      ...(generatedRange ? { generatedRange } : {}),
      generatedDeclaration: mappedDeclaration,
    };
  }

  if (generatedToken === declaration.name) {
    return {
      confidence: declaration.name === symbol.name ||
          declaration.name === symbol.runtimeName
        ? 'high'
        : 'medium',
      strategy: 'declaration-name',
      sourceRange: symbol.range,
      sourceSymbol: symbol.name,
      generatedToken,
      ...(generatedRange ? { generatedRange } : {}),
      generatedDeclaration: mappedDeclaration,
    };
  }

  return {
    confidence: 'medium',
    strategy: 'declaration-name',
    sourceRange: symbol.range,
    sourceSymbol: symbol.name,
    ...(generatedToken ? { generatedToken } : {}),
    ...(generatedRange ? { generatedRange } : {}),
    generatedDeclaration: mappedDeclaration,
  };
}

export function compilerGeneratedRange(
  wgsl: string,
  message: CompilerMessage,
): Range | undefined {
  const start = compilerOffset(wgsl, message);
  if (start === undefined) return undefined;
  if (message.length === undefined || message.length <= 0) {
    const identifier = identifierSpanAtOffset(wgsl, start);
    if (identifier) return offsetsToRange(wgsl, identifier.start, identifier.end);
  }
  const requestedLength = Math.max(1, message.length ?? 1);
  const end = Math.min(wgsl.length, start + requestedLength);
  return offsetsToRange(wgsl, start, Math.max(start + 1, end));
}

function selectedGeneratedIdentifier(
  wgsl: string,
  message: CompilerMessage,
  sourceIdentifiers: Set<string>,
): string | undefined {
  const start = compilerOffset(wgsl, message);
  if (start === undefined) return undefined;

  if (message.length === undefined || message.length <= 1) {
    const atCaret = identifierSpanAtOffset(wgsl, start)?.text;
    if (atCaret && sourceIdentifiers.has(atCaret)) return atCaret;
  }

  if (message.length === undefined || message.length <= 0) return undefined;

  const end = Math.min(wgsl.length, start + message.length);
  const selected = wgsl.slice(start, end);
  if (isWholeIdentifierSelection(wgsl, start, end)) return selected;
  if (
    sourceIdentifiers.has(selected) &&
    isWholeLexicalTokenSelection(wgsl, start, end, selected)
  ) {
    return selected;
  }

  const selectedIdentifiers = new Set(
    [...selected.matchAll(/\b[A-Za-z_]\w*\b/g)].map((match) => match[0]),
  );
  const quotedIdentifiers = new Set(
    [...message.message.matchAll(/['`]([A-Za-z_]\w*)['`]/g)]
      .map((match) => match[1])
      .filter((identifier): identifier is string =>
        identifier !== undefined &&
        selectedIdentifiers.has(identifier) &&
        sourceIdentifiers.has(identifier)
      ),
  );
  if (quotedIdentifiers.size === 1) return [...quotedIdentifiers][0];
  if (quotedIdentifiers.size > 1) return undefined;

  const callCallees = new Set(
    [...selected.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)]
      .map((match) => match[1])
      .filter((identifier): identifier is string =>
        identifier !== undefined && sourceIdentifiers.has(identifier)
      ),
  );
  if (callCallees.size === 1) return [...callCallees][0];

  const sourceRelevantIdentifiers = [...selectedIdentifiers].filter((identifier) =>
    sourceIdentifiers.has(identifier)
  );
  return sourceRelevantIdentifiers.length === 1
    ? sourceRelevantIdentifiers[0]
    : undefined;
}

function matchingOrdinalToken(
  wgsl: string,
  declaration: GeneratedDeclaration,
  messageOffset: number | undefined,
  symbol: DiscoveredSymbol,
  generatedToken: string,
): ShaderSourceToken | undefined {
  if (messageOffset === undefined) return undefined;
  const generatedOccurrences = identifierOccurrences(
    wgsl,
    generatedToken,
    declaration.start,
    declaration.end,
  );
  const sourceOccurrences = (symbol.shaderSourceTokens ?? []).filter(
    (token) => token.text === generatedToken,
  );
  if (
    generatedOccurrences.length <= 1 ||
    generatedOccurrences.length !== sourceOccurrences.length
  ) {
    return undefined;
  }

  const ordinal = generatedOccurrences.findIndex((occurrence) =>
    messageOffset >= occurrence.start && messageOffset <= occurrence.end
  );
  return ordinal >= 0 ? sourceOccurrences[ordinal] : undefined;
}

function identifierOccurrences(
  source: string,
  identifier: string,
  start: number,
  end: number,
): GeneratedIdentifierSpan[] {
  const pattern = new RegExp(`\\b${escapeRegExp(identifier)}\\b`, 'g');
  const attributeRanges = wgslAttributeRanges(source, start, end);
  return [...source.slice(start, end).matchAll(pattern)]
    .map((match) => start + (match.index ?? 0))
    .filter((occurrenceStart) =>
      !attributeRanges.some((range) =>
        occurrenceStart >= range.start && occurrenceStart < range.end
      )
    )
    .map((occurrenceStart) => ({
      text: identifier,
      start: occurrenceStart,
      end: occurrenceStart + identifier.length,
    }));
}

function wgslAttributeRanges(
  source: string,
  start: number,
  end: number,
): Array<{ start: number; end: number }> {
  return [...source.slice(start, end).matchAll(/@[A-Za-z_]\w*(?:\([^)]*\))?/g)]
    .map((match) => {
      const attributeStart = start + (match.index ?? 0);
      return { start: attributeStart, end: attributeStart + match[0].length };
    });
}

function sourceTokenMatches(
  symbols: DiscoveredSymbol[],
  generatedToken: string,
): SourceTokenMatch[] {
  return symbols.flatMap((symbol) =>
    (symbol.shaderSourceTokens ?? [])
      .filter((token) => token.text === generatedToken)
      .map((token) => ({ symbol, token }))
  );
}

function generatedDeclarationMatchesSymbol(
  generatedName: string,
  symbol: DiscoveredSymbol,
): boolean {
  return [symbol.runtimeName, symbol.name]
    .filter((name): name is string => Boolean(name))
    .some((name) => {
      const sanitized = sanitizeGeneratedPrimer(name);
      return generatedName === name ||
        generatedName === sanitized ||
        new RegExp(`^${escapeRegExp(sanitized)}_\\d+$`).test(generatedName);
    });
}

function associateGeneratedDeclaration(
  declaration: GeneratedDeclaration,
  targetSymbols: DiscoveredSymbol[],
): SymbolAssociation {
  const nameMatches = targetSymbols.filter((symbol) =>
    generatedDeclarationMatchesSymbol(declaration.name, symbol)
  );
  if (nameMatches.length > 0) {
    return { confidence: 'high', symbols: nameMatches };
  }

  if (declaration.stage) {
    const stageRole = `${declaration.stage}-entrypoint`;
    const stageMatches = targetSymbols.filter((symbol) =>
      symbol.role === stageRole && (symbol.shaderSourceTokens?.length ?? 0) > 0
    );
    if (stageMatches.length > 0) {
      return { confidence: 'high', symbols: stageMatches };
    }

    const pipelineRole = declaration.stage === 'compute'
      ? 'compute-pipeline'
      : 'render-pipeline';
    const inlinePipelineMatches = targetSymbols.filter((symbol) =>
      symbol.role === pipelineRole && (symbol.shaderSourceTokens?.length ?? 0) > 0
    );
    if (inlinePipelineMatches.length > 0) {
      return { confidence: 'medium', symbols: inlinePipelineMatches };
    }
  }

  const sourceBearingSymbols = targetSymbols.filter(
    (symbol) => (symbol.shaderSourceTokens?.length ?? 0) > 0,
  );
  return isAnonymousGeneratedFunctionName(declaration.name) &&
      sourceBearingSymbols.length === 1
    ? { confidence: 'medium', symbols: sourceBearingSymbols }
    : { confidence: 'none', symbols: [] };
}

function isAnonymousGeneratedFunctionName(name: string): boolean {
  return /^(?:item|fn)(?:_\d+)?$/.test(name);
}

function sanitizeGeneratedPrimer(name: string): string {
  return name.replaceAll(/\s/g, '_').replaceAll(/[^\w]/g, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isWholeIdentifierSelection(
  source: string,
  start: number,
  end: number,
): boolean {
  const selected = source.slice(start, end);
  if (!/^[A-Za-z_]\w*$/.test(selected)) return false;
  return !isIdentifierCharacter(source[start - 1]) &&
    !isIdentifierCharacter(source[end]);
}

function isWholeLexicalTokenSelection(
  source: string,
  start: number,
  end: number,
  selected: string,
): boolean {
  const boundaryCharacters = /^[A-Za-z0-9_.]+$/.test(selected)
    ? /[A-Za-z0-9_.]/
    : /[!%&*+\-/<=>^|]/;
  const before = source[start - 1];
  const after = source[end];
  return (before === undefined || !boundaryCharacters.test(before)) &&
    (after === undefined || !boundaryCharacters.test(after));
}

function identifierSpanAtOffset(
  source: string,
  offset: number,
): GeneratedIdentifierSpan | undefined {
  if (source.length === 0) return undefined;
  const cursor = Math.max(0, Math.min(source.length - 1, offset));
  if (!isIdentifierCharacter(source[cursor])) return undefined;

  let start = cursor;
  let end = cursor + 1;
  while (start > 0 && isIdentifierCharacter(source[start - 1])) start -= 1;
  while (end < source.length && isIdentifierCharacter(source[end])) end += 1;
  const identifier = source.slice(start, end);
  return /^[A-Za-z_]\w*$/.test(identifier)
    ? { text: identifier, start, end }
    : undefined;
}

function isIdentifierCharacter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_]/.test(value);
}

function compilerOffset(wgsl: string, message: CompilerMessage): number | undefined {
  if (
    message.offset !== undefined &&
    Number.isInteger(message.offset) &&
    message.offset >= 0 &&
    message.offset < wgsl.length
  ) {
    return message.offset;
  }
  if (message.lineNum === undefined) return undefined;
  const line = Math.max(0, message.lineNum - 1);
  const character = Math.max(0, (message.linePos ?? 1) - 1);
  const lineStarts = precomputeForWgsl(wgsl).lineStarts;
  const lineStart = lineStarts[line];
  if (lineStart === undefined) return undefined;
  const nextLineStart = lineStarts[line + 1];
  const end = nextLineStart === undefined ? wgsl.length : nextLineStart - 1;
  return Math.min(Math.max(lineStart, end - 1), lineStart + character);
}

/**
 * Per-WGSL-string precomputation cache. `mapWgslDiagnostic` runs once per
 * compiler message against the same `wgsl` string instance, so a single-slot
 * cache keyed by reference avoids repeating the O(n)/O(n²) scan.
 */
type WgslPrecomputation = {
  wgsl: string;
  lineStarts: number[];
  declarations: GeneratedDeclaration[];
};

let lastWgslPrecomputation: WgslPrecomputation | undefined;

function precomputeForWgsl(wgsl: string): WgslPrecomputation {
  if (lastWgslPrecomputation && lastWgslPrecomputation.wgsl === wgsl) {
    return lastWgslPrecomputation;
  }
  const precomputation: WgslPrecomputation = {
    wgsl,
    lineStarts: buildLineStarts(wgsl),
    declarations: computeGeneratedDeclarations(wgsl),
  };
  lastWgslPrecomputation = precomputation;
  return precomputation;
}

function generatedDeclarations(wgsl: string): GeneratedDeclaration[] {
  return precomputeForWgsl(wgsl).declarations;
}

function computeGeneratedDeclarations(wgsl: string): GeneratedDeclaration[] {
  const declarations: GeneratedDeclaration[] = [];
  const pattern = /^(\s*(?:(?:@\w+(?:\([^\n)]*\))?)\s*)*)(struct|fn|const|override|alias|var)(?:\s*<[^>\n]+>)?\s+([A-Za-z_]\w*)/gm;
  let depth = 0;
  let scannedUpTo = 0;
  for (const match of wgsl.matchAll(pattern)) {
    const start = match.index ?? 0;
    // matchAll yields matches in increasing start order, so continue the
    // brace-depth scan from where the previous match left off instead of
    // rescanning from the beginning of the source on every declaration.
    for (let index = scannedUpTo; index < start; index += 1) {
      const code = wgsl.charCodeAt(index);
      if (code === 123 /* { */) depth += 1;
      else if (code === 125 /* } */) depth = Math.max(0, depth - 1);
    }
    scannedUpTo = start;
    if (depth !== 0) continue;
    const kind = match[2] ?? 'declaration';
    const name = match[3];
    if (!name) continue;
    const nameStart = start + match[0].lastIndexOf(name);
    const bodyStart = (kind === 'fn' || kind === 'struct')
      ? wgsl.indexOf('{', nameStart + name.length)
      : -1;
    let end: number;
    if (bodyStart >= 0) {
      end = matchingBraceEnd(wgsl, bodyStart);
    } else {
      const semicolon = wgsl.indexOf(';', nameStart + name.length);
      end = semicolon >= 0 ? semicolon + 1 : nameStart + name.length;
    }
    declarations.push({
      kind,
      name,
      ...generatedShaderStage(match[1]),
      start,
      end,
      nameStart,
      nameEnd: nameStart + name.length,
    });
  }
  return declarations;
}

function generatedShaderStage(
  attributePrefix: string | undefined,
): { stage: 'compute' | 'vertex' | 'fragment' } | Record<string, never> {
  const stage = attributePrefix?.match(/@(compute|vertex|fragment)\b/)?.[1];
  return stage === 'compute' || stage === 'vertex' || stage === 'fragment'
    ? { stage }
    : {};
}

function matchingBraceEnd(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return source.length;
}

function offsetsToRange(source: string, start: number, end: number): Range {
  return {
    start: offsetToPosition(source, start),
    end: offsetToPosition(source, end),
  };
}

function offsetToPosition(
  source: string,
  offset: number,
): { line: number; character: number } {
  const bounded = Math.max(0, Math.min(source.length, offset));
  const lineStarts = precomputeForWgsl(source).lineStarts;
  const line = lineAtOffset(lineStarts, bounded);
  return { line, character: bounded - (lineStarts[line] ?? 0) };
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
