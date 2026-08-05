import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import {
  discoverTypeGpuModule,
  type TypeGpuRole,
} from '../server/src/discovery.ts';

type FileCoverage = {
  file: string;
  symbols: number;
  targets: number;
  targetless: Array<{ name: string; role: TypeGpuRole }>;
};

type CoverageReport = {
  root: string;
  files: number;
  symbols: number;
  targets: number;
  targetless: number;
  roles: Record<string, number>;
  targetKinds: Record<string, number>;
  targetlessRoles: Record<string, number>;
  zeroTargetFiles: string[];
  fileCoverage: FileCoverage[];
};

const args = process.argv.slice(2);
const json = args.includes('--json');
const positional = args.filter((arg) => !arg.startsWith('--'));
const examplesRoot = resolve(
  positional[0]
    ? process.cwd()
    : import.meta.dirname,
  positional[0] ?? '../../TypeGPU/apps/typegpu-docs/src/examples',
);

const files = collectSourceFiles(examplesRoot);
const report = createReport(examplesRoot, files);

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  printMarkdown(report);
}

function collectSourceFiles(root: string): string[] {
  const entries = readdirSync(root)
    .map((name) => resolve(root, name))
    .sort();
  const files: string[] = [];

  for (const entry of entries) {
    const stats = statSync(entry);
    if (stats.isDirectory()) {
      if (basename(entry) !== 'node_modules') {
        files.push(...collectSourceFiles(entry));
      }
    } else if (/\.[cm]?[jt]sx?$/.test(entry) && !/\.d\.[cm]?ts$/.test(entry)) {
      files.push(entry);
    }
  }

  return files;
}

function createReport(root: string, files: string[]): CoverageReport {
  const roles: Record<string, number> = {};
  const targetKinds: Record<string, number> = {};
  const targetlessRoles: Record<string, number> = {};
  const fileCoverage: FileCoverage[] = [];
  let symbols = 0;
  let targets = 0;
  let targetless = 0;

  for (const file of files) {
    const discovered = discoverTypeGpuModule(file, readFileSync(file, 'utf8'));
    symbols += discovered.symbols.length;
    targets += discovered.targets.length;

    for (const symbol of discovered.symbols) {
      increment(roles, symbol.role);
    }
    for (const target of discovered.targets) {
      increment(targetKinds, target.selector.kind);
    }

    const uncovered = discovered.symbols
      .filter((symbol) => symbol.targetIds.length === 0)
      .map((symbol) => ({ name: symbol.name, role: symbol.role }));
    targetless += uncovered.length;
    for (const symbol of uncovered) {
      increment(targetlessRoles, symbol.role);
    }

    fileCoverage.push({
      file: relative(root, file),
      symbols: discovered.symbols.length,
      targets: discovered.targets.length,
      targetless: uncovered,
    });
  }

  return {
    root,
    files: files.length,
    symbols,
    targets,
    targetless,
    roles: sortCounts(roles),
    targetKinds: sortCounts(targetKinds),
    targetlessRoles: sortCounts(targetlessRoles),
    zeroTargetFiles: fileCoverage
      .filter((coverage) => coverage.symbols > 0 && coverage.targets === 0)
      .map((coverage) => coverage.file),
    fileCoverage,
  };
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function sortCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts).sort((left, right) =>
      right[1] - left[1] || left[0].localeCompare(right[0])
    ),
  );
}

function printMarkdown(report: CoverageReport): void {
  const coverage = report.symbols === 0
    ? 100
    : ((report.symbols - report.targetless) / report.symbols) * 100;

  process.stdout.write([
    '# TypeGPU inspection coverage',
    '',
    `Root: \`${report.root}\``,
    '',
    `- Files: ${report.files}`,
    `- Detected symbols: ${report.symbols}`,
    `- Inspection targets: ${report.targets}`,
    `- Symbols with a target: ${report.symbols - report.targetless} (${coverage.toFixed(1)}%)`,
    `- Targetless symbols: ${report.targetless}`,
    '',
    '## Target kinds',
    '',
    formatCounts(report.targetKinds),
    '',
    '## Remaining targetless roles',
    '',
    formatCounts(report.targetlessRoles),
    '',
    '## Files with detected symbols but no targets',
    '',
    report.zeroTargetFiles.length > 0
      ? report.zeroTargetFiles.map((file) => `- \`${file}\``).join('\n')
      : 'None.',
    '',
  ].join('\n'));
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  return entries.length > 0
    ? entries.map(([key, value]) => `- ${key}: ${value}`).join('\n')
    : 'None.';
}
