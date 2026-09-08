import { describe, expect, it } from 'vitest';
import { EditorSelection } from '../src/editorSelection.js';
import { findEditorTarget, targetStatusLabel, targetSelectionKey, type TargetsResponse } from '../src/editorProtocol.js';

function snapshot(offset = 40): TargetsResponse {
  const targets = [0, 1].map(instance => ({
    id: `nested:${offset}:instance:${instance}`, label: `makeBlur.helper [instance ${instance}]`,
    context: { instance }, status: 'ok' as const,
  }));
  return {
    version: 1, stale: false, targets,
    symbols: [{ name: 'makeBlur.helper', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } }, targetIds: targets.map(target => target.id) }],
  };
}

describe('editor specialization selection', () => {
  it('requires a choice for multiple instances, retains it across offset changes and reordering', () => {
    const selection = new EditorSelection();
    const before = snapshot();
    expect(selection.resolve('file:///shader.ts', before, before.symbols[0]!)).toBeUndefined();
    selection.select('file:///shader.ts', before, before.targets[1]!.id);
    const after = snapshot(80);
    after.targets.reverse();
    expect(selection.resolve('file:///shader.ts', after, after.symbols[0]!)?.targetId).toBe('nested:80:instance:1');
  });

  it('does not substitute a surviving instance for a removed selection', () => {
    const selection = new EditorSelection();
    const state = snapshot();
    selection.select('file:///shader.ts', state, state.targets[1]!.id);
    state.targets.pop(); state.symbols[0]!.targetIds.pop();
    expect(selection.resolve('file:///shader.ts', state, state.symbols[0]!)).toBeUndefined();
    // Choices in another file are independent.
    expect(selection.resolve('file:///other.ts', state, state.symbols[0]!)?.targetId).toBe(state.targets[0]!.id);
  });

  it('resolves pinned references after offsets change and rejects ambiguous identities', () => {
    const before = snapshot();
    const ref = { targetId: before.targets[1]!.id, targetKey: targetSelectionKey(before.targets[1]!) };
    const after = snapshot(90);
    expect(findEditorTarget(after, ref)?.id).toBe('nested:90:instance:1');
    after.targets.push({ ...after.targets[1]!, id: 'duplicate' });
    expect(findEditorTarget(after, ref)).toBeUndefined();
  });

  it('requires reselection when an explicit context changes', () => {
    const selection = new EditorSelection();
    const state = snapshot();
    selection.select('file:///shader.ts', state, state.targets[1]!.id);
    state.targets[1]!.context!.instance = 2;
    expect(selection.resolve('file:///shader.ts', state, state.symbols[0]!)).toBeUndefined();
  });
});


it('distinguishes missing context from an environmental block', () => {
  expect(targetStatusLabel({ status: 'failed', outcome: 'blocked', diagnostics: [{ code: 'slot-binding-required', message: 'Supply color' }] })).toBe('Needs context');
  expect(targetStatusLabel({ status: 'failed', outcome: 'blocked', diagnostics: [{ code: 'device-lost', message: 'Device lost' }] })).toBe('Blocked');
});
