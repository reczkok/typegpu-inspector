import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parseJSONC, stringifyJSONC, type JSONCParseError } from 'confbox/jsonc';
import { applyEdits, modify } from 'jsonc-parser';
import which from 'which';
import { isRecord } from './shared.ts';

const MIN_NODE_MAJOR = 20;
const packageJson = JSON.parse(
  readFileSync(packageJsonPath(import.meta.url), 'utf8'),
) as { version?: string };

function packageJsonPath(moduleUrl: string): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  for (const candidate of [
    resolve(moduleDir, '..', 'package.json'),
    resolve(moduleDir, '..', '..', 'package.json'),
  ]) {
    try {
      readFileSync(candidate, 'utf8');
      return candidate;
    } catch {
      // Source modules live under src/; compiled chunks live under dist/chunks/.
    }
  }
  return resolve(moduleDir, '..', 'package.json');
}

export const PACKAGE_NAME = 'typegpu-runtime-inspector-mcp';
export const PACKAGE_SPEC = `${PACKAGE_NAME}@${packageJson.version ?? 'latest'}`;
export const SERVER_NAME = 'typegpu_inspector';
export const PACKAGE_COMMAND = ['npx', PACKAGE_SPEC] as const;
export const SETUP_TARGETS = ['codex', 'claude', 'opencode', 'zed'] as const;

export type SetupTarget = (typeof SETUP_TARGETS)[number];

export type CommandResult = {
  code: number;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
};

export type RunCommand = (
  command: string,
  args: string[],
  options?: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    silent?: boolean;
    capture?: boolean;
  },
) => Promise<CommandResult>;

export type CliDeps = {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stdout?: Pick<NodeJS.WriteStream, 'write'>;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
  runCommand?: RunCommand;
  commandExists?: (command: string, env?: NodeJS.ProcessEnv) => Promise<boolean>;
  startServer?: () => Promise<void>;
  launchChromium?: () => Promise<string>;
};

type ParsedCommand =
  | { kind: 'server' }
  | { kind: 'help' }
  | { kind: 'doctor' }
  | { kind: 'setup'; target: SetupTarget | 'all'; force: boolean; upgrade: boolean };

type SetupOptions = {
  force?: boolean;
  upgrade?: boolean;
};

export type SetupContext = Required<
  Pick<CliDeps, 'env' | 'cwd' | 'stdout' | 'stderr' | 'runCommand' | 'commandExists'>
>;

export function parseCliArgs(args: string[]): ParsedCommand {
  const [command, target, ...rest] = args;

  if (!command) {
    return { kind: 'server' };
  }
  if (command === '-h' || command === '--help' || command === 'help') {
    return { kind: 'help' };
  }
  if (command === 'doctor') {
    if (target !== undefined || rest.length > 0) {
      throw new Error('doctor does not accept extra arguments.');
    }
    return { kind: 'doctor' };
  }
  if (command === 'setup') {
    if (target === undefined) {
      throw new Error('Pass a setup target: codex, claude, opencode, zed, or all.');
    }
    const force = rest.includes('--force');
    const upgrade = rest.includes('--upgrade');
    const unexpected = rest.find((argument) => argument !== '--force' && argument !== '--upgrade');
    if (unexpected) {
      throw new Error(`Unexpected setup argument: ${unexpected}`);
    }
    if (target === 'all' || isSetupTarget(target)) {
      return { kind: 'setup', target, force, upgrade };
    }
    throw new Error(`Unknown setup target: ${target}`);
  }

  throw new Error(`Unknown command: ${command}`);
}

