import type { LedgerEntry } from '../types.ts';

declare global {
  interface Window {
    __TYPEGPU_ENVIRONMENT_LEDGER__?: LedgerEntry[];
  }
}

/** Installs bounded, provenance-recording browser capabilities before module import. */
export function installEnvironmentProviders(): LedgerEntry[] {
  const ledger = (window.__TYPEGPU_ENVIRONMENT_LEDGER__ = []);
  installLazyDomProvider(ledger);
  installMediaProvider(ledger);
  installFetchObserver(ledger);
  installQuiescentSchedulingProvider(ledger);
  return ledger;
}

export function installGpuSessionProvider(device: GPUDevice, ledger: LedgerEntry[]): void {
  (globalThis as { __typegpuMcpInspectorDevice?: GPUDevice }).__typegpuMcpInspectorDevice = device;
  try {
    const queuePrototype = Object.getPrototypeOf(device.queue) as { submit?: unknown };
    if (typeof queuePrototype.submit === 'function') {
      queuePrototype.submit = () => {
        recordOnce(ledger, {
          tier: 'environment',
          kind: 'device-session',
          key: 'device-session:queue-submit-suppressed',
          status: 'satisfied',
          discoveredBy: 'failure',
          provider: 'synthesis',
          provenance: 'Suppressed application queue submission while inspection validation scopes were active.',
        });
      };
    }
  } catch {
    // Some browser implementations do not expose a writable queue prototype.
  }
}

function installQuiescentSchedulingProvider(ledger: LedgerEntry[]): void {
  let animationFrameId = 0;
  window.requestAnimationFrame = (() => {
    recordOnce(ledger, {
      tier: 'environment',
      kind: 'device-session',
      key: 'device-session:animation-frame-suppressed',
      status: 'satisfied',
      discoveredBy: 'failure',
      provider: 'synthesis',
      provenance: 'Suppressed an application animation frame during deterministic inspection.',
    });
    return ++animationFrameId;
  }) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = (() => {}) as typeof window.cancelAnimationFrame;

  window.ResizeObserver = class {
    observe(): void {
      recordOnce(ledger, {
        tier: 'environment',
        kind: 'dom-setup',
        key: 'dom:resize-observer-suppressed',
        status: 'satisfied',
        discoveredBy: 'failure',
        provider: 'synthesis',
        provenance: 'Suppressed ResizeObserver callbacks during deterministic inspection.',
      });
    }
    unobserve(): void {}
    disconnect(): void {}
  } as typeof ResizeObserver;
}

function recordOnce(ledger: LedgerEntry[], entry: LedgerEntry): void {
  if (!ledger.some((existing) => existing.key === entry.key)) ledger.push(entry);
}

function installLazyDomProvider(ledger: LedgerEntry[]): void {
  const originalGetElementById = document.getElementById.bind(document);
  const originalQuerySelector = document.querySelector.bind(document);
  const created = new Map<string, Element>();

  document.getElementById = ((id: string) => {
    const existing = originalGetElementById(id);
    if (existing) return existing;
    const cached = created.get(`id:${id}`);
    if (cached) return cached as HTMLElement;
    const element = createElement(guessTagFromId(id));
    element.id = id;
    document.body.append(element);
    created.set(`id:${id}`, element);
    ledger.push({
      tier: 'environment',
      kind: 'dom-setup',
      key: `dom:id:${id}`,
      status: 'satisfied',
      discoveredBy: 'failure',
      provider: 'synthesis',
      provenance: `A <${element.tagName.toLowerCase()}> was lazily materialized for #${id}.`,
      detail: { id, tag: element.tagName.toLowerCase() },
    });
    return element as HTMLElement;
  }) as typeof document.getElementById;

  document.querySelector = ((selector: string) => {
    const existing = originalQuerySelector(selector);
    if (existing) return existing;
    const parsed = parseSimpleSelector(selector);
    if (!parsed) return null;
    const key = `selector:${selector}`;
    const cached = created.get(key);
    if (cached) return cached;
    const element = createElement(parsed.tag);
    if (parsed.id) element.id = parsed.id;
    if (parsed.className) element.className = parsed.className;
    document.body.append(element);
    created.set(key, element);
    ledger.push({
      tier: 'environment',
      kind: 'dom-setup',
      key: `dom:selector:${selector}`,
      status: 'satisfied',
      discoveredBy: 'failure',
      provider: 'synthesis',
      provenance: `A <${parsed.tag}> was lazily materialized for ${selector}.`,
      detail: { selector, tag: parsed.tag },
    });
    return element;
  }) as typeof document.querySelector;
}

