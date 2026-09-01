import { describe, expect, it } from 'vitest';
import { foldModuleFailures, type CliDiagnostic } from '../src/cliOutput.js';

function failure(line: number, label: string, text: string, code = 'target-resolution'): CliDiagnostic {
  return {
    path: 'src/water.ts',
    line,
    column: 1,
    endLine: line,
    endColumn: 5,
    severity: 'error',
    code,
    message: code === 'target-resolution' ? `${label}: ${text}` : text,
    related: [],
  };
}

describe('foldModuleFailures', () => {
  const text = 'Dependency optimization failed: Flow is not supported (node_modules/react-native/index.js).';

  it('keeps one report when every target failed the same way, without the target label', () => {
    const folded = foldModuleFailures(
      [failure(20, 'View', text), failure(68, 'BlurParams', text), failure(93, 'cellSize', text)],
      3,
    );
    expect(folded).toEqual([{ ...failure(20, 'View', text), message: text }]);
  });

  it('leaves a failure shared by only some targets alone', () => {
    const diagnostics = [failure(20, 'View', text), failure(68, 'BlurParams', text), failure(93, 'cellSize', 'unrelated')];
    expect(foldModuleFailures(diagnostics, 3)).toEqual(diagnostics);
  });

  it('folds runtime-inspection failures too and keeps other diagnostics in place', () => {
    const other: CliDiagnostic = { ...failure(5, '', 'a warning', 'wgsl-compilation'), severity: 'warning' };
    const folded = foldModuleFailures(
      [other, failure(20, '', 'Not connected', 'runtime-inspection'), failure(68, '', 'Not connected', 'runtime-inspection')],
      2,
    );
    expect(folded).toEqual([other, failure(20, '', 'Not connected', 'runtime-inspection')]);
  });

  it('never folds a single-target run', () => {
    const only = [failure(20, 'View', text)];
    expect(foldModuleFailures(only, 1)).toEqual(only);
  });
});
