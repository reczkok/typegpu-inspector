#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ClientRoot } from './context.ts';
import {
  agentInspectionInputSchema,
  agentInspectionOutputSchema,
  listTypegpuExportsInputSchema,
  listTypegpuExportsOutputSchema,
  resolveTypegpuContextInputSchema,
  resolveTypegpuContextOutputSchema,
} from './mcpSchemas.ts';
import { isRecord } from './shared.ts';

type AgentTools = typeof import('./agentTools.ts');
let agentToolsPromise: Promise<AgentTools> | undefined;

function loadAgentTools(): Promise<AgentTools> {
  agentToolsPromise ??= import('./agentTools.ts');
  return agentToolsPromise;
}

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

export const INSPECTION_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const INSPECT_TYPEGPU_TOOL_CONFIG = {
  title: 'Inspect TypeGPU',
  description:
    "Inspect TypeGPU code in a headless Chromium with WebGPU, from an inline probe, an inspection module, or exported symbols. Project/workspace roots, local TypeGPU dependencies, and Vite context are inferred; add project.root, project.dependencyAliases, target.virtualPath, or environment fields only when diagnostics ask for them. Modules run quiescently by default (frame loops, queue submits, and pipeline dispatch/draw stubbed), so a passing target means WebGPU accepted it and no frame was rendered; set environment.quiescent=false to observe real frame/submit behaviour. Returns summary, targets, dependencySummary, warnings, and nextActions.",
  inputSchema: agentInspectionInputSchema,
  outputSchema: agentInspectionOutputSchema,
  annotations: INSPECTION_TOOL_ANNOTATIONS,
} as const;

export const RESOLVE_TYPEGPU_CONTEXT_TOOL_CONFIG = {
  title: 'Resolve TypeGPU context',
  description:
    'Explain the inferred project, package, and workspace roots, TypeGPU dependency sources and versions, Vite config, warnings, and nextActions for a target path. Use when monorepo dependency resolution is uncertain.',
  inputSchema: resolveTypegpuContextInputSchema,
  outputSchema: resolveTypegpuContextOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
} as const;

export const LIST_TYPEGPU_EXPORTS_TOOL_CONFIG = {
  title: 'List TypeGPU exports',
  description:
    'Scan one TypeScript or JavaScript module for exported symbols and suggested inspect_typegpu symbol targets. Use before target.kind="symbols" when selector names are uncertain.',
  inputSchema: listTypegpuExportsInputSchema,
  outputSchema: listTypegpuExportsOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
} as const;

export function createTypegpuInspectorServer(): McpServer {
  const server = new McpServer(
    {
      name: 'typegpu-runtime-inspector',
      version: packageJson.version ?? '0.0.0',
    },
    {
      instructions:
        'Prefer inspect_typegpu for TypeGPU validation. Use resolve_typegpu_context to debug project/dependency inference and list_typegpu_exports to discover exported shader symbols before selector-based inspection.',
    },
  );

  server.registerTool('inspect_typegpu', INSPECT_TYPEGPU_TOOL_CONFIG, async (input, extra) => {
    const { inspectTypegpuTool } = await loadAgentTools();
    const result = await inspectTypegpuTool(input, {
      clientRoots: await readClientRoots(server, input.project?.root),
      signal: extra?.signal,
    });
    return createToolResult(result.structuredContent, result.isError);
  });

  server.registerTool(
    'resolve_typegpu_context',
    RESOLVE_TYPEGPU_CONTEXT_TOOL_CONFIG,
    async (input) => {
      const { resolveTypegpuContextTool } = await loadAgentTools();
      const result = await resolveTypegpuContextTool(input, {
        clientRoots: await readClientRoots(server, input.project?.root),
      });
      return createToolResult(result.structuredContent, result.isError);
    },
  );

  server.registerTool('list_typegpu_exports', LIST_TYPEGPU_EXPORTS_TOOL_CONFIG, async (input) => {
    const { listTypegpuExportsTool } = await loadAgentTools();
    const result = await listTypegpuExportsTool(input, {
      clientRoots: await readClientRoots(server, input.project?.root),
    });
    return createToolResult(result.structuredContent, result.isError);
  });

  registerAgentGuidance(server);

  return server;
}

