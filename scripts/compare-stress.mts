import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const [directory = '.local/stress', baseline = 'released', current = 'current'] = process.argv.slice(2);
const folder = resolve(directory);
const read = (name: string) => JSON.parse(readFileSync(join(folder, name), 'utf8'));
const old = read(`${baseline}-summary.json`), next = read(`${current}-summary.json`);
const modules = new Map(next.map((entry: any) => [entry.name, entry]));
const family = (target: any) => {
  const label = target.context?.resultPath !== undefined
    ? `${target.parentLabel ?? target.label}${target.context.resultPath.map((key: string) => `.${key}`).join('')}`
    : target.parentLabel ?? target.label.replace(/ \[usage \d+\]$/, '');
  return label.replace(/^.*? → /, '').replace(/\(call \d+:\d+\)$/, '');
};
const passing = (target: any) => target.outcome === 'passed' || target.outcome === 'passed-with-assumptions';
const results = { modules: 0, preserved: 0, identical: 0, changed: [] as any[], regressions: [] as any[], missing: [] as any[], sourceOrRunErrors: [] as any[] };
for (const entry of old) {
  const compared: any = modules.get(entry.name);
  if (!compared) { results.sourceOrRunErrors.push({ module: entry.name, error: 'No comparison run' }); continue; }
  results.modules++;
  if (entry.error || compared.error) { results.sourceOrRunErrors.push({ module: entry.name, baseline: entry.error, current: compared.error }); continue; }
  for (const target of entry.targets.filter(passing)) {
    const candidates = compared.targets.filter((candidate: any) => family(candidate) === family(target));
    const passed = candidates.filter(passing);
    const id = { module: entry.name, target: target.label };
    if (!candidates.length) results.missing.push(id);
    else if (!passed.length) results.regressions.push({ ...id, results: candidates });
    else {
      results.preserved++;
      if (passed.some((candidate: any) => candidate.wgslHash === target.wgslHash)) results.identical++;
      else results.changed.push({ ...id, before: target.wgslHash, after: passed.map((candidate: any) => ({ label: candidate.label, hash: candidate.wgslHash })) });
    }
  }
}
writeFileSync(join(folder, `comparison-${baseline}-${current}.json`), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
if (results.missing.length || results.regressions.length || results.sourceOrRunErrors.length) process.exitCode = 1;
