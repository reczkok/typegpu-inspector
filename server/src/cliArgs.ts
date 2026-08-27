import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';

export type OutputFormat = 'text' | 'json' | 'github';
export type CliSeverity = 'error' | 'warning' | 'info' | 'hint';

export const SEVERITIES: readonly CliSeverity[] = ['error', 'warning', 'info', 'hint'];
const FORMATS: readonly OutputFormat[] = ['text', 'json', 'github'];

/** Runtime settings the CLI can override; absent fields keep the server defaults. */
export type RuntimeOptions = {
  projectRoot?: string;
  timeoutMs?: number;
  inspectorPackage?: string;
  features: string[];
  strictNames: boolean;
  sourceMapping: boolean;
};

export type GlobalOptions = {
  quiet: boolean;
  /** Undefined lets the terminal decide. */
  color: boolean | undefined;
};

export type CheckCommand = GlobalOptions & {
  command: 'check';
  paths: string[];
  format: OutputFormat;
  minSeverity: CliSeverity;
  warningsAsErrors: boolean;
  watch: boolean;
  verbose: boolean;
  runtime: RuntimeOptions;
};

export type WgslCommand = GlobalOptions & {
  command: 'wgsl';
  paths: string[];
  targets: string[];
  json: boolean;
  runtime: RuntimeOptions;
};

export type ReportCommand = GlobalOptions & {
  command: 'report';
  paths: string[];
  targets: string[];
  json: boolean;
  runtime: RuntimeOptions;
};

export type TargetsCommand = GlobalOptions & {
  command: 'targets';
  paths: string[];
  json: boolean;
};

export type InteractiveCommand = GlobalOptions & {
  command: 'interactive';
  paths: string[];
  runtime: RuntimeOptions;
};

export type CliCommand = CheckCommand | WgslCommand | ReportCommand | TargetsCommand | InteractiveCommand;

/** Help and version print on their own and carry an exit code instead of a command. */
export type ParsedCliArgs =
  | { ok: true; command: CliCommand }
  | { ok: false; exitCode: number };

export type ParseIo = {
  stdout(text: string): void;
  stderr(text: string): void;
};

const EXIT_USAGE = 2;

export async function parseCliArgs(
  argv: readonly string[],
  io: ParseIo,
  version: string,
): Promise<ParsedCliArgs> {
  let parsed: CliCommand | undefined;
  const program = buildProgram(io, version, (command) => {
    parsed = command;
  });
  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      const informational = error.code === 'commander.helpDisplayed' ||
        error.code === 'commander.version' ||
        error.code === 'commander.help';
      return { ok: false, exitCode: informational ? 0 : EXIT_USAGE };
    }
    throw error;
  }
  if (!parsed) return { ok: false, exitCode: 0 };
  return { ok: true, command: parsed };
}

