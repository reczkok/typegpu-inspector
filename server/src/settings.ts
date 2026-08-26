import {
  defaultSettings,
  settingsBounds,
  type HoverDetailLevel,
  type HoverPresentationSettings,
  type HoverSectionId,
  type InlayDetailLevel,
  type InspectorSettings,
} from './protocol.js';

export type SettingsWarning = { key: string; detail: string };

/**
 * Merge raw client-provided settings over `base`. Invalid values are dropped
 * (reported through `warnings`) and out-of-range numbers are clamped, so a
 * typo in one key never resets or poisons the rest of the configuration.
 */
export function mergeSettings(
  value: unknown,
  base: InspectorSettings = defaultSettings,
  warnings: SettingsWarning[] = [],
): InspectorSettings {
  const raw = unwrapSettings(value);
  const warn = (key: string, detail: string) => {
    warnings.push({ key, detail });
  };
  const inspectOn = raw.inspectOn === undefined || isInspectOn(raw.inspectOn)
    ? (raw.inspectOn as InspectorSettings['inspectOn'] | undefined)
    : (warn(
        'inspectOn',
        `expected "save", "hover", "save-and-hover", or "off", got ${JSON.stringify(raw.inspectOn)}`,
      ),
      undefined);
  const booleanSetting = (key: keyof InspectorSettings & string): boolean | undefined => {
    const candidate = raw[key];
    if (candidate === undefined || typeof candidate === 'boolean') {
      return candidate as boolean | undefined;
    }
    warn(key, `expected a boolean, got ${JSON.stringify(candidate)}`);
    return undefined;
  };
  const legacyDetailLevel = raw.detailLevel === undefined || isLegacyDetailLevel(raw.detailLevel)
    ? raw.detailLevel
    : (warn(
        'detailLevel',
        `expected a legacy "minimal", "default", or "verbose" value, got ${JSON.stringify(raw.detailLevel)}`,
      ), undefined);
  const legacyHover = mapLegacyHover(legacyDetailLevel);
  const legacyInlay = mapLegacyInlay(legacyDetailLevel);
  const hoverDetailLevel = raw.hoverDetailLevel === undefined || isHoverDetailLevel(raw.hoverDetailLevel)
    ? raw.hoverDetailLevel as HoverDetailLevel | undefined
    : (warn(
        'hoverDetailLevel',
        `expected "wgsl", "compact", "standard", or "deep", got ${JSON.stringify(raw.hoverDetailLevel)}`,
      ), undefined);
  const inlayDetailLevel = raw.inlayDetailLevel === undefined || isInlayDetailLevel(raw.inlayDetailLevel)
    ? raw.inlayDetailLevel as InlayDetailLevel | undefined
    : (warn(
        'inlayDetailLevel',
        `expected "compact", "summary", or "detailed", got ${JSON.stringify(raw.inlayDetailLevel)}`,
      ), undefined);
  return {
    inspectOn: inspectOn ?? base.inspectOn,
    warmUpOnOpen: booleanSetting('warmUpOnOpen') ?? base.warmUpOnOpen,
    hoverDetailLevel: hoverDetailLevel ?? legacyHover ?? base.hoverDetailLevel,
    inlayDetailLevel: inlayDetailLevel ?? legacyInlay ?? base.inlayDetailLevel,
    hoverPresentation: parseHoverPresentation(
      raw.hoverPresentation,
      base.hoverPresentation,
      warn,
    ),
    inspectorPackage: stringValue(
      raw.inspectorPackage,
      base.inspectorPackage,
    ),
    timeoutMs: boundedNumber(
      'timeoutMs',
      raw.timeoutMs,
      base.timeoutMs,
      settingsBounds.timeoutMs,
      warn,
    ),
    maxWgslBytes: boundedNumber(
      'maxWgslBytes',
      raw.maxWgslBytes,
      base.maxWgslBytes,
      settingsBounds.maxWgslBytes,
      warn,
    ),
    strictNames: booleanSetting('strictNames') ?? base.strictNames,
    features: Array.isArray(raw.features)
      ? raw.features.filter((feature): feature is string =>
        typeof feature === 'string')
      : base.features,
    hover: booleanSetting('hover') ?? base.hover,
    inlayHints: booleanSetting('inlayHints') ?? base.inlayHints,
    diagnostics: booleanSetting('diagnostics') ?? base.diagnostics,
    documentLinks: booleanSetting('documentLinks') ?? base.documentLinks,
    sourceMapping: booleanSetting('sourceMapping') ?? base.sourceMapping,
    schemaLayoutHealth: booleanSetting('schemaLayoutHealth') ??
      base.schemaLayoutHealth,
    schemaPackingSuggestions: booleanSetting('schemaPackingSuggestions') ??
      base.schemaPackingSuggestions,
    // Editors that sync whole config sections send projectRoot's "" default
    // on every change; an empty root must mean "unset", or every
    // `projectRoot ?? workspaceRoot` fallback silently degrades to "" and
    // path joins become relative to whatever cwd a process happens to have.
    ...(typeof raw.projectRoot === 'string' && raw.projectRoot.trim() !== ''
      ? { projectRoot: raw.projectRoot }
      : typeof raw.projectRoot === 'string'
      ? {}
      : base.projectRoot !== undefined
      ? { projectRoot: base.projectRoot }
      : {}),
  };
}

export function unwrapSettings(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  if (isRecord(value.settings)) return value.settings;
  if (isRecord(value.typegpuInspector)) return value.typegpuInspector;
  return value;
}

