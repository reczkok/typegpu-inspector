import { describe, expect, it } from 'vitest';
import { discoverTypeGpuModule } from '../src/discovery.js';
import {
  InspectionProgress,
  selectInspectionTargets,
} from '../src/inspectionState.js';

describe('inspection target state', () => {
  it('selects only target IDs attached to the hovered symbol', () => {
    const discovered = discoverTypeGpuModule(
      '/workspace/shaders.ts',
      `
        const first = tgpu.computeFn({ workgroupSize: [1] })(() => {});
        const second = tgpu.computeFn({ workgroupSize: [1] })(() => {});
      `,
    );
    const first = discovered.symbols.find((symbol) => symbol.name === 'first')!;
    const selected = selectInspectionTargets(discovered, first.targetIds);

    expect(discovered.targets.length).toBeGreaterThan(1);
    expect(selected.map((target) => target.id)).toEqual(first.targetIds);
    expect(selected.every((target) => target.label === 'first')).toBe(true);
  });

  it('keeps a target in progress until every overlapping request finishes', () => {
    const progress = new InspectionProgress();
    const save = progress.begin('file:///shader.ts', 3, ['one', 'two']);
    const hover = progress.begin('file:///shader.ts', 3, ['two']);

    expect([...progress.targets('file:///shader.ts', 3)]).toEqual(['one', 'two']);
    progress.finish(hover);
    expect([...progress.targets('file:///shader.ts', 3)]).toEqual(['one', 'two']);
    progress.finish(save);
    expect(progress.targets('file:///shader.ts', 3).size).toBe(0);
  });

  it('does not leak obsolete-version progress', () => {
    const progress = new InspectionProgress();
    progress.begin('file:///shader.ts', 3, ['old']);

    expect(progress.targets('file:///shader.ts', 4).size).toBe(0);
    progress.clearDocument('file:///shader.ts');
    expect(progress.targets('file:///shader.ts', 3).size).toBe(0);
  });
});