export function createToolResult(formattedReport: unknown, isError = false) {
  const structuredContent = isRecord(formattedReport)
    ? formattedReport
    : { result: formattedReport };

  return {
    isError,
    structuredContent,
    content: [
      {
        type: 'text' as const,
        text: formatToolText(structuredContent, isError),
      },
    ],
  };
}

/**
 * Clients are not required to surface structuredContent (Claude Code shows
 * only the text block), so the text carries a headline plus the same JSON.
 */
function formatToolText(structuredContent: Record<string, unknown>, isError: boolean): string {
  const parts = [`ok: ${String(structuredContent.ok ?? !isError)}`];
  if (isRecord(structuredContent.summary)) {
    const targetCount = structuredContent.summary.targetCount;
    const passedTargetCount = structuredContent.summary.passedTargetCount;
    const failedTargetCount = structuredContent.summary.failedTargetCount;
    if (targetCount !== undefined || passedTargetCount !== undefined || failedTargetCount !== undefined) {
      parts.push(`targets: ${String(passedTargetCount ?? '?')}/${String(targetCount ?? '?')} passed`);
      if (failedTargetCount !== undefined) {
        parts.push(`failed: ${String(failedTargetCount)}`);
      }
    }
  }
  if (isRecord(structuredContent.dependencySummary)) {
    const hasFallback = structuredContent.dependencySummary.hasBundledTypegpuFallback;
    if (hasFallback === true) {
      parts.push('dependencySummary: bundled TypeGPU fallback detected');
    }
  }
  if (isRecord(structuredContent.error) && typeof structuredContent.error.message === 'string') {
    parts.push(`error: ${structuredContent.error.message}`);
  }
  if (Array.isArray(structuredContent.nextActions) && structuredContent.nextActions.length > 0) {
    parts.push(`nextActions: ${structuredContent.nextActions.length}`);
  }
  return `${parts.join('\n')}\n\n${JSON.stringify(structuredContent, null, 2)}`;
}

async function readClientRoots(
  server: McpServer,
  explicitRoot: string | undefined,
): Promise<ClientRoot[]> {
  if (explicitRoot) {
    return [];
  }
  if (!server.server.getClientCapabilities()?.roots) {
    return [];
  }
  try {
    const result = await server.server.listRoots(undefined, { timeout: 1500 });
    return result.roots;
  } catch {
    return [];
  }
}

function registerAgentGuidance(server: McpServer): void {
  server.registerPrompt(
    'inspect_typegpu_target',
    {
      title: 'Inspect TypeGPU target',
      description: 'Recommended workflow for validating TypeGPU code with this MCP.',
    },
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              'Prefer inspect_typegpu. It returns top-level summary, targets, dependencySummary, warnings, and nextActions. Use list_typegpu_exports for existing modules when selector names are unclear, and resolve_typegpu_context when dependency inference is uncertain. For probes with relative imports, set target.virtualPath inside the project/package. In monorepos, use a package-root project.dependencyAliases entry such as { "typegpu": "packages/typegpu/src" } when dependencySummary shows TypeGPU falling back to bundled dependencies.',
          },
        },
      ],
    }),
  );

  server.registerResource(
    'typegpu_inspector_workflow',
    'typegpu-inspector://workflow',
    {
      title: 'TypeGPU Inspector Workflow',
      description: 'Short agent workflow for successful TypeGPU MCP inspections.',
      mimeType: 'text/markdown',
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text:
            '# TypeGPU Inspector Workflow\n\n1. Call `inspect_typegpu` first. Read `summary`, `targets`, `dependencySummary`, `warnings`, and `nextActions` at the top level.\n2. For ad hoc code, use `target.kind: \"probe\"` and return one or more inspection targets.\n3. For probes that import nearby files, set `target.virtualPath` inside the project/package so relative imports resolve correctly.\n4. For existing code, call `list_typegpu_exports`, then inspect with `target.kind: \"symbols\"`.\n5. If imports or dependency resolution look wrong, call `resolve_typegpu_context` and retry with only the missing project/environment hint.\n6. In monorepos, if `dependencySummary.hasBundledTypegpuFallback` is true, set `project.root` to the workspace root and retry with a package-root alias such as `{ \"typegpu\": \"packages/typegpu/src\" }`.',
        },
      ],
    }),
  );

  server.registerResource(
    'typegpu_inspector_examples',
    'typegpu-inspector://examples',
    {
      title: 'TypeGPU Inspector Examples',
      description: 'Minimal inspect_typegpu payload examples.',
      mimeType: 'text/markdown',
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: `# TypeGPU Inspector Examples

Probe:
\`\`\`json
{"target":{"kind":"probe","body":"const main = tgpu.computeFn({ workgroupSize: [1] })(() => { 'use gpu'; }); return { label: 'main', kind: 'compute-pipeline', value: main };"}}
\`\`\`

Symbols:
\`\`\`json
{"target":{"kind":"symbols","modulePath":"src/shaders.ts","targets":[{"kind":"compute-pipeline","compute":"mainCompute"}]}}
\`\`\`

Pipeline factory:
\`\`\`json
{"target":{"kind":"symbols","modulePath":"src/shaders.ts","setupBody":"const scene = root.createUniform(module.SceneUniform, { time: 0 }); return { pipeline: module.createPipeline(root, 'bgra8unorm', scene) };","targets":[{"label":"factory pipeline","selector":"setup.pipeline","kind":"render-pipeline"}]}}
\`\`\`

Context:
\`\`\`json
{"targetPath":"apps/demo/src/shaders.ts"}
\`\`\``,
        },
      ],
    }),
  );
}