function createElement(tag: string): HTMLElement {
  const element = document.createElement(tag);
  if (element instanceof HTMLCanvasElement) {
    element.width = 64;
    element.height = 64;
    element.dataset.typegpuInspectorFixture = '';
  }
  if (element instanceof HTMLButtonElement) element.type = 'button';
  return element;
}

function guessTagFromId(id: string): string {
  const value = id.toLowerCase();
  if (value.includes('canvas')) return 'canvas';
  if (value.includes('video') || value.includes('camera')) return 'video';
  if (value.includes('image') || value.includes('preview')) return 'img';
  if (value.includes('button')) return 'button';
  if (value.includes('input')) return 'input';
  return 'div';
}

function parseSimpleSelector(selector: string): {
  tag: string;
  id?: string | undefined;
  className?: string | undefined;
} | undefined {
  const value = selector.trim();
  if (/^[a-z][\w-]*$/i.test(value)) return { tag: value.toLowerCase() };
  const id = /^(?:([a-z][\w-]*)\s*)?#([A-Za-z_][\w:.-]*)$/i.exec(value);
  if (id) return { tag: id[1]?.toLowerCase() ?? guessTagFromId(id[2]!), id: id[2] };
  const className = /^\.([A-Za-z_][\w-]*)$/.exec(value);
  return className ? { tag: 'div', className: className[1] } : undefined;
}

function installMediaProvider(ledger: LedgerEntry[]): void {
  const mediaDevices = navigator.mediaDevices;
  const original = mediaDevices?.getUserMedia?.bind(mediaDevices);
  if (!original) return;
  mediaDevices.getUserMedia = (async (constraints?: MediaStreamConstraints) => {
    try {
      const stream = await original(constraints);
      ledger.push({
        tier: 'environment',
        kind: 'media-stream',
        key: 'media:get-user-media',
        status: 'satisfied',
        discoveredBy: 'failure',
        provider: 'browser-native',
        provenance: 'Chromium supplied a fake-device MediaStream for inspection.',
        detail: { constraints: summarizeConstraints(constraints) },
      });
      return stream;
    } catch (error) {
      ledger.push({
        tier: 'environment',
        kind: 'media-stream',
        key: 'media:get-user-media',
        status: 'unsatisfied',
        discoveredBy: 'failure',
        detail: { message: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }) as typeof mediaDevices.getUserMedia;
}

function summarizeConstraints(constraints: MediaStreamConstraints | undefined): unknown {
  if (!constraints) return undefined;
  return { audio: Boolean(constraints.audio), video: Boolean(constraints.video) };
}

function installFetchObserver(ledger: LedgerEntry[]): void {
  const original = window.fetch.bind(window);
  window.fetch = (async (...args: Parameters<typeof fetch>) => {
    const url = String(args[0] instanceof Request ? args[0].url : args[0]);
    try {
      const response = await original(...args);
      if (response.headers.get('X-TypeGPU-Environment-Provider') === 'project-public-prefix') {
        ledger.push({
          tier: 'environment',
          kind: 'static-asset',
          key: `asset:${url}`,
          status: 'satisfied',
          discoveredBy: 'failure',
          provider: 'project-toolchain',
          provenance: 'Resolved a deployment-prefixed URL from the inspected project public directory.',
          detail: { url },
        });
      }
      if (!response.ok) recordMissingAsset(ledger, url, `HTTP ${response.status}`);
      return response;
    } catch (error) {
      recordMissingAsset(ledger, url, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }) as typeof fetch;
}

function recordMissingAsset(ledger: LedgerEntry[], url: string, message: string): void {
  ledger.push({
    tier: 'environment',
    kind: 'static-asset',
    key: `asset:${url}`,
    status: 'unsatisfied',
    discoveredBy: 'failure',
    detail: { url, message },
  });
}