export async function main(args = process.argv.slice(2), deps: CliDeps = {}): Promise<number> {
  try {
    const parsed = parseCliArgs(args);
    switch (parsed.kind) {
      case 'server':
        await (deps.startServer ?? defaultStartServer)();
        return 0;
      case 'help':
        writeLine(deps.stdout ?? process.stdout, formatHelp());
        return 0;
      case 'doctor':
        return await runDoctor(deps);
      case 'setup':
        return await runSetup(parsed.target, deps, {
          force: parsed.force,
          upgrade: parsed.upgrade,
        });
    }
  } catch (error) {
    writeLine(deps.stderr ?? process.stderr, `Error: ${formatError(error)}`);
    writeLine(deps.stderr ?? process.stderr, `Run \`${PACKAGE_NAME} --help\` for usage.`);
    return 1;
  }
}

export function formatHelp(): string {
  return `TypeGPU Runtime Inspector MCP

Usage:
  ${PACKAGE_NAME}                 Start the local stdio MCP server
  ${PACKAGE_NAME} setup codex     Configure Codex to launch this MCP with npx
  ${PACKAGE_NAME} setup claude    Configure Claude Code at user scope
  ${PACKAGE_NAME} setup opencode  Configure OpenCode global config
  ${PACKAGE_NAME} setup zed       Configure the Zed agent (context_servers)
  ${PACKAGE_NAME} setup all       Configure every supported client found on PATH
  ${PACKAGE_NAME} setup codex --upgrade
                                   Update an existing '${SERVER_NAME}' entry for this package
  ${PACKAGE_NAME} setup codex --force
                                   Replace any existing '${SERVER_NAME}' entry
  ${PACKAGE_NAME} doctor          Check Node, npx, and Chromium/WebGPU launch

Recommended:
  npx ${PACKAGE_SPEC} setup codex
  npx ${PACKAGE_SPEC} setup claude
  npx ${PACKAGE_SPEC} setup opencode
  npx ${PACKAGE_SPEC} setup zed`;
}

export async function runSetup(
  target: SetupTarget | 'all',
  deps: CliDeps = {},
  options: SetupOptions = {},
): Promise<number> {
  const context = createSetupContext(deps);

  if (target !== 'all') {
    await setupClient(target, context, options);
    return 0;
  }

  let configured = 0;
  for (const client of SETUP_TARGETS) {
    const command = clientCommand(client);
    if (!(await context.commandExists(command, context.env))) {
      writeLine(context.stdout, `Skipped ${client}: ${command} was not found on PATH.`);
      continue;
    }
    await setupClient(client, context, options);
    configured += 1;
  }

  if (configured === 0) {
    writeLine(context.stderr, 'No supported MCP clients were found on PATH.');
    return 1;
  }

  return 0;
}

export async function setupClient(
  target: SetupTarget,
  context: SetupContext,
  options: SetupOptions = {},
): Promise<void> {
  switch (target) {
    case 'codex':
      await setupCodex(context, options);
      return;
    case 'claude':
      await setupClaude(context, options);
      return;
    case 'opencode':
      await setupOpenCode(context, options);
      return;
    case 'zed':
      await setupZed(context, options);
      return;
  }
}

export async function setupCodex(
  context: SetupContext,
  options: SetupOptions = {},
): Promise<void> {
  await requireCommand('codex', context);
  const existing = await context.runCommand('codex', ['mcp', 'get', SERVER_NAME], {
    ...context,
    silent: true,
    capture: true,
  });
  if (existing.code === 0) {
    if (commandResultMatchesPackage(existing)) {
      writeLine(context.stdout, `Codex MCP server '${SERVER_NAME}' is already configured.`);
      return;
    }
    if (commandResultReferencesPackage(existing)) {
      if (!options.upgrade && !options.force) {
        throw existingPackageUpgradeError('Codex', 'codex');
      }
      await runRequired('codex', ['mcp', 'remove', SERVER_NAME], context);
      await runRequired('codex', ['mcp', 'add', SERVER_NAME, '--', ...PACKAGE_COMMAND], context);
      writeLine(context.stdout, `Upgraded Codex MCP server '${SERVER_NAME}'.`);
      return;
    }
    if (!options.force) {
      throw existingConfigError('Codex', 'codex');
    }
    await runRequired('codex', ['mcp', 'remove', SERVER_NAME], context);
  }
  await runRequired('codex', ['mcp', 'add', SERVER_NAME, '--', ...PACKAGE_COMMAND], context);
  writeLine(context.stdout, `Configured Codex MCP server '${SERVER_NAME}'.`);
}

