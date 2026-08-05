import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { discoverTypeGpuModule } from '../server/src/discovery.ts';
import { inspectTypegpuSymbols } from '../inspector/src/inspect.ts';
import { closeAllInspectorSessions } from '../inspector/src/inspect/session.ts';
import { closeSharedBrowser } from '../inspector/src/inspect/browser.ts';
import type { TargetOutcome } from '../inspector/src/types.ts';

type TargetExpectation = {
  outcome: TargetOutcome;
  codes: string[];
};

type CorpusCase = {
  modulePath: string;
  targets: Record<string, TargetExpectation>;
};

type CorpusExpectations = {
  version: 1;
  cases: Record<string, CorpusCase>;
};

const expectationsPath = resolve(import.meta.dirname, 'runtime-corpus.expectations.json');
const expectations = JSON.parse(readFileSync(expectationsPath, 'utf8')) as CorpusExpectations;
const docsRoot = resolve(
  process.env.TYPEGPU_DOCS_ROOT ??
    process.argv.find((argument) => !argument.startsWith('--')) ??
    resolve(import.meta.dirname, '../../TypeGPU'),
);
const cwd = resolve(docsRoot, 'apps/typegpu-docs');
const snapshotMode = process.argv.includes('--snapshot');

async function main(): Promise<void> {
  const actual: CorpusExpectations = { version: 1, cases: {} };
  try {
    for (const [caseName, expectedCase] of Object.entries(expectations.cases)) {
      const modulePath = resolve(cwd, expectedCase.modulePath);
      const discovered = discoverTypeGpuModule(modulePath, readFileSync(modulePath, 'utf8'));
      const report = await inspectTypegpuSymbols({
        cwd,
        modulePath,
        targets: discovered.targets.map((target) => target.selector),
        includePrivate: true,
        reuseBrowser: true,
        timeoutMs: 120_000,
      }, { addDirectSymbolDiagnostic: false });
      const labels = new Map<string, number>();
      const targets = Object.fromEntries(report.targets.map((target) => {
        const count = (labels.get(target.label) ?? 0) + 1;
        labels.set(target.label, count);
        const label = count === 1 ? target.label : `${target.label} #${count}`;
        return [label, {
          outcome: target.outcome ?? (target.ok ? 'passed' : 'failed'),
          codes: [...new Set((target.diagnostics ?? [])
            .filter((diagnostic) => diagnostic.severity !== 'note')
            .map((diagnostic) => diagnostic.code)
            .filter((code): code is string => typeof code === 'string'))].sort(),
        } satisfies TargetExpectation];
      }));
      actual.cases[caseName] = { modulePath: expectedCase.modulePath, targets };
    }
  } finally {
    await closeAllInspectorSessions();
    await closeSharedBrowser();
  }

  if (snapshotMode) {
    process.stdout.write(`${JSON.stringify(actual, null, 2)}\n`);
    return;
  }

  const fixed: string[] = [];
  const regressed: string[] = [];
  const newFamilies = new Set<string>();
  for (const [caseName, actualCase] of Object.entries(actual.cases)) {
    const expectedCase = expectations.cases[caseName];
    for (const [label, target] of Object.entries(actualCase.targets)) {
      const expected = expectedCase?.targets[label];
      const id = `${caseName}: ${label}`;
      if (!expected) {
        if (!isPassing(target.outcome)) {
          regressed.push(`${id} (unexpected ${formatTarget(target)})`);
          for (const code of target.codes) newFamilies.add(code);
        }
        continue;
      }
      if (isPassing(target.outcome) && !isPassing(expected.outcome)) {
        fixed.push(id);
      } else if (target.outcome !== expected.outcome || target.codes.join() !== expected.codes.join()) {
        regressed.push(`${id} (${formatTarget(expected)} -> ${formatTarget(target)})`);
        for (const code of target.codes) {
          if (!expected.codes.includes(code)) newFamilies.add(code);
        }
      }
    }
    for (const label of Object.keys(expectedCase?.targets ?? {})) {
      if (!(label in actualCase.targets)) regressed.push(`${caseName}: ${label} (target disappeared)`);
    }
  }

  process.stdout.write([
    `Runtime corpus: ${Object.keys(actual.cases).length} modules, ${
      Object.values(actual.cases).reduce((sum, entry) => sum + Object.keys(entry.targets).length, 0)
    } targets`,
    `Fixed (${fixed.length}):${fixed.length ? `\n- ${fixed.join('\n- ')}` : ' none'}`,
    `Regressed (${regressed.length}):${regressed.length ? `\n- ${regressed.join('\n- ')}` : ' none'}`,
    `Unexpected failure codes:${newFamilies.size ? ` ${[...newFamilies].sort().join(', ')}` : ' none'}`,
    '',
  ].join('\n'));

  if (regressed.length > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function isPassing(outcome: TargetOutcome): boolean {
  return outcome === 'passed' || outcome === 'passed-with-assumptions';
}

function formatTarget(target: TargetExpectation): string {
  return `${target.outcome}${target.codes.length ? ` [${target.codes.join(', ')}]` : ''}`;
}
