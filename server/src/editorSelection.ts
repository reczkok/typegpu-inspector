import { targetSelectionKey, type TargetRef, type TargetsResponse } from './editorProtocol.js';

/** One explicit choice per declaration. Missing choices never switch to another instance. */
export class EditorSelection {
  private readonly choices = new Map<string, string>();

  select(uri: string, snapshot: TargetsResponse, targetId: string): void {
    const target = snapshot.targets.find(entry => entry.id === targetId);
    if (!target) return;
    for (const symbol of snapshot.symbols.filter(entry => entry.targetIds.includes(targetId))) {
      this.choices.set(JSON.stringify([uri, symbol.name]), targetSelectionKey(target));
    }
  }

  resolve(uri: string, snapshot: TargetsResponse, symbol: TargetsResponse['symbols'][number]): TargetRef | undefined {
    const choice = this.choices.get(JSON.stringify([uri, symbol.name]));
    if (choice) {
      const matches = snapshot.targets.filter(entry => symbol.targetIds.includes(entry.id) && targetSelectionKey(entry) === choice);
      const target = matches.length === 1 ? matches[0] : undefined;
      // A removed or renamed specialization requires another explicit choice.
      return target && symbol.targetIds.includes(target.id) ? { uri, targetId: target.id, targetKey: choice } : undefined;
    }
    const shaders = symbol.targetIds.filter(id => snapshot.targets.find(target => target.id === id)?.kind !== 'resource');
    const target = snapshot.targets.find(entry => entry.id === shaders[0]);
    return shaders.length === 1 && target ? { uri, targetId: target.id, targetKey: targetSelectionKey(target) } : undefined;
  }
}