export async function setupClaude(
  context: SetupContext,
  options: SetupOptions = {},
): Promise<void> {
  await requireCommand('claude', context);
  const existing = await context.runCommand('claude', ['mcp', 'get', SERVER_NAME], {
    ...context,
    silent: true,
    capture: true,
  });
  if (existing.code === 0) {
    if (commandResultMatchesPackage(existing)) {
      writeLine(context.stdout, `Claude Code MCP server '${SERVER_NAME}' is already configured.`);
      return;
    }
    if (commandResultReferencesPackage(existing)) {
      if (!options.upgrade && !options.force) {
        throw existingPackageUpgradeError('Claude Code', 'claude');
      }
      await runRequired('claude', ['mcp', 'remove', SERVER_NAME, '--scope', 'user'], context);
      await runRequired(
        'claude',
        ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', SERVER_NAME, '--', ...PACKAGE_COMMAND],
        context,
      );
      writeLine(context.stdout, `Upgraded Claude Code MCP server '${SERVER_NAME}' at user scope.`);
      return;
    }
    if (!options.force) {
      throw existingConfigError('Claude Code', 'claude');
    }
    await runRequired('claude', ['mcp', 'remove', SERVER_NAME, '--scope', 'user'], context);
  }
  await runRequired(
    'claude',
    ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', SERVER_NAME, '--', ...PACKAGE_COMMAND],
    context,
  );
  writeLine(context.stdout, `Configured Claude Code MCP server '${SERVER_NAME}' at user scope.`);
}

export async function setupOpenCode(
  context: SetupContext,
  options: SetupOptions = {},
): Promise<void> {
  const result = await patchOpenCodeConfig(getOpenCodeConfigPath(context.env), context.env, options);
  if (result === 'unchanged') {
    writeLine(context.stdout, `OpenCode MCP server '${SERVER_NAME}' is already configured.`);
    return;
  }
  writeLine(context.stdout, `Configured OpenCode MCP server '${SERVER_NAME}'.`);
}

export function getOpenCodeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  return join(configHome, 'opencode', 'opencode.json');
}

export async function patchOpenCodeConfig(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
  options: SetupOptions = {},
): Promise<'updated' | 'unchanged'> {
  const existingConfig = await readJsonObjectIfPresent(configPath);
  const currentMcp = isRecord(existingConfig.mcp) ? existingConfig.mcp : {};
  const desiredServerConfig = {
    type: 'local',
    command: [...PACKAGE_COMMAND],
    enabled: true,
  };
  const existingServerConfig = currentMcp[SERVER_NAME];

  if (isDeepStrictEqual(existingServerConfig, desiredServerConfig)) {
    return 'unchanged';
  }
  if (existingServerConfig !== undefined) {
    if (configReferencesPackage(existingServerConfig)) {
      if (!options.upgrade && !options.force) {
        throw existingPackageUpgradeError('OpenCode', 'opencode');
      }
    } else if (!options.force) {
      throw existingConfigError('OpenCode', 'opencode');
    }
  }

  const nextConfig = {
    ...existingConfig,
    mcp: {
      ...currentMcp,
      [SERVER_NAME]: desiredServerConfig,
    },
  };

  await mkdir(dirname(configPath), { recursive: true });
  const newline = env.OS === 'Windows_NT' ? '\r\n' : '\n';
  await writeFile(configPath, `${stringifyJSONC(nextConfig, { indent: 2 })}${newline}`, 'utf8');
  return 'updated';
}

export function getZedSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  return join(configHome, 'zed', 'settings.json');
}

