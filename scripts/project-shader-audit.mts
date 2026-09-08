import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { discoverTypeGpuModule } from '../server/src/discovery.ts';
import { inspectTypegpuSymbols } from '../inspector/src/inspect.ts';
import { closeAllInspectorSessions } from '../inspector/src/inspect/session.ts';
import { closeSharedBrowser } from '../inspector/src/inspect/browser.ts';
import type { InspectTypegpuSymbolsInput } from '../inspector/src/types.ts';

// Use installed project dependencies and the local inspector API. External
// projects are inputs; reports and WGSL go only to the supplied output folder.
type Case = Omit<InspectTypegpuSymbolsInput, 'targets'> & {
  name: string;
  select?: string[];
  targets?: InspectTypegpuSymbolsInput['targets'];
};
const [manifest, destination] = process.argv.slice(2);
if (!manifest || !destination) throw new Error('Usage: project-shader-audit.mts <cases.json> <output-directory>');
const cases: Case[] = JSON.parse(await readFile(resolve(manifest), 'utf8'));
const output = resolve(destination);
await mkdir(output, { recursive: true });
const results: unknown[] = [];
try {
  for (const { name, select, ...input } of cases) {
    const modulePath = resolve(input.cwd ?? dirname(resolve(manifest)), input.modulePath);
    const source = await readFile(modulePath, 'utf8');
    const discovered = discoverTypeGpuModule(modulePath, source);
    const targets = input.targets ?? discovered.targets.filter(target =>
      select ? select.includes(target.label) : target.selector.kind !== 'resource').map(target => target.selector);
    if (!targets.length) throw new Error(`No shader targets selected for ${name}`);
    console.log(`Inspecting ${name}: ${targets.length} declarations`);
    const started = performance.now();
    try {
      const report = await inspectTypegpuSymbols({ ...input, modulePath, targets,
        includePrivate: true, reuseBrowser: true, timeoutMs: input.timeoutMs ?? 45_000,
      }, { addDirectSymbolDiagnostic: false });
      const folder = resolve(output, name.replace(/[^a-zA-Z0-9_-]/g, '_'));
      await mkdir(folder, { recursive: true });
      await writeFile(resolve(folder, 'report.json'), JSON.stringify(report, null, 2));
      for (const [index, target] of report.targets.entries()) {
        if (target.wgsl) await writeFile(resolve(folder, `${index}.wgsl`), target.wgsl);
      }
      const summary = { name, elapsedMs: Math.round(performance.now() - started),
        targets: report.targets.map(target => ({ label: target.label, outcome: target.outcome,
          wgslBytes: target.wgsl?.length ?? 0, context: target.context,
          errors: target.compilationMessages.filter(message => message.type === 'error'),
          diagnostics: target.diagnostics?.filter(diagnostic => diagnostic.severity !== 'note'),
          error: target.error,
        })),
      };
      results.push(summary);
      console.log(`${name}: ${summary.targets.map(t => `${t.label}=${t.outcome} (${t.wgslBytes} WGSL bytes)`).join(', ')}`);
    } catch (error) {
      results.push({ name, error: String(error) });
      console.log(`${name}: ${error}`);
    }
    await writeFile(resolve(output, 'summary.json'), JSON.stringify(results, null, 2));
  }
} finally {
  await closeAllInspectorSessions();
  await closeSharedBrowser();
}
