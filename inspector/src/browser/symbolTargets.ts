import { selectResultMembers, resultMemberLabel } from './resultTargets.ts';
import { TargetDiagnosticError } from './diagnostics.ts';
import type { ShaderInspectionContext, TypegpuSymbolTarget } from '../types.ts';
import type { RecordedBindingRegistry } from './engine/types.ts';
import type { TypeGpuInspectionTarget } from './targetInspector.ts';
import { overlayScope, selectInstances } from './symbolRegistry.ts';
import { createComputePipeline, createRenderPipeline, readSelector } from './symbolRuntime.ts';

type Scope = Record<string, unknown>;
type Plan = TypegpuSymbolTarget & { label: string };
type Probe = (value: unknown, module: Scope, roots: Scope) => Pick<TypeGpuInspectionTarget, 'value' | 'ledger'>;
type Environment = {
  modulePath: string;
  sourceRevision: string;
  inspectedModule: Scope;
  roots: Scope;
  ctx: {
    root: Parameters<typeof createComputePipeline>[0];
    tgpu: Parameters<typeof createRenderPipeline>[1];
    d: Parameters<typeof createRenderPipeline>[2];
  };
};

/** Ordinary runtime code owns selection, context, and errors. Only probes contain generated TGSL. */
export function prepareSymbolTargets(
  plans: Plan[],
  probes: Array<Probe | null>,
  environment: Environment,
): TypeGpuInspectionTarget[] {
  const targets: TypeGpuInspectionTarget[] = [];
  const { modulePath, sourceRevision, inspectedModule, roots } = environment;
  for (const [index, plan] of plans.entries()) {
    const selector = 'selector' in plan ? plan : undefined;
    const context: ShaderInspectionContext = {
      ...selector?.context, modulePath, sourceRevision,
      ...(!selector?.context && selector?.probeContext ? { probe: selector.probeContext } : {}),
      ...(selector?.declaration !== undefined ? { declaration: selector.declaration } : {}),
      ...(selector?.instance !== undefined ? { instance: selector.instance } : {}),
    };
    const base = { label: plan.label, kind: plan.kind, context };
    try {
      if (!selector) {
        targets.push({ ...base, ...preparePipeline(plan, index, environment) });
        continue;
      }
      if (selector.usage !== undefined && selector.context?.with !== undefined) throw new TargetDiagnosticError(
        'Usage selection and explicit bindings are mutually exclusive.',
        [{ code: 'selector-not-resolved', severity: 'error', message: 'Choose either a usage index or explicit context.with bindings.' }],
      );
      const candidates = selector.declaration === undefined
        ? [{ value: readSelector(inspectedModule, selector.selector, `targets[${index}].selector`, roots) }]
        : selectInstances(modulePath, selector.declaration, selector.instance);
      for (const candidate of candidates) {
        const members = selector.inspectMembers || selector.member !== undefined
          ? selectResultMembers(candidate.value, selector.member) : [{ value: candidate.value }];
        for (const member of members) {
          const resultPath = 'path' in member ? member.path : undefined;
          const captured = 'instance' in candidate;
          const expand = captured && selector.instance === undefined;
          const label = expand ? `${plan.label} [instance ${candidate.instance}]` : plan.label;
          const target: TypeGpuInspectionTarget = {
            ...base, unwrap: selector.unwrap, subject: member.value, usage: selector.usage,
            ...(expand ? { parentLabel: plan.label, label } : {}),
            ...(resultPath !== undefined ? { kind: 'kind' in member ? member.kind : plan.kind, parentLabel: plan.label, label: selector.member !== undefined ? label : resultMemberLabel(label, resultPath) } : {}),
            context: { ...context, ...(resultPath !== undefined ? { resultPath, pipelineStages: observedPipelineStages(member.value, inspectedModule) } : {}), ...(captured ? { instance: candidate.instance, captured: candidate.captured } : {}) },
            ...(captured || selector.context ? { autoBind: false } : {}),
          };
          try {
            if ('error' in member && member.error) throw member.error;
            if (resultPath !== undefined && selector.member === undefined && (selector.context?.arguments || selector.context?.with)) throw new TargetDiagnosticError(
              'Select a member before supplying its specialization context.', [{ code: 'selector-not-resolved', severity: 'error', message: 'Set member to the exact result path before supplying arguments or bindings.' }]);
            if (context.probe?.missing?.length) {
              const missing = context.probe.missing;
              throw new TargetDiagnosticError('Helper arguments require an inspection context.', [{
                code: 'wrapper-required', severity: 'error',
                message: `Missing inspection arguments: ${missing.map(input => input.parameter).join(', ')}.`,
                hint: missing.map(input => `${input.parameter} (argument ${input.index + 1}): ${input.reason}`).join(' '),
              }]);
            }
            const module = captured ? overlayScope(inspectedModule, candidate.scope) : inspectedModule;
            const scope = captured ? overlayScope(roots, candidate.scope, { module, inspectedModule: module }) : roots;
            Object.assign(target, probes[index]?.(member.value, module, scope) ?? { value: member.value });
            if (selector.context && selector.usage === undefined) {
              target.bindings = (selector.context.with ?? []).map(binding => [
                readSelector(module, binding.slot, 'context slot', scope),
                readSelector(module, binding.value, 'context value', scope),
              ]);
            }
          } catch (error) {
            target.error = error;
          }
          targets.push(target);
        }
      }
    } catch (error) {
      targets.push({ ...base, error });
    }
  }
  return targets;
}

function preparePipeline(plan: Plan, index: number, environment: Environment): Partial<TypeGpuInspectionTarget> {
  if ('selector' in plan) throw new Error('Expected a pipeline descriptor.');
  const { ctx: { root, tgpu, d }, inspectedModule, roots } = environment;
  const label = `targets[${index}]`;
  const read = (selector: string, field: string) => readSelector(inspectedModule, selector, `${label}.${field}`, roots);
  const bindings = plan.with ?? [];
  const descriptor = plan.descriptor ?? {};
  if (plan.kind === 'compute-pipeline') {
    return createComputePipeline(root, inspectedModule, bindings, roots, label, descriptor, read(plan.compute, 'compute'));
  }
  const attribs = typeof plan.attribs === 'string'
    ? read(plan.attribs, 'attribs')
    : plan.attribs && Object.fromEntries(Object.entries(plan.attribs).map(([key, selector]) =>
      [key, read(selector, `attribs.${key}`)]));
  return createRenderPipeline(root, tgpu, d, inspectedModule, bindings, roots, label,
    descriptor, read(plan.vertex, 'vertex'),
    plan.fragment === undefined ? undefined : read(plan.fragment, 'fragment'),
    attribs, plan.synthesizeMissing ?? true);
}

/** Stage associations come from the recorded descriptor and original object identities. */
function observedPipelineStages(value: unknown, module: Scope): string[] {
  const recorded = (globalThis as { __typegpuMcpRecording?: RecordedBindingRegistry }).__typegpuMcpRecording;
  const descriptor = recorded?.pipelines?.find(entry => entry.pipeline === value)?.descriptor as { compute?: unknown; vertex?: unknown; fragment?: unknown } | undefined;
  if (!descriptor) return [];
  const stages = [descriptor.compute, descriptor.vertex, descriptor.fragment].filter(Boolean);
  const names: string[] = [];
  for (const name in module) {
    try { if (stages.includes(module[name])) names.push(name); } catch { /* An unrelated binding can be in the TDZ. */ }
  }
  return names;
}
