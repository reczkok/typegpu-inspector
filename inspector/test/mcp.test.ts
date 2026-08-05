import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  INSPECT_TYPEGPU_TOOL_CONFIG,
  LIST_TYPEGPU_EXPORTS_TOOL_CONFIG,
  RESOLVE_TYPEGPU_CONTEXT_TOOL_CONFIG,
  createToolResult,
} from '../src/index.ts';

const cwd = resolve(import.meta.dirname, '..');

describe('MCP tool metadata', () => {
  it('declares trusted-code execution structured-output tools', () => {
    expect(INSPECT_TYPEGPU_TOOL_CONFIG.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(RESOLVE_TYPEGPU_CONTEXT_TOOL_CONFIG.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(INSPECT_TYPEGPU_TOOL_CONFIG.outputSchema).toBeDefined();
    expect(LIST_TYPEGPU_EXPORTS_TOOL_CONFIG.outputSchema).toBeDefined();
  });

  it('returns structured content plus a compact text summary', () => {
    const result = createToolResult({ ok: true, summary: { targetCount: 1 } });

    expect(result.structuredContent).toEqual({ ok: true, summary: { targetCount: 1 } });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('text');
    expect(result.content[0]?.text).toContain('ok: true');
    expect(result.content[0]?.text).not.toContain('"structuredContent"');
    expect(() => JSON.parse(result.content[0]?.text ?? '')).toThrow();
  });

  it('can mark agent-facing tool results as errors without throwing protocol errors', () => {
    const result = createToolResult({ ok: false, error: { message: 'bad input' } }, true);

    expect(result.isError).toBe(true);
    expect(result.structuredContent.ok).toBe(false);
  });

  it('advertises the compact agent-first tool set, prompts, and resources through MCP', async () => {
    const client = new Client({ name: 'typegpu-mcp-schema-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(cwd, 'bin/typegpu-runtime-inspector-mcp.mjs')],
      cwd,
      stderr: 'pipe',
    });

    try {
      await client.connect(transport);
      const result = await client.listTools();
      const agentTool = result.tools.find((entry) => entry.name === 'inspect_typegpu');
      expect(agentTool?.inputSchema.properties?.target).toBeDefined();
      expect(agentTool?.outputSchema?.properties?.resolvedContext).toBeDefined();
      expect(agentTool?.outputSchema?.properties?.summary).toBeDefined();
      expect(agentTool?.outputSchema?.properties?.targets).toBeDefined();
      expect(agentTool?.outputSchema?.properties?.dependencySummary).toBeDefined();
      expect(result.tools.map((entry) => entry.name).sort()).toEqual([
        'inspect_typegpu',
        'list_typegpu_exports',
        'resolve_typegpu_context',
      ]);

      const prompts = await client.listPrompts();
      expect(prompts.prompts.some((entry) => entry.name === 'inspect_typegpu_target')).toBe(true);

      const resources = await client.listResources();
      expect(resources.resources.map((entry) => entry.uri)).toEqual(
        expect.arrayContaining(['typegpu-inspector://workflow', 'typegpu-inspector://examples']),
      );
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});

describe('package public boundary', () => {
  it('blocks src deep imports through package exports', async () => {
    const privateSubpath = 'typegpu-runtime-inspector-mcp/src/inspect.ts';

    await expect(import(privateSubpath)).rejects.toThrow();
  });
});
