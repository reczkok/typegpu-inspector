import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PACKAGE_COMMAND,
  SERVER_NAME,
  getOpenCodeConfigPath,
  parseCliArgs,
  patchOpenCodeConfig,
  patchZedSettings,
  runSetup,
  setupClaude,
  setupCodex,
  type CommandResult,
  type SetupContext,
} from '../src/cli.ts';

type RecordedCommand = {
  command: string;
  args: string[];
  silent: boolean;
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('CLI argument parsing', () => {
  it('defaults to starting the MCP server', () => {
    expect(parseCliArgs([])).toEqual({ kind: 'server' });
  });

  it('parses setup targets', () => {
    expect(parseCliArgs(['setup', 'codex'])).toEqual({
      kind: 'setup',
      target: 'codex',
      force: false,
      upgrade: false,
    });
    expect(parseCliArgs(['setup', 'all'])).toEqual({
      kind: 'setup',
      target: 'all',
      force: false,
      upgrade: false,
    });
    expect(parseCliArgs(['setup', 'codex', '--force'])).toEqual({
      kind: 'setup',
      target: 'codex',
      force: true,
      upgrade: false,
    });
    expect(parseCliArgs(['setup', 'codex', '--upgrade'])).toEqual({
      kind: 'setup',
      target: 'codex',
      force: false,
      upgrade: true,
    });
  });

  it('rejects unknown setup targets', () => {
    expect(() => parseCliArgs(['setup', 'cursor'])).toThrow('Unknown setup target: cursor');
  });
});

describe('client setup commands', () => {
  it('configures Codex through codex mcp add', async () => {
    const commands: RecordedCommand[] = [];
    const context = createContext(commands);

    await setupCodex(context);

    expect(commands).toEqual([
      { command: 'codex', args: ['mcp', 'get', SERVER_NAME], silent: true },
      { command: 'codex', args: ['mcp', 'add', SERVER_NAME, '--', ...PACKAGE_COMMAND], silent: false },
    ]);
  });

  it('replaces an existing Codex entry only with force', async () => {
    const commands: RecordedCommand[] = [];
    const context = createContext(commands, {
      resultFor(command, args) {
        return command === 'codex' && args.join(' ') === `mcp get ${SERVER_NAME}`
          ? { code: 0, stdout: 'command = ["node", "old-server.js"]' }
          : { code: 0 };
      },
    });

    await setupCodex(context, { force: true });

    expect(commands).toEqual([
      { command: 'codex', args: ['mcp', 'get', SERVER_NAME], silent: true },
      { command: 'codex', args: ['mcp', 'remove', SERVER_NAME], silent: false },
      { command: 'codex', args: ['mcp', 'add', SERVER_NAME, '--', ...PACKAGE_COMMAND], silent: false },
    ]);
  });

  it('upgrades an older Codex entry for this package', async () => {
    const commands: RecordedCommand[] = [];
    const context = createContext(commands, {
      resultFor(command, args) {
        return command === 'codex' && args.join(' ') === `mcp get ${SERVER_NAME}`
          ? { code: 0, stdout: 'command = ["npx", "typegpu-runtime-inspector-mcp@0.0.0-test"]' }
          : { code: 0 };
      },
    });

    await setupCodex(context, { upgrade: true });

    expect(commands).toEqual([
      { command: 'codex', args: ['mcp', 'get', SERVER_NAME], silent: true },
      { command: 'codex', args: ['mcp', 'remove', SERVER_NAME], silent: false },
      { command: 'codex', args: ['mcp', 'add', SERVER_NAME, '--', ...PACKAGE_COMMAND], silent: false },
    ]);
    expect(context.stdoutText()).toContain('Upgraded Codex');
  });

  it('does not upgrade an older Codex entry for this package without upgrade', async () => {
    const commands: RecordedCommand[] = [];
    const context = createContext(commands, {
      resultFor(command, args) {
        return command === 'codex' && args.join(' ') === `mcp get ${SERVER_NAME}`
          ? { code: 0, stdout: 'command = ["npx", "typegpu-runtime-inspector-mcp@0.0.0-test"]' }
          : { code: 0 };
      },
    });

    await expect(setupCodex(context)).rejects.toThrow('--upgrade');
    expect(commands).toEqual([
      { command: 'codex', args: ['mcp', 'get', SERVER_NAME], silent: true },
    ]);
  });

  it('does not replace a different Codex entry with upgrade', async () => {
    const commands: RecordedCommand[] = [];
    const context = createContext(commands, {
      resultFor(command, args) {
        return command === 'codex' && args.join(' ') === `mcp get ${SERVER_NAME}`
          ? { code: 0, stdout: 'command = ["node", "old-server.js"]' }
          : { code: 0 };
      },
    });

    await expect(setupCodex(context, { upgrade: true })).rejects.toThrow('--force');
    expect(commands).toEqual([
      { command: 'codex', args: ['mcp', 'get', SERVER_NAME], silent: true },
    ]);
  });

  it('does not replace a different Codex entry without force', async () => {
    const commands: RecordedCommand[] = [];
    const context = createContext(commands, {
      resultFor(command, args) {
        return command === 'codex' && args.join(' ') === `mcp get ${SERVER_NAME}`
          ? { code: 0, stdout: 'command = ["node", "old-server.js"]' }
          : { code: 0 };
      },
    });

    await expect(setupCodex(context)).rejects.toThrow('--force');
    expect(commands).toEqual([
      { command: 'codex', args: ['mcp', 'get', SERVER_NAME], silent: true },
    ]);
  });

  it('leaves an already matching Codex entry alone', async () => {
    const commands: RecordedCommand[] = [];
    const context = createContext(commands, {
      resultFor(command, args) {
        return command === 'codex' && args.join(' ') === `mcp get ${SERVER_NAME}`
          ? { code: 0, stdout: PACKAGE_COMMAND.join(' ') }
          : { code: 0 };
      },
    });

    await setupCodex(context);

    expect(commands).toEqual([
      { command: 'codex', args: ['mcp', 'get', SERVER_NAME], silent: true },
    ]);
    expect(context.stdoutText()).toContain('already configured');
  });

  it('configures Claude Code at user scope', async () => {
    const commands: RecordedCommand[] = [];
    const context = createContext(commands, {
      resultFor(command, args) {
        return command === 'claude' && args.join(' ') === `mcp get ${SERVER_NAME}`
          ? { code: 0, stdout: 'command = ["node", "old-server.js"]' }
          : { code: 0 };
      },
    });

    await setupClaude(context, { force: true });

    expect(commands).toEqual([
      { command: 'claude', args: ['mcp', 'get', SERVER_NAME], silent: true },
      { command: 'claude', args: ['mcp', 'remove', SERVER_NAME, '--scope', 'user'], silent: false },
      {
        command: 'claude',
        args: ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', SERVER_NAME, '--', ...PACKAGE_COMMAND],
        silent: false,
      },
    ]);
  });

  it('upgrades an older Claude Code entry for this package', async () => {
    const commands: RecordedCommand[] = [];
    const context = createContext(commands, {
      resultFor(command, args) {
        return command === 'claude' && args.join(' ') === `mcp get ${SERVER_NAME}`
          ? { code: 0, stdout: 'npx typegpu-runtime-inspector-mcp@0.0.0-test' }
          : { code: 0 };
      },
    });

    await setupClaude(context, { upgrade: true });

    expect(commands).toEqual([
      { command: 'claude', args: ['mcp', 'get', SERVER_NAME], silent: true },
      { command: 'claude', args: ['mcp', 'remove', SERVER_NAME, '--scope', 'user'], silent: false },
      {
        command: 'claude',
        args: ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', SERVER_NAME, '--', ...PACKAGE_COMMAND],
        silent: false,
      },
    ]);
    expect(context.stdoutText()).toContain('Upgraded Claude Code');
  });

  it('setup all configures installed clients and reports skipped ones', async () => {
    const root = await createTempDir();
    const commands: RecordedCommand[] = [];
    const context = createContext(commands, {
      env: { ...process.env, XDG_CONFIG_HOME: root },
      commandExists: async (command) => command !== 'claude',
    });

    const exitCode = await runSetup('all', context);
    const opencodeConfig = JSON.parse(await readFile(join(root, 'opencode', 'opencode.json'), 'utf8'));

    expect(exitCode).toBe(0);
    expect(context.stdoutText()).toContain('Skipped claude');
    expect(commands.map((entry) => entry.command)).toEqual(['codex', 'codex']);
    expect(opencodeConfig.mcp[SERVER_NAME]).toEqual({
      type: 'local',
      command: [...PACKAGE_COMMAND],
      enabled: true,
    });
  });
});

describe('OpenCode config patching', () => {
  it('creates the global config under HOME when no config exists', async () => {
    const root = await createTempDir();
    const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: '' };
    const configPath = getOpenCodeConfigPath(env);

    await patchOpenCodeConfig(configPath, env);

    const config = JSON.parse(await readFile(configPath, 'utf8'));
    expect(config).toEqual({
      mcp: {
        [SERVER_NAME]: {
          type: 'local',
          command: [...PACKAGE_COMMAND],
          enabled: true,
        },
      },
    });
  });

  it('preserves existing OpenCode config keys and MCP servers', async () => {
    const root = await createTempDir();
    const configPath = join(root, 'opencode', 'opencode.json');
    await mkdir(join(root, 'opencode'), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        model: 'anthropic/claude-sonnet-4-5',
        mcp: {
          existing: {
            type: 'local',
            command: ['node', 'server.js'],
          },
        },
      }),
    );

    await patchOpenCodeConfig(configPath, process.env);

    const config = JSON.parse(await readFile(configPath, 'utf8'));
    expect(config.model).toBe('anthropic/claude-sonnet-4-5');
    expect(config.mcp.existing).toEqual({
      type: 'local',
      command: ['node', 'server.js'],
    });
    expect(config.mcp[SERVER_NAME]).toEqual({
      type: 'local',
      command: [...PACKAGE_COMMAND],
      enabled: true,
    });
  });

  it('handles an empty OpenCode config file', async () => {
    const root = await createTempDir();
    const configPath = join(root, 'opencode', 'opencode.json');
    await mkdir(join(root, 'opencode'), { recursive: true });
    await writeFile(configPath, '');

    await patchOpenCodeConfig(configPath, process.env);

    const config = JSON.parse(await readFile(configPath, 'utf8'));
    expect(config.mcp[SERVER_NAME]).toEqual({
      type: 'local',
      command: [...PACKAGE_COMMAND],
      enabled: true,
    });
  });

  it('accepts JSONC OpenCode config files', async () => {
    const root = await createTempDir();
    const configPath = join(root, 'opencode', 'opencode.json');
    await mkdir(join(root, 'opencode'), { recursive: true });
    await writeFile(
      configPath,
      `{
        // OpenCode allows users to hand-edit this file.
        "model": "anthropic/claude-sonnet-4-5",
        "mcp": {},
      }`,
    );

    await patchOpenCodeConfig(configPath, process.env);

    const config = JSON.parse(await readFile(configPath, 'utf8'));
    expect(config.model).toBe('anthropic/claude-sonnet-4-5');
    expect(config.mcp[SERVER_NAME]).toEqual({
      type: 'local',
      command: [...PACKAGE_COMMAND],
      enabled: true,
    });
  });

  it('refuses to replace an existing typegpu_inspector entry without force', async () => {
    const root = await createTempDir();
    const configPath = join(root, 'opencode', 'opencode.json');
    await mkdir(join(root, 'opencode'), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        mcp: {
          [SERVER_NAME]: {
            type: 'local',
            command: ['node', '/old/server.js'],
            enabled: false,
          },
        },
      }),
    );

    await expect(patchOpenCodeConfig(configPath, process.env)).rejects.toThrow('--force');
  });

  it('replaces an existing typegpu_inspector entry with force', async () => {
    const root = await createTempDir();
    const configPath = join(root, 'opencode', 'opencode.json');
    await mkdir(join(root, 'opencode'), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        mcp: {
          [SERVER_NAME]: {
            type: 'local',
            command: ['node', '/old/server.js'],
            enabled: false,
          },
        },
      }),
    );

    await patchOpenCodeConfig(configPath, process.env, { force: true });

    const config = JSON.parse(await readFile(configPath, 'utf8'));
    expect(config.mcp[SERVER_NAME]).toEqual({
      type: 'local',
      command: [...PACKAGE_COMMAND],
      enabled: true,
    });
  });

  it('upgrades an existing OpenCode entry for this package', async () => {
    const root = await createTempDir();
    const configPath = join(root, 'opencode', 'opencode.json');
    await mkdir(join(root, 'opencode'), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        mcp: {
          [SERVER_NAME]: {
            type: 'local',
            command: ['npx', 'typegpu-runtime-inspector-mcp@0.0.0-test'],
            enabled: true,
          },
        },
      }),
    );

    await patchOpenCodeConfig(configPath, process.env, { upgrade: true });

    const config = JSON.parse(await readFile(configPath, 'utf8'));
    expect(config.mcp[SERVER_NAME]).toEqual({
      type: 'local',
      command: [...PACKAGE_COMMAND],
      enabled: true,
    });
  });

  it('adds the Zed context server while preserving settings comments', async () => {
    const root = await createTempDir();
    const configPath = join(root, 'zed', 'settings.json');
    await mkdir(join(root, 'zed'), { recursive: true });
    await writeFile(
      configPath,
      [
        '{',
        '  // Keep dark mode.',
        '  "theme": "One Dark",',
        '  "context_servers": {',
        '    "other_server": {',
        '      "source": "custom",',
        '      "command": "other-tool",',
        '      "args": []',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    expect(await patchZedSettings(configPath, process.env)).toBe('updated');

    const text = await readFile(configPath, 'utf8');
    expect(text).toContain('// Keep dark mode.');
    expect(text).toContain('"other_server"');
    const config = JSON.parse(
      text.replace(/^\s*\/\/.*$/gm, ''),
    );
    expect(config.context_servers[SERVER_NAME]).toEqual({
      source: 'custom',
      command: PACKAGE_COMMAND[0],
      args: PACKAGE_COMMAND.slice(1),
      env: {},
    });

    expect(await patchZedSettings(configPath, process.env)).toBe('unchanged');
  });

  it('creates the Zed settings file when absent', async () => {
    const root = await createTempDir();
    const configPath = join(root, 'zed', 'settings.json');

    expect(await patchZedSettings(configPath, process.env)).toBe('updated');

    const config = JSON.parse(await readFile(configPath, 'utf8'));
    expect(config.context_servers[SERVER_NAME].command).toBe('npx');
  });

  it('does not replace a different Zed entry without force', async () => {
    const root = await createTempDir();
    const configPath = join(root, 'zed', 'settings.json');
    await mkdir(join(root, 'zed'), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        context_servers: {
          [SERVER_NAME]: { source: 'custom', command: 'node', args: ['/old.js'] },
        },
      }),
    );

    await expect(patchZedSettings(configPath, process.env)).rejects.toThrow('--force');
  });

  it('does not replace a different OpenCode entry with upgrade', async () => {
    const root = await createTempDir();
    const configPath = join(root, 'opencode', 'opencode.json');
    await mkdir(join(root, 'opencode'), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        mcp: {
          [SERVER_NAME]: {
            type: 'local',
            command: ['node', '/old/server.js'],
            enabled: false,
          },
        },
      }),
    );

    await expect(patchOpenCodeConfig(configPath, process.env, { upgrade: true })).rejects.toThrow(
      '--force',
    );
  });
});

function createContext(
  commands: RecordedCommand[],
  options: {
    env?: NodeJS.ProcessEnv;
    commandExists?: SetupContext['commandExists'];
    resultFor?: (command: string, args: string[]) => CommandResult;
  } = {},
): SetupContext & { stdoutText(): string; stderrText(): string } {
  let stdout = '';
  let stderr = '';

  return {
    env: options.env ?? process.env,
    cwd: process.cwd(),
    stdout: {
      write(chunk: string | Uint8Array) {
        stdout += String(chunk);
        return true;
      },
    },
    stderr: {
      write(chunk: string | Uint8Array) {
        stderr += String(chunk);
        return true;
      },
    },
    runCommand: async (command, args, commandOptions) => {
      commands.push({ command, args, silent: commandOptions?.silent ?? false });
      return (
        options.resultFor?.(command, args) ??
        (args.join(' ') === `mcp get ${SERVER_NAME}` ? { code: 1 } : { code: 0 })
      );
    },
    commandExists: options.commandExists ?? (async () => true),
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

async function createTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'typegpu-mcp-cli-'));
  tempDirs.push(path);
  return path;
}
