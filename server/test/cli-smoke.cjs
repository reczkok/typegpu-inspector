// End-to-end: the built bundle runs the CLI against the live runtime inspector.
// Usage: node test/cli-smoke.cjs dist/server.cjs
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

const entry = resolve(process.argv[2] ?? 'dist/server.cjs');
const cwd = resolve(__dirname, '..');
const fixture = 'test/fixtures/wgsl-compilation-error.ts';

function run(args) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 300_000,
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function assert(condition, message, detail) {
  if (condition) return;
  console.error(`cli-smoke: ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

const targets = run(['targets', fixture, '--json']);
assert(targets.code === 0, `targets exited ${targets.code}`, targets.stderr);
const listed = JSON.parse(targets.stdout);
assert(
  listed.targets.some((target) => target.label === 'badWgsl'),
  'targets did not list badWgsl',
  targets.stdout,
);

const check = run(['check', fixture, '--json']);
assert(check.code === 1, `check exited ${check.code}, expected 1`, check.stderr || check.stdout);
const report = JSON.parse(check.stdout);
assert(report.ok === false, 'check reported ok for a broken shader');
assert(report.summary.errors >= 1, 'check reported no errors', check.stdout);
const diagnostic = report.files[0].diagnostics.find((entry) => entry.severity === 'error');
assert(diagnostic !== undefined, 'no error diagnostic', check.stdout);
assert(diagnostic.path === fixture, `diagnostic path was ${diagnostic.path}`);
assert(diagnostic.line >= 4, `diagnostic line was ${diagnostic.line}`);

const usage = run(['check', '--format', 'yaml']);
assert(usage.code === 2, `usage error exited ${usage.code}, expected 2`);

const concrete = run(['check', '../inspector/test/fixtures/configured-pipeline.ts', '-t', 'configuredPipeline', '--require-concrete', '--json']);
assert(concrete.code === 0, `configured pipeline exited ${concrete.code}`, concrete.stderr + concrete.stdout);
const concreteReport = JSON.parse(concrete.stdout);
assert(concreteReport.ok === true && concreteReport.requireConcrete === true, 'concrete policy was not satisfied', concrete.stdout);
assert(concreteReport.summary.targets === 1 && concreteReport.summary.assumed === 0, 'configured pipeline unexpectedly needed assumptions', concrete.stdout);
assert(concreteReport.files[0].targets[0].outcome === 'passed', 'configured pipeline lacked a concrete outcome', concrete.stdout);

const sharedFailure = run(['check', '../inspector/test/fixtures/module-failure/first.ts', '../inspector/test/fixtures/module-failure/second.ts', '--json']);
assert(sharedFailure.code === 1, `shared module failure exited ${sharedFailure.code}`, sharedFailure.stderr + sharedFailure.stdout);
const sharedReport = JSON.parse(sharedFailure.stdout);
const sharedErrors = sharedReport.files.flatMap((file) => file.diagnostics).filter((entry) => entry.severity === 'error');
assert(sharedErrors.length === 1 && sharedReport.summary.blocked === 2, 'shared cause was duplicated or importer status lost', sharedFailure.stdout);
assert(sharedErrors[0].path === resolve(cwd, '../inspector/test/fixtures/module-failure/shared.ts'), 'shared error lost its usable source path through MCP', sharedFailure.stdout);
assert(sharedErrors[0].line === 2 && sharedErrors[0].column === 9, 'shared error lost its authored position', sharedFailure.stdout);
assert(sharedErrors[0].affectedModules.length === 2, 'shared error lost its affected importers', sharedFailure.stdout);

const evaluatedFailure = run(['check', '../inspector/test/fixtures/module-failure/evaluation.ts', '--evaluate', '--json']);
assert(evaluatedFailure.code === 1, `module evaluation exited ${evaluatedFailure.code}`, evaluatedFailure.stderr + evaluatedFailure.stdout);
const evaluatedReport = JSON.parse(evaluatedFailure.stdout);
const evaluatedError = evaluatedReport.files.flatMap((file) => file.diagnostics).find((entry) => entry.severity === 'error');
assert(evaluatedReport.files[0].targets[0].kind === 'module', 'fixture did not exercise module evaluation', evaluatedFailure.stdout);
assert(evaluatedError?.path === resolve(cwd, '../inspector/test/fixtures/module-failure/shared.ts'), 'evaluated module lost its usable source path through MCP', evaluatedFailure.stdout);

const interactive = run(['interactive']);
assert(interactive.code === 2, `non-TTY interactive session exited ${interactive.code}, expected 2`);
assert(
  interactive.stderr.includes('interactive session needs a terminal'),
  'non-TTY interactive session did not explain the terminal requirement',
  interactive.stderr,
);

process.stdout.write(`${JSON.stringify({
  ok: true,
  targets: listed.targets.length,
  errors: report.summary.errors,
  concreteTargets: concreteReport.summary.targets,
  firstError: diagnostic.message.slice(0, 160),
}, null, 2)}\n`);
