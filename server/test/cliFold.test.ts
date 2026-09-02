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

  it('folds an environment hint shared by every target, dropping the target label', () => {
    const text = 'A browser capability required during module import was unavailable.';
    const hint = (line: number, label: string): CliDiagnostic => ({
      ...failure(line, label, text, 'inspection-unavailable'),
      severity: 'hint',
      message: `${label} could not be inspected here: ${text}`,
    });
    const folded = foldModuleFailures([hint(20, 'View'), hint(68, 'BlurParams')], 2);
    expect(folded).toEqual([{ ...hint(20, 'View'), message: text }]);
  });

  it('never folds a single-target run', () => {
    const only = [failure(20, 'View', text)];
    expect(foldModuleFailures(only, 1)).toEqual(only);
  });
});
