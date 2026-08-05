export type InspectionPriority = 'interactive' | 'background';

export type InspectionJob = {
  documentUri: string;
  sourceVersion: number;
  targetIds: readonly string[];
  priority: InspectionPriority;
};

export type InspectionScheduleResult<T> =
  | { status: 'completed'; value: T }
  | { status: 'superseded' };

type QueueEntry<T> = {
  request: InspectionJob;
  run: (signal: AbortSignal) => Promise<T>;
  promise: Promise<InspectionScheduleResult<T>>;
  resolve: (result: InspectionScheduleResult<T>) => void;
  reject: (error: unknown) => void;
  controller?: AbortController;
  state: 'queued' | 'running' | 'settled';
  preempted: boolean;
  preemptCount: number;
  superseded: boolean;
};

/**
 * After this many preemptions a background job runs to completion, so rapid
 * hovering cannot starve save-triggered work indefinitely.
 */
const MAX_PREEMPTIONS = 2;

/**
 * Serializes calls to the single runtime-inspector session while allowing an
 * interactive hover to preempt background save work. Aborted background work
 * is requeued; obsolete versions and obsolete hover requests are discarded.
 */
export class InspectionScheduler<T> {
  private readonly queue: QueueEntry<T>[] = [];
  private active: QueueEntry<T> | undefined;

  public schedule(
    request: InspectionJob,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<InspectionScheduleResult<T>> {
    const normalized = normalizedRequest(request);
    const duplicate = this.findEquivalent(normalized);
    if (duplicate) return duplicate.promise;

    this.supersedeObsolete(normalized);

    let resolve!: (result: InspectionScheduleResult<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<InspectionScheduleResult<T>>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry: QueueEntry<T> = {
      request: normalized,
      run,
      promise,
      resolve,
      reject,
      state: 'queued',
      preempted: false,
      preemptCount: 0,
      superseded: false,
    };

    this.enqueue(entry);
    if (
      normalized.priority === 'interactive' &&
      this.active?.request.priority === 'background'
    ) {
      this.preempt(this.active);
    }
    this.pump();
    return promise;
  }

  public cancelDocument(documentUri: string): void {
    for (const entry of [...this.queue]) {
      if (entry.request.documentUri === documentUri) {
        this.supersede(entry);
      }
    }
    if (this.active?.request.documentUri === documentUri) {
      this.supersede(this.active);
    }
  }

  public cancelAll(): void {
    for (const entry of [...this.queue]) this.supersede(entry);
    if (this.active) this.supersede(this.active);
  }

  private findEquivalent(request: InspectionJob): QueueEntry<T> | undefined {
    return [this.active, ...this.queue].find((entry) =>
      entry !== undefined &&
      !entry.superseded &&
      entry.request.documentUri === request.documentUri &&
      entry.request.sourceVersion === request.sourceVersion &&
      entry.request.priority === request.priority &&
      sameTargets(entry.request.targetIds, request.targetIds)
    );
  }

  private supersedeObsolete(request: InspectionJob): void {
    const candidates = [this.active, ...this.queue];
    for (const entry of candidates) {
      if (!entry || entry.superseded) continue;
      const sameDocument = entry.request.documentUri === request.documentUri;
      if (!sameDocument) continue;

      const obsoleteVersion = entry.request.sourceVersion !== request.sourceVersion;
      const obsoleteHover =
        request.priority === 'interactive' &&
        entry.request.priority === 'interactive' &&
        !sameTargets(entry.request.targetIds, request.targetIds);
      if (obsoleteVersion || obsoleteHover) this.supersede(entry);
    }
  }

  private enqueue(entry: QueueEntry<T>): void {
    entry.state = 'queued';
    if (entry.request.priority === 'interactive') {
      const firstBackground = this.queue.findIndex(
        (candidate) => candidate.request.priority === 'background',
      );
      if (firstBackground >= 0) {
        this.queue.splice(firstBackground, 0, entry);
        return;
      }
    }
    this.queue.push(entry);
  }

  private preempt(entry: QueueEntry<T>): void {
    if (entry.state !== 'running' || entry.preempted || entry.superseded) return;
    if (entry.preemptCount >= MAX_PREEMPTIONS) return;
    entry.preempted = true;
    entry.preemptCount += 1;
    entry.controller?.abort('Preempted by interactive inspection');
  }

  private supersede(entry: QueueEntry<T>): void {
    if (entry.superseded || entry.state === 'settled') return;
    entry.superseded = true;
    if (entry.state === 'queued') {
      const index = this.queue.indexOf(entry);
      if (index >= 0) this.queue.splice(index, 1);
      entry.state = 'settled';
    } else {
      entry.controller?.abort('Superseded inspection');
    }
    entry.resolve({ status: 'superseded' });
  }

  private pump(): void {
    if (this.active) return;
    const next = this.queue.shift();
    if (!next) return;
    if (next.superseded) {
      this.pump();
      return;
    }
    this.active = next;
    next.state = 'running';
    next.preempted = false;
    next.controller = new AbortController();
    void this.runActive(next);
  }

  private async runActive(entry: QueueEntry<T>): Promise<void> {
    try {
      const value = await entry.run(entry.controller!.signal);
      if (entry.superseded) return;
      if (entry.preempted) {
        this.enqueue(entry);
        return;
      }
      entry.state = 'settled';
      entry.resolve({ status: 'completed', value });
    } catch (error) {
      if (entry.superseded) return;
      if (entry.preempted) {
        this.enqueue(entry);
        return;
      }
      entry.state = 'settled';
      entry.reject(error);
    } finally {
      if (this.active === entry) this.active = undefined;
      this.pump();
    }
  }
}

function normalizedRequest(request: InspectionJob): InspectionJob {
  return {
    ...request,
    targetIds: [...new Set(request.targetIds)].sort(),
  };
}

function sameTargets(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((target) => rightSet.has(target));
}
