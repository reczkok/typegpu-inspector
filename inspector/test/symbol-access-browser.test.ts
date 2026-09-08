import { discoverTypeGpuModule } from '../../server/src/discovery.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { inspectTypegpuSymbols } from '../src/inspect.ts';
import { closeAllInspectorSessions } from '../src/inspect/session.ts';
import { closeSharedBrowser } from '../src/inspect/browser.ts';

const browser = process.env.TYPEGPU_MCP_RUN_BROWSER_TESTS === '1' ? describe : describe.skip;
const cwd = resolve(import.meta.dirname, '..');
const modulePath = 'test/fixtures/nested-symbols.ts';
const source = readFileSync(resolve(cwd, modulePath), 'utf8');
const options = { cwd, modulePath, includePrivate: true, reuseBrowser: true, timeoutMs: 30_000 };

afterAll(async () => { await closeAllInspectorSessions(); await closeSharedBrowser(); });

browser('original symbol compilation', () => {
  it('inspects actual factory branches and reselects exact members without evaluating getters or CPU callbacks', async () => {
    const path = 'test/fixtures/factory-results.ts';
    const discovered = discoverTypeGpuModule(resolve(cwd, path), readFileSync(resolve(cwd, path), 'utf8'));
    const target = discovered.targets.find(target => target.id === 'factory-result:bundle')!;
    const report = await inspectTypegpuSymbols({ ...options, modulePath: path, targets: [target.selector, { selector: 'untouched', kind: 'resolvable' }] });
    const at = (path: string[]) => report.targets.find(target => JSON.stringify(target.context?.resultPath) === JSON.stringify(path));
    expect(at(['chosen'])?.ok, JSON.stringify(report.targets, null, 2)).toBe(true);
    expect(at(['chosen'])?.kind).toBe('compute-pipeline');
    expect(at(['chosen'])?.context?.pipelineStages).toContain('compute');
    expect(at(['odd.key', '0'])?.wgsl).toContain('17');
    expect(at(['odd.key', '1'])?.wgsl).toContain('29');
    expect(at(['buffer'])?.kind).toBe('resource');
    expect(at(['dangerous'])?.outcome).toBe('blocked');
    expect(report.targets.some(target => JSON.stringify(target.error)?.includes('was invoked'))).toBe(false);
    expect(at(['cpu'])).toBeUndefined();
    expect(report.targets.find(target => target.label === 'untouched')?.wgsl).toContain('return 0u;');
    expect(at(['odd.key', '2'])?.outcome).toBe('blocked');
    const selected = await inspectTypegpuSymbols({ ...options, modulePath: path, targets: [{
      selector: 'bundle', inspectMembers: true, member: ['odd.key', '0'],
    }, { selector: 'bundle', inspectMembers: true, member: ['odd.key', '2'], context: { arguments: [{ schema: 'ctx.d.f32' }] } }, { selector: 'chosen', inspectMembers: true }] });
    expect(selected.ok, JSON.stringify(selected.targets)).toBe(true);
    expect(selected.targets[0]?.wgsl).toBe(at(['odd.key', '0'])?.wgsl);
    const other = await inspectTypegpuSymbols({ ...options, modulePath: path, targets: [{ selector: 'alternate', inspectMembers: true, member: ['chosen'] }, { selector: 'uncalled', inspectMembers: true }] });
    expect(other.targets[1]?.outcome).toBe('blocked');
    expect(other.targets[0]?.wgsl).toContain('unknown_factory_symbol');
    expect(other.targets[0]?.compilationMessages?.some(message => message.type === 'error')).toBe(true);
  }, 60_000);

  it('compiles discovered plans for private composition, generic variants, accessors, and captured schemas', async () => {
    const path = 'test/fixtures/helper-planning.ts';
    const source = readFileSync(resolve(cwd, path), 'utf8');
    const discovered = discoverTypeGpuModule(resolve(cwd, path), source);
    const targets = discovered.targets.filter(target => ['pair', 'withAccessor', 'generic', 'make.helper', 'missingArray'].some(name => target.symbolNames.includes(name))).map(target => target.selector);
    const report = await inspectTypegpuSymbols({ ...options, modulePath: path, targets });
    expect(report.targets).toHaveLength(7);
    const generated = report.targets.filter(target => target.ok);
    expect(generated, JSON.stringify(report.targets, null, 2)).toHaveLength(6);
    expect(generated.every(target => target.outcome === 'passed-with-assumptions')).toBe(true);
    const pairs = report.targets.filter(target => target.context?.probe?.origin === 'call-site');
    expect(pairs).toHaveLength(2);
    expect(new Set(pairs.map(target => target.context?.probe?.line)).size).toBe(2);
    const missing = report.targets.find(target => target.label === 'missingArray');
    expect(missing?.outcome).toBe('blocked');
    expect(missing?.context?.probe?.missing).toMatchObject([{ parameter: 'values', index: 0 }]);
    expect(missing?.diagnostics?.[0]?.message).toContain('values');
    const fixed = await inspectTypegpuSymbols({ ...options, modulePath: path,
      setupBody: 'return { Samples: d.arrayOf(d.f32, 4) };',
      targets: [{ ...targets.find(target => 'selector' in target && target.selector === 'missingArray')!, context: { arguments: [{ schema: 'setup.Samples' }] } }],
    });
    expect(fixed.ok, JSON.stringify(fixed.targets)).toBe(true);
    expect(fixed.targets[0]?.context?.probe).toBeUndefined();
  }, 60_000);

  it('compiles complete usage sets separately and leaves incomplete contexts blocked', async () => {
    const input = { ...options, modulePath: 'test/fixtures/binding-contexts.ts' };
    const report = await inspectTypegpuSymbols({ ...input, targets: [{ selector: 'helper', kind: 'resolvable' }] });
    expect(report.targets).toHaveLength(3);
    expect(report.targets.map(target => target.context?.association)).toEqual(['direct', 'direct', 'direct']);
    expect(report.targets.map(target => target.outcome).sort()).toEqual(['blocked', 'passed', 'passed']);
    const successful = report.targets.filter(target => target.ok);
    expect(successful[0]?.wgsl).toContain('207');
    expect(successful[1]?.wgsl).toContain('409');
    const usage = successful[1]!.context!.usage!;
    const selected = await inspectTypegpuSymbols({ ...input, targets: [{ selector: 'helper', kind: 'resolvable', usage }] });
    expect(selected.targets).toHaveLength(1);
    expect(selected.targets[0]?.wgsl).toBe(successful[1]?.wgsl);
    const candidates = await inspectTypegpuSymbols({ ...input, targets: [{ selector: 'candidateHelper', kind: 'resolvable' }] });
    expect(candidates.targets).toHaveLength(3);
    expect(candidates.targets.every(target => target.context?.association === 'candidate')).toBe(true);
    expect(candidates.targets.filter(target => target.ok).map(target => target.outcome)).toEqual(['passed-with-assumptions', 'passed-with-assumptions']);
    expect(candidates.targets.filter(target => !target.ok).every(target => target.outcome === 'blocked')).toBe(true);
    const missing = await inspectTypegpuSymbols({ ...input, targets: [{ selector: 'helper', kind: 'resolvable', usage: 999 }] });
    expect(missing.targets[0]?.outcome).toBe('blocked');
  }, 60_000);

  it('evaluates the original module once', async () => {
    const report = await inspectTypegpuSymbols({ ...options, targets: [
      { selector: 'loadCount', kind: 'resolvable', unwrap: false },
    ] });
    expect(report.ok, JSON.stringify(report.targets)).toBe(true);
    expect(report.targets[0]?.wgsl).toMatch(/return 1u;/);
  }, 60_000);

  it('reports real WGSL compiler failures for nested helpers', async () => {
    const report = await inspectTypegpuSymbols({ ...options, targets: [
      { selector: 'createInvalid.invalid', declaration: source.indexOf('invalid ='), kind: 'resolvable' },
    ] });
    expect(report.ok).toBe(false);
    expect(report.targets).toHaveLength(1);
    expect(report.targets[0]?.wgsl).toContain('definitely_missing_symbol');
    expect(report.targets[0]?.compilationMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'error', message: expect.stringContaining('definitely_missing_symbol') }),
    ]));
    expect(report.targets[0]?.context?.instance).toBe(0);
  }, 60_000);

  it('compiles separate nested closures with their original captured constants', async () => {
    const report = await inspectTypegpuSymbols({ ...options, targets: [
      { selector: 'makeBlur.helper', declaration: source.indexOf('helper ='), kind: 'resolvable', unwrap: false },
    ] });
    expect(report.ok, JSON.stringify(report.targets)).toBe(true);
    expect(report.targets).toHaveLength(2);
    expect(report.targets.map(t => t.context?.instance)).toEqual([0, 1]);
    expect(report.targets[0]?.wgsl).toMatch(/3(?:\.0)?/);
    expect(report.targets[1]?.wgsl).toMatch(/7(?:\.0)?/);
    expect(report.targets[0]?.wgsl).not.toBe(report.targets[1]?.wgsl);
    expect(report.targets.map(t => t.parentLabel)).toEqual(['makeBlur.helper', 'makeBlur.helper']);
  }, 60_000);

  it('runs explicit setup for an uninstantiated private factory and selects one instance', async () => {
    const report = await inspectTypegpuSymbols({ ...options,
      setupBody: 'module.createLater(11); module.createLater(19);',
      targets: [{ selector: 'createLater.delayed', declaration: source.indexOf('delayed ='), instance: 1, kind: 'resolvable' }],
    });
    expect(report.ok, JSON.stringify(report.targets)).toBe(true);
    expect(report.targets).toHaveLength(1);
    expect(report.targets[0]?.wgsl).toMatch(/19(?:\.0)?/);
  }, 60_000);

  it('resolves inspector schemas and setup arguments inside captured CPU scopes', async () => {
    const declaration = source.indexOf('adjusted =');
    const report = await inspectTypegpuSymbols({ ...options,
      setupBody: 'module.makeAdjusted(3); module.makeAdjusted(7); return { coord: d.vec2i(11, 0) };',
      targets: [
        { selector: 'makeAdjusted.adjusted', label: 'schema input', declaration, kind: 'resolvable', probeArguments: ['ctx.d.vec2i'] },
        { selector: 'makeAdjusted.adjusted', label: 'chosen input', declaration, kind: 'resolvable', context: { arguments: [{ value: 'setup.coord' }] } },
      ],
    });
    expect(report.ok, JSON.stringify(report.targets)).toBe(true);
    expect(report.targets.map(t => t.outcome)).toEqual(['passed-with-assumptions', 'passed-with-assumptions', 'passed', 'passed']);
    expect(report.targets[0]?.wgsl).toContain('3i');
    expect(report.targets[1]?.wgsl).toContain('7i');
    expect(report.targets[2]?.wgsl).toContain('11');
  }, 60_000);

  it('applies explicit slot contexts without borrowing or synthesis', async () => {
    const report = await inspectTypegpuSymbols({ ...options, setupBody: 'return { amount: 23 };', targets: [
      { selector: 'withBias', kind: 'resolvable', context: { label: 'bias 23', with: [{ slot: 'bias', value: 'setup.amount' }] } },
    ] });
    expect(report.ok, JSON.stringify(report.targets)).toBe(true);
    expect(report.targets[0]?.wgsl).toMatch(/23(?:\.0)?/);
    expect(report.targets[0]?.context?.label).toBe('bias 23');
  }, 60_000);

  it('distinguishes explicit argument values from synthesized schema defaults', async () => {
    const report = await inspectTypegpuSymbols({ ...options, setupBody: 'return { value: 41 };', targets: [
      { selector: 'plusOne', label: 'chosen input', kind: 'resolvable', context: { arguments: [{ value: 'setup.value' }] } },
      { selector: 'plusOne', label: 'schema default', kind: 'resolvable', context: { arguments: [{ schema: 'ctx.d.f32' }] } },
    ] });
    expect(report.ok, JSON.stringify(report.targets)).toBe(true);
    expect(report.targets[0]?.outcome).toBe('passed');
    expect(report.targets[0]?.diagnostics?.some(d => d.code === 'inspection-defaults-applied')).toBe(false);
    expect(report.targets[1]?.outcome).toBe('passed-with-assumptions');
  }, 60_000);

  it('keeps private helpers accessible when the module exports inspect or uses generated names', async () => {
    for (const fixture of ['inspect-export-collision', 'generated-binding-collision']) {
      const report = await inspectTypegpuSymbols({ ...options, modulePath: `test/fixtures/${fixture}.ts`,
        targets: [{ selector: 'privateHelper', kind: 'resolvable' }],
      });
      expect(report.ok, JSON.stringify(report.targets)).toBe(true);
    }
  }, 60_000);
});