export async function setupZed(
  context: SetupContext,
  options: SetupOptions = {},
): Promise<void> {
  const result = await patchZedSettings(getZedSettingsPath(context.env), context.env, options);
  if (result === 'unchanged') {
    writeLine(context.stdout, `Zed context server '${SERVER_NAME}' is already configured.`);
    return;
  }
  writeLine(
    context.stdout,
    `Configured Zed context server '${SERVER_NAME}'. Restart Zed so the agent picks it up.`,
  );
}

/**
 * Zed's settings.json is a hand-maintained JSONC file, so the patch is a
 * comment-preserving surgical edit of the `context_servers` entry instead of
 * a whole-file rewrite.
 */
export async function patchZedSettings(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
  options: SetupOptions = {},
): Promise<'updated' | 'unchanged'> {
  const existingConfig = await readJsonObjectIfPresent(configPath);
  const currentServers = isRecord(existingConfig.context_servers)
    ? existingConfig.context_servers
    : {};
  const desiredServerConfig = {
    source: 'custom',
    command: PACKAGE_COMMAND[0],
    args: PACKAGE_COMMAND.slice(1),
    env: {},
  };
  const existingServerConfig = currentServers[SERVER_NAME];

  if (isDeepStrictEqual(existingServerConfig, desiredServerConfig)) {
    return 'unchanged';
  }
  if (existingServerConfig !== undefined) {
    if (configReferencesPackage(existingServerConfig)) {
      if (!options.upgrade && !options.force) {
        throw existingPackageUpgradeError('Zed', 'zed');
      }
    } else if (!options.force) {
      throw existingConfigError('Zed', 'zed');
    }
  }

  let text: string;
  try {
    text = await readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    text = '';
  }
  if (text.trim() === '') text = '{}';
  const edits = modify(
    text,
    ['context_servers', SERVER_NAME],
    desiredServerConfig,
    { formattingOptions: { insertSpaces: true, tabSize: 2 } },
  );
  const patched = applyEdits(text, edits);
  await mkdir(dirname(configPath), { recursive: true });
  const newline = patched.endsWith('\n')
    ? ''
    : env.OS === 'Windows_NT'
    ? '\r\n'
    : '\n';
  await writeFile(configPath, `${patched}${newline}`, 'utf8');
  return 'updated';
}

export async function runDoctor(deps: CliDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const env = deps.env ?? process.env;
  const commandExists = deps.commandExists ?? isCommandAvailable;
  const launchChromium = deps.launchChromium ?? launchInspectorChromium;
  let ok = true;

  if (getNodeMajor(process.version) >= MIN_NODE_MAJOR) {
    writeLine(stdout, `[ok] Node ${process.version}`);
  } else {
    ok = false;
    writeLine(stderr, `[fail] Node ${process.version}; ${PACKAGE_NAME} requires Node >=${MIN_NODE_MAJOR}.`);
  }

  if (await commandExists('npx', env)) {
    writeLine(stdout, '[ok] npx is available');
  } else {
    ok = false;
    writeLine(stderr, '[fail] npx was not found on PATH.');
  }

  try {
    const browserVersion = await launchChromium();
    writeLine(stdout, `[ok] Chromium launched (${browserVersion})`);
  } catch (error) {
    ok = false;
    writeLine(stderr, `[fail] Chromium launch failed: ${formatError(error)}`);
    writeLine(stderr, browserInstallHint());
  }

  return ok ? 0 : 1;
}

export async function isCommandAvailable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return (await which(command, { path: env.PATH, pathExt: env.PATHEXT, nothrow: true })) !== null;
}

function createSetupContext(deps: CliDeps): SetupContext {
  return {
    env: deps.env ?? process.env,
    cwd: deps.cwd ?? process.cwd(),
    stdout: deps.stdout ?? process.stdout,
    stderr: deps.stderr ?? process.stderr,
    runCommand: deps.runCommand ?? runCommand,
    commandExists: deps.commandExists ?? isCommandAvailable,
  };
}

async function requireCommand(command: string, context: SetupContext): Promise<void> {
  if (!(await context.commandExists(command, context.env))) {
    throw new Error(`${command} was not found on PATH.`);
  }
}

