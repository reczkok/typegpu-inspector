import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { discoverTypeGpuModule } from '../server/src/discovery.ts';

// All source projects remain inputs. Manifests, baselines, and reports live in the output directory.
const [mode, directory = '.local/stress', variant = 'current'] = process.argv.slice(2);
const output = resolve(directory);
const json = (name: string) => JSON.parse(readFileSync(join(output, name), 'utf8'));
const save = (name: string, value: unknown) => writeFileSync(join(output, name), JSON.stringify(value, null, 2));
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
mkdirSync(output, { recursive: true });
if (mode === 'plan') {
  const projects = json('ready-projects.json') as Array<{ cwd: string; version: string }>;
  const before = await import(pathToFileURL(join(output, 'before-factories/server/src/discovery.ts')).href);
  const files = new Map<string, string>();
  for (const project of projects.sort((a, b) => a.cwd.length - b.cwd.length)) {
    const listed = execFileSync('rg', ['--files', '-g', '*.{ts,tsx,js,jsx,mts}', '-g', '!node_modules', '-g', '!dist', '-g', '!build', '-g', '!vendor', '-g', '!coverage', '-g', '!*.test.*', '-g', '!*.spec.*', '-g', '!*.d.ts', '-g', '!*.tsnotover.*', '-g', '!test', '-g', '!tests', project.cwd], { maxBuffer: 32 * 1024 * 1024 }).toString().trim().split('\n');
    for (const path of listed) {
      if (!path || (project.cwd.endsWith('/typegpu-docs') && !path.includes('/src/examples/'))) continue;
      files.set(path, project.cwd);
    }
  }
  const inventory: unknown[] = [];
  const cases: unknown[] = [];
  for (const [file, cwd] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const source = readFileSync(file, 'utf8');
    if (source.length > 500_000 || !/typegpu|use gpu/.test(source)) continue;
    let now; let old;
    try { now = discoverTypeGpuModule(file, source); } catch (error) {
      inventory.push({ file, cwd, crash: String(error), missing: [] }); console.log(`DISCOVERY CRASH ${file}: ${error}`); continue;
    }
    try { old = before.discoverTypeGpuModule(file, source); } catch (error) { old = { symbols: [], targets: [] }; }
    const targets = now.targets.filter(t => t.selector.kind !== 'resource');
    const previous = old.targets.filter((t: any) => t.selector.kind !== 'resource');
    const missing = old.symbols.filter((s: any) => s.targetIds.length && !now.symbols.some(n => n.name === s.name && n.targetIds.length)).map((s: any) => ({ name: s.name, role: s.role }));
    inventory.push({ file, cwd, sourceHash: hash(source), targets: targets.length, previousTargets: previous.length, missing, symbols: now.symbols.length });
    if (!targets.length && !previous.length) continue;
    const name = relative('/Users/konradreczko/Projects', file).replace(/[^\w.-]+/g, '_');
    cases.push({ name, cwd, modulePath: file, sourceHash: hash(source), targets: targets.map(t => t.selector), previous: previous.map((t: any) => t.selector) });
  }
  save('inventory.json', inventory); save('cases.json', cases);
  console.log(JSON.stringify({ packages: projects.length, files: inventory.length, cases: cases.length, disappeared: inventory.filter((x: any) => x.missing.length) }, null, 2));
} else if (mode === 'run') {
  const released = variant.startsWith('released');
  const base = released ? join(output, 'released/inspector/src') : resolve(import.meta.dirname, '../inspector/src');
  const { inspectTypegpuSymbols } = await import(pathToFileURL(join(base, 'inspect.ts')).href);
  const { closeAllInspectorSessions } = await import(pathToFileURL(join(base, 'inspect/session.ts')).href);
  const { closeSharedBrowser } = await import(pathToFileURL(join(base, 'inspect/browser.ts')).href);
  const cases = json(process.env.STRESS_MANIFEST ?? 'selected.json');
  const releasedDiscovery = released ? (await import(pathToFileURL(join(output, 'released/server/src/discovery.ts')).href)).discoverTypeGpuModule : undefined;
  const summary: unknown[] = [];
  try {
    for (const [index, entry] of cases.entries()) {
      const folder = join(output, variant, entry.name); mkdirSync(folder, { recursive: true });
      const path = join(folder, 'report.json');
      const start = performance.now();
      const watchdog = process.env.STRESS_WATCHDOG_MS ? setTimeout(() => { console.error(`HARNESS TIMEOUT ${entry.name}`); process.exit(2); }, Number(process.env.STRESS_WATCHDOG_MS)) : undefined;
      watchdog?.unref();
      let report: any;
      if (existsSync(path) && !process.env.STRESS_FRESH) report = JSON.parse(readFileSync(path, 'utf8'));
      else {
        try {
          if (hash(readFileSync(entry.modulePath, 'utf8')) !== entry.sourceHash) throw new Error('Source changed since manifest creation');
          const targets = releasedDiscovery ? releasedDiscovery(entry.modulePath, readFileSync(entry.modulePath, 'utf8')).targets.filter((t: any) => t.selector.kind !== 'resource').map((t: any) => t.selector) : variant.startsWith('previous') ? entry.previous : entry.targets;
          if (!targets.length) { report = { ok: true, targets: [] }; } else
          report = await inspectTypegpuSymbols({ cwd: entry.cwd, modulePath: entry.modulePath, targets,
            includePrivate: true, reuseBrowser: true, timeoutMs: 20_000, ...(entry.options ?? {}) }, { addDirectSymbolDiagnostic: false });
        } catch (error) { report = { ok: false, error: String(error), targets: [] }; }
        writeFileSync(path, JSON.stringify(report, null, 2));
      }
      const row = { name: entry.name, elapsedMs: Math.round(performance.now() - start), error: report.error,
        targets: report.targets.map((t: any) => ({ label: t.label, parentLabel: t.parentLabel, kind: t.kind, outcome: t.outcome,
          wgslHash: t.wgsl ? hash(t.wgsl) : undefined, bytes: t.wgsl?.length ?? 0, context: t.context,
          codes: t.diagnostics?.map((d: any) => d.code), error: t.error, compilationErrors: t.compilationMessages?.filter((m: any) => m.type === 'error') })) };
      summary.push(row); save(`${variant}-summary.json`, summary);
      console.log(`${index + 1}/${cases.length} ${entry.name}: ${row.targets.filter((t: any) => t.outcome?.startsWith('passed')).length}/${row.targets.length} passed${row.error ? ` ${row.error}` : ''}`);
      // Isolate each module's device/root lifetime; reuse the browser process only.
      await closeAllInspectorSessions();
      if (watchdog) clearTimeout(watchdog);
    }
  } finally { await closeAllInspectorSessions(); await closeSharedBrowser(); }
} else throw new Error('Usage: stress-projects.mts plan|run <output-directory> [current|previous|released]');
