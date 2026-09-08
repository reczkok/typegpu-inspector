import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { InspectionTarget, InspectorSelector, ProbeArgumentPlanEntry } from './discovery.js';

type Context = NonNullable<Extract<InspectorSelector, { selector: string }>['context']>;

/** An explicit fixture is validated before launching the runtime, never guessed from source. */
export async function applyInspectionFixture(file: string, modulePath: string, targets: InspectionTarget[], available = targets, allowOtherModule = false): Promise<{
  setupBody?: string;
  targets: InspectionTarget[];
}> {
  const data: unknown = JSON.parse(await readFile(file, 'utf8'));
  const fail = (detail: string): never => { throw new Error(`Invalid inspection fixture ${file}: ${detail}`); };
  if (!record(data)) return fail('expected an object.');
  if (allowOtherModule && typeof data.module === 'string' && resolve(dirname(file), data.module) !== resolve(modulePath)) return { targets };
  if (typeof data.module !== 'string' || resolve(dirname(file), data.module) !== resolve(modulePath)) {
    return fail('module must name the inspected file, relative to this fixture. Select that file explicitly.');
  }
  for (const key of Object.keys(data)) if (!['module', 'setupBody', 'targets'].includes(key)) fail(`unknown field ${key}.`);
  if (data.setupBody !== undefined && typeof data.setupBody !== 'string') fail('setupBody must be a string.');
  if (!record(data.targets)) return fail('targets must map shader names to inspection contexts.');
  const configured = new Map<string, { context: Context; instance?: number; usage?: number; member?: string[] }>();
  for (const [name, value] of Object.entries(data.targets)) {
    if (!available.some(target => target.label === name || target.symbolNames.includes(name))) fail(`unknown target ${name}.`);
    if (!record(value)) return fail(`${name} must be an object.`);
    for (const key of Object.keys(value)) if (!['label', 'instance', 'usage', 'member', 'arguments', 'with'].includes(key)) fail(`${name}: unknown field ${key}.`);
    if (value.member !== undefined && (!Array.isArray(value.member) || !value.member.every(key => typeof key === 'string'))) fail(`${name}.member must be an array of property names.`);
    if (value.label !== undefined && typeof value.label !== 'string') fail(`${name}.label must be a string.`);
    if (value.instance !== undefined && (!Number.isSafeInteger(value.instance) || (value.instance as number) < 0)) fail(`${name}.instance must be a nonnegative integer.`);
    if (value.usage !== undefined && (!Number.isSafeInteger(value.usage) || (value.usage as number) < 0)) fail(`${name}.usage must be a nonnegative integer.`);
    if (value.arguments !== undefined && (!Array.isArray(value.arguments) || !value.arguments.every(argument =>
      record(argument) && Object.keys(argument).length === 1 &&
      Object.entries(argument).every(([key, selector]) => ['schema', 'refSchema', 'value'].includes(key) && nonempty(selector))))) {
      fail(`${name}.arguments must contain schema, refSchema, or value selectors.`);
    }
    if (value.with !== undefined && (!Array.isArray(value.with) || !value.with.every(binding =>
      record(binding) && Object.keys(binding).length === 2 && nonempty(binding.slot) && nonempty(binding.value)))) {
      fail(`${name}.with must contain slot/value selector pairs.`);
    }
    configured.set(name, {
      context: {
        ...(typeof value.label === 'string' ? { label: value.label } : {}),
        ...(value.arguments !== undefined ? { arguments: value.arguments as ProbeArgumentPlanEntry[] } : {}),
        ...(value.with !== undefined ? { with: value.with as Array<{ slot: string; value: string }> } : {}),
      },
      ...(value.member !== undefined ? { member: value.member as string[] } : {}),
      ...(typeof value.instance === 'number' ? { instance: value.instance } : {}),
      ...(typeof value.usage === 'number' ? { usage: value.usage } : {}),
    });
  }
  const result = targets.map(target => {
    const matches = [...configured].filter(([name]) => name === target.label || target.symbolNames.includes(name));
    if (matches.length === 0) return target;
    if (matches.length > 1) return fail(`${target.label} matches multiple contexts; configure it once.`);
    if (!('selector' in target.selector)) return fail(`${target.label} is a generated pipeline; select a helper or an authored pipeline instead.`);
    const settings = matches[0]![1];
    if (settings.member !== undefined && !target.selector.inspectMembers) return fail(`${target.label} is not a factory result.`);
    if (settings.instance !== undefined && target.selector.declaration === undefined) return fail(`${target.label} is not a nested declaration.`);
    if (settings.usage !== undefined && settings.context.with !== undefined) return fail(`${target.label}: usage and explicit bindings are mutually exclusive.`);
    const selector: Extract<InspectorSelector, { selector: string }> = { ...target.selector, ...settings };
    if ((settings.usage !== undefined || settings.member !== undefined) && Object.keys(settings.context).length === 0) delete selector.context;
    return { ...target, selector };
  });
  // Contexts may cover other targets in this module when -t narrows the check.
  return { targets: result, ...(typeof data.setupBody === 'string' ? { setupBody: data.setupBody } : {}) };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