async function runRequired(command: string, args: string[], context: SetupContext): Promise<void> {
  const result = await context.runCommand(command, args, context);
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.code}.`);
  }
}

function runCommand(
  command: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    silent?: boolean;
    capture?: boolean;
  } = {},
): Promise<CommandResult> {
  return new Promise((resolveCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : options.silent ? 'ignore' : 'inherit',
    });
    let stdout = '';
    let stderr = '';

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      resolveCommand({ code: error.code === 'ENOENT' ? 127 : 1, stdout, stderr });
    });
    child.on('close', (code, signal) => {
      resolveCommand({ code: code ?? (signal ? 1 : 0), signal, stdout, stderr });
    });
  });
}

async function launchInspectorChromium(): Promise<string> {
  // Shares the self-healing launcher, so a doctor run on a machine whose npx
  // install skipped the browser download repairs it instead of just failing.
  const { launchInspectorBrowser } = await import('./inspect/browser.ts');
  const browser = await launchInspectorBrowser();
  try {
    return browser.version();
  } finally {
    await browser.close();
  }
}

async function readJsonObjectIfPresent(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }

  if (text.trim() === '') {
    return {};
  }

  const errors: JSONCParseError[] = [];
  const value = parseJSONC<unknown>(text, { allowTrailingComma: true, errors });
  if (errors.length > 0) {
    throw new Error(`Could not parse ${path}. Fix invalid JSON/JSONC, then rerun setup.`);
  }

  if (!isRecord(value)) {
    throw new Error(`Expected ${path} to contain a JSON object.`);
  }
  return value;
}

function clientCommand(target: SetupTarget): string {
  return target;
}

function commandResultMatchesPackage(result: CommandResult): boolean {
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return PACKAGE_COMMAND.every((part) => text.includes(part));
}

function commandResultReferencesPackage(result: CommandResult): boolean {
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return text.includes(PACKAGE_NAME);
}

function configReferencesPackage(value: unknown): boolean {
  return JSON.stringify(value).includes(PACKAGE_NAME);
}

function existingPackageUpgradeError(clientName: string, setupTarget: SetupTarget): Error {
  return new Error(
    `${clientName} already has an MCP server named '${SERVER_NAME}' for ${PACKAGE_NAME}, but it is pinned to different settings. ` +
      `Rerun \`${PACKAGE_NAME} setup ${setupTarget} --upgrade\` to update it, or use \`--force\` to replace it explicitly.`,
  );
}

function existingConfigError(clientName: string, setupTarget: SetupTarget): Error {
  return new Error(
    `${clientName} already has an MCP server named '${SERVER_NAME}' with different settings. ` +
      `Inspect it manually or rerun \`${PACKAGE_NAME} setup ${setupTarget} --force\` to replace it.`,
  );
}

function isSetupTarget(target: string): target is SetupTarget {
  return SETUP_TARGETS.includes(target as SetupTarget);
}

function writeLine(stream: Pick<NodeJS.WriteStream, 'write'>, text: string): void {
  stream.write(`${text}\n`);
}

function getNodeMajor(version: string): number {
  return Number.parseInt(version.replace(/^v/, '').split('.')[0] ?? '0', 10);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function browserInstallHint(): string {
  return `This MCP uses local Playwright Chromium. It downloads the browser automatically on first use; if that fails, run \`npx -y playwright-chromium install chromium\` and then \`npx ${PACKAGE_SPEC} doctor\` to verify.`;
}

async function defaultStartServer(): Promise<void> {
  const { startMcpServer } = await import('./index.ts');
  await startMcpServer();
}

const thisFile = fileURLToPath(import.meta.url);
const argvFile = process.argv[1] ? resolve(process.argv[1]) : undefined;

if (argvFile && (argvFile === thisFile || argvFile.endsWith(`${sep}src${sep}cli.ts`))) {
  process.exitCode = await main();
}
