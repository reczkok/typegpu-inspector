import type { InspectionTargetKind } from '../types.ts';
import { TargetDiagnosticError } from './diagnostics.ts';
import { resultMemberKind } from './typegpuIntrospection.ts';

type Member = { value?: unknown; path: string[]; kind?: InspectionTargetKind; error?: unknown };
const objectLike = (value: unknown): value is object => value !== null && (typeof value === 'object' || typeof value === 'function');

function failure(path: string[], message: string): Member {
  return { path, error: new TargetDiagnosticError(message, [{ code: 'selector-not-resolved', severity: 'error', message }]) };
}

/** Enumerate actual values; aliases keep their paths and identity, cycles terminate. */
export function selectResultMembers(root: unknown, selected?: string[]): Member[] {
  if (selected) {
    let value = root;
    for (const key of selected) {
      if (!objectLike(value)) return [failure(selected, 'Result member no longer exists. Reinspect the factory result.')];
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) return [failure(selected, 'Result member is missing or is an accessor. Getters are not evaluated; expose a data property in setup instead.')];
      value = descriptor.value;
    }
    const kind = objectLike(value) ? resultMemberKind(value) : undefined;
    return [kind ? { value, path: selected, kind } : failure(selected, 'Selected result member is not an inspectable shader or resource. Reinspect the factory result.')];
  }
  const members: Member[] = [];
  const ancestors = new Set<object>();
  let visited = 0;
  let exhausted = false;
  const visit = (value: unknown, path: string[]) => {
    if (exhausted) return;
    if (++visited > 2048 || members.length >= 128) {
      exhausted = true;
      members.push(failure(path, 'Factory result traversal limit reached (2048 values, 128 targets). Select a smaller result in setup.'));
      return;
    }
    if (!objectLike(value)) return;
    const kind = resultMemberKind(value);
    if (kind) { members.push({ value, path, kind }); return; }
    if (typeof value === 'function' || ancestors.has(value)) return;
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return;
    if (path.length >= 12) { members.push(failure(path, 'Factory result nesting exceeds 12 levels. Select a smaller result in setup.')); return; }
    ancestors.add(value);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable) continue;
      if ('value' in descriptor) visit(descriptor.value, [...path, key]);
      else if (!exhausted) {
        if (++visited > 2048 || members.length >= 128) {
          exhausted = true;
          members.push(failure([...path, key], 'Factory result traversal limit reached. Select a smaller result in setup.'));
        } else members.push(failure([...path, key], 'Getter skipped while inspecting a factory result. Expose its value as a data property in setup to inspect it.'));
      }
      if (exhausted) break;
    }
    ancestors.delete(value);
  };
  visit(root, []);
  return members.length ? members : [failure([], 'This result contains no inspectable shader or resource values. Uncalled factories require explicit setup.')];
}

export function resultMemberLabel(label: string, path: string[]): string {
  return label + path.map(key => /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`).join('');
}
