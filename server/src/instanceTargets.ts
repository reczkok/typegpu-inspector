import type { DiscoveredModule, InspectionTarget } from './discovery.js';
import type { InspectorTargetReport } from './protocol.js';

/** Turn one nested declaration into independently addressable generated shader contexts. */
export function expandInstanceTargets(
  discovered: DiscoveredModule,
  reports: readonly InspectorTargetReport[],
  requested?: readonly string[],
): string[] {
  const replacements = new Map<string, InspectionTarget[]>();
  for (const target of discovered.targets) {
    if (target.instanceParentId || !('selector' in target.selector)) continue;
    const selector = target.selector;
    const instances = reports.filter(report => report.parentLabel === target.label && (report.context?.instance !== undefined || report.context?.usage !== undefined || report.context?.resultPath !== undefined));
    if (instances.length === 0) continue;
    replacements.set(target.id, instances.map(report => ({
      ...target,
      symbolNames: [...new Set([...target.symbolNames, ...discovered.symbols.filter(symbol => report.context?.pipelineStages?.includes(symbol.runtimeName ?? symbol.name)).map(symbol => symbol.name)])],
      instanceParentId: target.id,
      id: `${target.id}${report.context!.resultPath !== undefined ? `:member:${JSON.stringify(report.context!.resultPath)}` : ''}${report.context!.instance !== undefined ? `:instance:${report.context!.instance}` : ''}${report.context!.usage !== undefined ? `:usage:${report.context!.usage}` : ''}`,
      label: report.label,
      selector: { ...selector, ...(report.context!.resultPath !== undefined ? { member: report.context!.resultPath, kind: report.kind === 'compute-pipeline' || report.kind === 'render-pipeline' || report.kind === 'resource' ? report.kind : 'resolvable' as const } : {}), label: report.label, ...(report.context!.instance !== undefined ? { instance: report.context!.instance } : {}), ...(report.context!.usage !== undefined ? { usage: report.context!.usage } : {}) },
    })));
  }
  const expand = (ids: readonly string[]) => ids.flatMap(id => replacements.get(id)?.map(t => t.id) ?? [id]);
  const selected = expand(requested ?? discovered.targets.map(t => t.id));
  discovered.targets = discovered.targets.flatMap(target => replacements.get(target.id) ?? [target]);
  for (const symbol of discovered.symbols) symbol.targetIds = [...new Set([...expand(symbol.targetIds), ...discovered.targets.filter(target => target.symbolNames.includes(symbol.name)).map(target => target.id)])];
  return selected;
}
