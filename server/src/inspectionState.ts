import type {
  DiscoveredModule,
  InspectionTarget,
} from './discovery.js';

export function selectInspectionTargets(
  discovered: DiscoveredModule,
  targetIds: readonly string[],
): InspectionTarget[] {
  const requested = new Set(targetIds);
  return discovered.targets.filter((target) => requested.has(target.id));
}

type ProgressEntry = {
  documentUri: string;
  sourceVersion: number;
  targetIds: readonly string[];
};

/** Tracks overlapping save and hover requests without clearing shared targets early. */
export class InspectionProgress {
  private nextToken = 1;
  private readonly entries = new Map<number, ProgressEntry>();

  public begin(
    documentUri: string,
    sourceVersion: number,
    targetIds: readonly string[],
  ): number {
    const token = this.nextToken++;
    this.entries.set(token, {
      documentUri,
      sourceVersion,
      targetIds: [...new Set(targetIds)],
    });
    return token;
  }

  public finish(token: number): void {
    this.entries.delete(token);
  }

  public clearDocument(documentUri: string): void {
    for (const [token, entry] of this.entries) {
      if (entry.documentUri === documentUri) this.entries.delete(token);
    }
  }

  public targets(
    documentUri: string,
    sourceVersion: number,
  ): ReadonlySet<string> {
    const targets = new Set<string>();
    for (const entry of this.entries.values()) {
      if (
        entry.documentUri === documentUri &&
        entry.sourceVersion === sourceVersion
      ) {
        for (const targetId of entry.targetIds) targets.add(targetId);
      }
    }
    return targets;
  }
}
