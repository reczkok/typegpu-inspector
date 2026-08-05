import { describe, expect, it } from 'vitest';
import { InspectionScheduler } from '../src/inspectionScheduler.js';

describe('InspectionScheduler', () => {
  it('logically supersedes an obsolete document version and aborts its transport', async () => {
    const scheduler = new InspectionScheduler<string>();
    let oldSignal: AbortSignal | undefined;
    const old = scheduler.schedule(
      job(1, ['old'], 'interactive'),
      (signal) => {
        oldSignal = signal;
        return rejectWhenAborted(signal);
      },
    );

    const current = scheduler.schedule(
      job(2, ['current'], 'interactive'),
      async () => 'current result',
    );

    await expect(old).resolves.toEqual({ status: 'superseded' });
    expect(oldSignal?.aborted).toBe(true);
    await expect(current).resolves.toEqual({
      status: 'completed',
      value: 'current result',
    });
  });

  it('preempts and requeues background work so interactive work runs first', async () => {
    const scheduler = new InspectionScheduler<string>();
    const order: string[] = [];
    let backgroundRuns = 0;
    let firstBackgroundSignal: AbortSignal | undefined;

    const background = scheduler.schedule(
      job(1, ['one', 'two'], 'background'),
      (signal) => {
        backgroundRuns += 1;
        order.push(`background-${backgroundRuns}`);
        if (backgroundRuns === 1) {
          firstBackgroundSignal = signal;
          return rejectWhenAborted(signal);
        }
        return Promise.resolve('full document');
      },
    );
    const interactive = scheduler.schedule(
      job(1, ['two'], 'interactive'),
      async () => {
        order.push('interactive');
        return 'hover target';
      },
    );

    await expect(interactive).resolves.toEqual({
      status: 'completed',
      value: 'hover target',
    });
    await expect(background).resolves.toEqual({
      status: 'completed',
      value: 'full document',
    });
    expect(firstBackgroundSignal?.aborted).toBe(true);
    expect(order).toEqual(['background-1', 'interactive', 'background-2']);
  });

  it('uses latest-wins semantics for hover requests in one document', async () => {
    const scheduler = new InspectionScheduler<string>();
    const first = scheduler.schedule(
      job(1, ['first'], 'interactive'),
      rejectWhenAborted,
    );
    const second = scheduler.schedule(
      job(1, ['second'], 'interactive'),
      async () => 'second',
    );

    await expect(first).resolves.toEqual({ status: 'superseded' });
    await expect(second).resolves.toEqual({
      status: 'completed',
      value: 'second',
    });
  });
});

function job(
  sourceVersion: number,
  targetIds: string[],
  priority: 'interactive' | 'background',
) {
  return {
    documentUri: 'file:///workspace/shader.ts',
    sourceVersion,
    targetIds,
    priority,
  } as const;
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(new DOMException('Aborted', 'AbortError')),
      { once: true },
    );
  });
}