function boundedNumber(
  key: string,
  value: unknown,
  fallback: number,
  bounds: { min: number; max: number },
  warn: (key: string, detail: string) => void,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
    (value === 0 && bounds.min > 0)
  ) {
    warn(key, `expected a non-negative number, got ${JSON.stringify(value)}`);
    return fallback;
  }
  if (value < bounds.min || value > bounds.max) {
    warn(
      key,
      `${value} is outside [${bounds.min}, ${bounds.max}]; clamping`,
    );
    return Math.min(bounds.max, Math.max(bounds.min, value));
  }
  return value;
}

function isInspectOn(value: unknown): value is InspectorSettings['inspectOn'] {
  return value === 'save' ||
    value === 'hover' ||
    value === 'save-and-hover' ||
    value === 'off';
}

function isLegacyDetailLevel(value: unknown): value is NonNullable<InspectorSettings['detailLevel']> {
  return value === 'minimal' || value === 'default' || value === 'verbose';
}

function isHoverDetailLevel(value: unknown): value is HoverDetailLevel {
  return value === 'wgsl' || value === 'compact' || value === 'standard' || value === 'deep';
}

function isInlayDetailLevel(value: unknown): value is InlayDetailLevel {
  return value === 'compact' || value === 'summary' || value === 'detailed';
}

function mapLegacyHover(value: unknown): HoverDetailLevel | undefined {
  if (value === 'minimal') return 'compact';
  if (value === 'default') return 'standard';
  if (value === 'verbose') return 'deep';
  return undefined;
}

function mapLegacyInlay(value: unknown): InlayDetailLevel | undefined {
  if (value === 'minimal') return 'compact';
  if (value === 'default') return 'summary';
  if (value === 'verbose') return 'detailed';
  return undefined;
}

const HOVER_SECTION_IDS: readonly HoverSectionId[] = [
  'wgslPreview', 'shaderFacts', 'bindings', 'datasheet', 'resource', 'schema',
  'pipelineState', 'pipelineContext', 'declarations', 'compilerMessages',
  'inspectionNotes', 'assumptions', 'runtime',
];

function parseHoverPresentation(
  value: unknown,
  fallback: HoverPresentationSettings,
  warn: (key: string, detail: string) => void,
): HoverPresentationSettings {
  if (value === undefined) return fallback;
  if (!isRecord(value)) {
    warn('hoverPresentation', `expected an object, got ${JSON.stringify(value)}`);
    return fallback;
  }
  const known = new Set(HOVER_SECTION_IDS);
  const sections: HoverPresentationSettings['sections'] = { ...fallback.sections };
  if (value.sections !== undefined) {
    if (!isRecord(value.sections)) {
      warn('hoverPresentation.sections', 'expected an object');
    } else {
      for (const [id, mode] of Object.entries(value.sections)) {
        if (!known.has(id as HoverSectionId)) {
          warn(`hoverPresentation.sections.${id}`, 'unknown hover section');
        } else if (mode !== 'auto' && mode !== 'show' && mode !== 'hide') {
          warn(`hoverPresentation.sections.${id}`, 'expected "auto", "show", or "hide"');
        } else {
          sections[id as HoverSectionId] = mode;
        }
      }
    }
  }
  const sectionOrder: HoverSectionId[] = [];
  if (value.sectionOrder !== undefined) {
    if (!Array.isArray(value.sectionOrder)) {
      warn('hoverPresentation.sectionOrder', 'expected an array');
    } else {
      for (const id of value.sectionOrder) {
        if (typeof id !== 'string' || !known.has(id as HoverSectionId)) {
          warn('hoverPresentation.sectionOrder', `unknown hover section ${JSON.stringify(id)}`);
        } else if (!sectionOrder.includes(id as HoverSectionId)) {
          sectionOrder.push(id as HoverSectionId);
        }
      }
    }
  } else {
    sectionOrder.push(...fallback.sectionOrder);
  }
  const budget = (
    key: 'maxColumns' | 'wgslPreviewLines' | 'collectionItems' | 'declarations' |
      'compilerMessages' | 'inspectionNotes' | 'assumptions',
  ): number | undefined => {
    const candidate = value[key];
    if (candidate === undefined) return fallback[key as keyof HoverPresentationSettings] as number | undefined;
    return boundedNumber(
      `hoverPresentation.${key}`,
      candidate,
      fallback[key as keyof HoverPresentationSettings] as number ?? settingsBounds[key].min,
      settingsBounds[key],
      warn,
    );
  };
  const maxColumns = budget('maxColumns');
  const wgslPreviewLines = budget('wgslPreviewLines');
  const collectionItems = budget('collectionItems');
  const declarations = budget('declarations');
  const compilerMessages = budget('compilerMessages');
  const inspectionNotes = budget('inspectionNotes');
  const assumptions = budget('assumptions');
  return {
    sections,
    sectionOrder,
    ...(maxColumns !== undefined ? { maxColumns } : {}),
    ...(wgslPreviewLines !== undefined ? { wgslPreviewLines } : {}),
    ...(collectionItems !== undefined ? { collectionItems } : {}),
    ...(declarations !== undefined ? { declarations } : {}),
    ...(compilerMessages !== undefined ? { compilerMessages } : {}),
    ...(inspectionNotes !== undefined ? { inspectionNotes } : {}),
    ...(assumptions !== undefined ? { assumptions } : {}),
  };
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