function buildProgram(io: ParseIo, version: string, emit: (command: CliCommand) => void): Command {
  const program = new Command('typegpu-inspector')
    .description(
      'Runs TypeGPU modules in a headless Chromium with WebGPU and reports what they generate.\n' +
        'The same executable is the language server when started with --stdio.',
    )
    .version(version, '-v, --version', 'Show the version')
    .helpOption('-h, --help', 'Show help')
    .option('-q, --quiet', 'No progress output on stderr')
    .option('--color', 'Force colors on')
    .option('--no-color', 'Force colors off')
    .addHelpText(
      'after',
      '\nRun without a command in a terminal to start an interactive session.\n' +
        'Exit codes: 0 no errors, 1 errors or failed targets, 2 usage or environment failure.',
    )
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.stdout(text),
      writeErr: (text) => io.stderr(text),
    })
    .showHelpAfterError('(run with --help for usage)')
    .showSuggestionAfterError();

  program.helpCommand('help [command]', 'Show help for a command');

  program
    .command('version')
    .description('Show the version')
    .action(() => {
      io.stdout(`${version}\n`);
    });

  withRuntimeOptions(
    program
      .command('check')
      .description(
        'Inspect every TypeGPU module under the given files, directories, or globs and print diagnostics',
      )
      .argument('[paths...]', 'Files, directories, or globs to inspect', ['.'])
      .addOption(
        new Option('--format <format>', 'Output format; github adds workflow annotations')
          .choices(FORMATS)
          .default('text'),
      )
      .option('--json', 'Same as --format json')
      .addOption(
        new Option('--severity <level>', 'Lowest severity to print')
          .choices(SEVERITIES)
          .default('hint'),
      )
      .option('--warnings-as-errors', 'Exit 1 on warnings too')
      .option(
        '-w, --watch',
        'Re-check changed modules and their importers on save, keeping the browser warm',
      )
      .option('--verbose', 'Also list every target with its status'),
  ).action((paths: string[], _options: unknown, command: Command) => {
    const options = command.optsWithGlobals<CheckOptions>();
    const format: OutputFormat = options.json ? 'json' : options.format;
    if (options.watch === true && format === 'json') {
      command.error('error: --watch prints text; drop --format json.', { exitCode: EXIT_USAGE });
    }
    emit({
      ...globalOptions(options),
      command: 'check',
      paths,
      format,
      minSeverity: options.severity,
      warningsAsErrors: options.warningsAsErrors ?? false,
      watch: options.watch ?? false,
      verbose: options.verbose ?? false,
      runtime: runtimeOptions(options),
    });
  });

  withRuntimeOptions(
    withTargetOptions(
      program
        .command('wgsl')
        .description(
          "Print the WGSL TypeGPU generated for each of a module's targets, with the compiler's messages",
        )
        .argument('<files...>', 'Modules to inspect'),
    ),
  ).action((paths: string[], _options: unknown, command: Command) => {
    const options = command.optsWithGlobals<TargetedOptions>();
    emit({
      ...globalOptions(options),
      command: 'wgsl',
      paths,
      targets: options.target ?? [],
      json: options.json ?? false,
      runtime: runtimeOptions(options),
    });
  });

  withRuntimeOptions(
    withTargetOptions(
      program
        .command('report')
        .description(
          'Print the full inspection report for each target as Markdown: WGSL, entry points, bindings, ' +
            'pipeline state, resources, schema layout, and the provenance ledger',
        )
        .argument('<files...>', 'Modules to inspect'),
    ),
  ).action((paths: string[], _options: unknown, command: Command) => {
    const options = command.optsWithGlobals<TargetedOptions>();
    emit({
      ...globalOptions(options),
      command: 'report',
      paths,
      targets: options.target ?? [],
      json: options.json ?? false,
      runtime: runtimeOptions(options),
    });
  });

  withRuntimeOptions(
    program
      .command('interactive')
      .alias('i')
      .description(
        'Start a session in the terminal: pick targets, check, read WGSL and reports, watch, ' +
          'all on one warm browser',
      )
      .argument('[paths...]', 'Files, directories, or globs to work in', ['.']),
  ).action((paths: string[], _options: unknown, command: Command) => {
    const options = command.optsWithGlobals<GlobalCliOptions & RuntimeCliOptions>();
    emit({ ...globalOptions(options), command: 'interactive', paths, runtime: runtimeOptions(options) });
  });

  program
    .command('targets')
    .description('List the targets a check would inspect, from source alone; nothing runs')
    .argument('[paths...]', 'Files, directories, or globs to scan', ['.'])
    .option('--json', 'JSON output')
    .action((paths: string[], _options: unknown, command: Command) => {
      const options = command.optsWithGlobals<GlobalCliOptions & { json?: boolean }>();
      emit({ ...globalOptions(options), command: 'targets', paths, json: options.json ?? false });
    });

  return program;
}

type GlobalCliOptions = { quiet?: boolean; color?: boolean };

type RuntimeCliOptions = {
  projectRoot?: string;
  timeoutMs?: number;
  inspectorPackage?: string;
  feature?: string[];
  strictNames: boolean;
  sourceMapping: boolean;
};

type CheckOptions = GlobalCliOptions & RuntimeCliOptions & {
  format: OutputFormat;
  json?: boolean;
  severity: CliSeverity;
  warningsAsErrors?: boolean;
  watch?: boolean;
  verbose?: boolean;
};

type TargetedOptions = GlobalCliOptions & RuntimeCliOptions & {
  target?: string[];
  json?: boolean;
};

function withRuntimeOptions(command: Command): Command {
  return command
    .option('--project-root <dir>', 'Project root the runtime infers config from (default: current directory)')
    .option('--timeout-ms <n>', 'Budget per module, session start excluded (default: 45000)', positiveInteger)
    .option('--feature <name>', 'WebGPU feature to request from the adapter; repeatable', collect)
    .option('--no-strict-names', 'Let TypeGPU pick non-deterministic generated names')
    .option('--no-source-mapping', 'Place diagnostics on declarations instead of statements')
    .option('--inspector-package <spec>', 'npm package to run instead of the bundled runtime');
}

function withTargetOptions(command: Command): Command {
  return command
    .option('-t, --target <name>', 'Only this target (label or symbol name); repeatable', collect)
    .option('--json', 'JSON output');
}

function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('Expected a positive integer.');
  }
  return parsed;
}

function globalOptions(options: GlobalCliOptions): GlobalOptions {
  return { quiet: options.quiet ?? false, color: options.color };
}

function runtimeOptions(options: RuntimeCliOptions): RuntimeOptions {
  return {
    ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.inspectorPackage !== undefined ? { inspectorPackage: options.inspectorPackage } : {}),
    features: options.feature ?? [],
    strictNames: options.strictNames,
    sourceMapping: options.sourceMapping,
  };
}