const SHUTDOWN_GRACE_MS = 3_000;
let shutdownHandlersRegistered = false;
let inspectorShutdown: Promise<void> | undefined;

/**
 * Reusable sessions own Chromium contexts and mkdtemp directories, so an
 * unhandled SIGINT/SIGTERM would leak both. Registration is idempotent.
 */
export function registerInspectorShutdownHandlers(): void {
  if (shutdownHandlersRegistered) {
    return;
  }
  shutdownHandlersRegistered = true;
  process.once('SIGINT', () => {
    void shutdownInspector(130);
  });
  process.once('SIGTERM', () => {
    void shutdownInspector(143);
  });
  process.once('SIGHUP', () => {
    void shutdownInspector(129);
  });
  process.once('beforeExit', () => {
    void shutdownInspector();
  });
}

export async function shutdownInspector(exitCode?: number): Promise<void> {
  inspectorShutdown ??= closeInspectorResources();
  await inspectorShutdown;
  if (exitCode !== undefined) {
    process.exit(exitCode);
  }
}

async function closeInspectorResources(): Promise<void> {
  // If no tool was called, none of the Vite/Chromium session code was loaded
  // and there cannot be resources to close. Avoid loading the entire runtime
  // inspection engine just to shut down an idle MCP process.
  if (!agentToolsPromise) return;

  let graceTimeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      (async () => {
        const [{ closeAllInspectorSessions }, { closeSharedBrowser }] = await Promise.all([
          import('./inspect/session.ts'),
          import('./inspect/browser.ts'),
        ]);
        await closeAllInspectorSessions();
        await closeSharedBrowser();
      })(),
      new Promise<void>((resolve) => {
        graceTimeout = setTimeout(resolve, SHUTDOWN_GRACE_MS);
        graceTimeout.unref?.();
      }),
    ]);
  } catch {
    // Best effort: a failed teardown must not block process exit.
  } finally {
    if (graceTimeout) {
      clearTimeout(graceTimeout);
    }
  }
}

export async function startMcpServer(): Promise<void> {
  const transport = new StdioServerTransport();
  registerInspectorShutdownHandlers();
  // The SDK transport only listens for stdin 'data'; EOF — the client process
  // exiting or dropping the pipe — is never surfaced. Without an explicit
  // exit, Chromium and Vite keep the event loop alive and every dead editor
  // session leaks a full inspector process tree.
  process.stdin.once('end', () => {
    void shutdownInspector(0);
  });
  process.stdin.once('close', () => {
    void shutdownInspector(0);
  });
  const server = createTypegpuInspectorServer();
  server.server.onclose = () => {
    void shutdownInspector(0);
  };
  await server.connect(transport);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startMcpServer();
}
