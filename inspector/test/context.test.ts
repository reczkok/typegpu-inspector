import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTypegpuContext } from '../src/context.ts';
import { listTypegpuExportsFromFile } from '../src/exportScanner.ts';
import { resolveTypegpuContextTool } from '../src/agentTools.ts';

describe('resolveTypegpuContext', () => {
  it('prefers explicit project roots over MCP roots', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'typegpu-context-explicit-'));
    const explicitRoot = join(tempDir, 'explicit');
    const mcpRoot = join(tempDir, 'mcp-root');
    await writePackage(explicitRoot, { name: 'explicit' });
    await writePackage(mcpRoot, { name: 'mcp-root' });

    const context = await resolveTypegpuContext({
      project: { root: explicitRoot },
      clientRoots: [{ uri: `file://${mcpRoot}` }],
      cwd: mcpRoot,
    });

    expect(context.projectRoot).toBe(explicitRoot);
    expect(context.rootSource).toBe('explicit-project-root');
    expect(context.packageRoot).toBe(explicitRoot);
  });

  it('detects nearest package and pnpm workspace roots for monorepo targets', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'typegpu-context-monorepo-'));
    const appRoot = join(workspaceRoot, 'apps/demo');
    const targetPath = join(appRoot, 'src/shaders.ts');
    await writePackage(workspaceRoot, { name: 'workspace', packageManager: 'pnpm@10.0.0' });
    await writeFile(join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
    await writePackage(appRoot, { name: 'demo' });
    await mkdir(join(appRoot, 'src'), { recursive: true });
    await writeFile(targetPath, 'export const shader = 1;\n');

    const context = await resolveTypegpuContext({ targetPath, cwd: workspaceRoot });

    expect(context.cwd).toBe(appRoot);
    expect(context.packageRoot).toBe(appRoot);
    expect(context.workspaceRoot).toBe(workspaceRoot);
    expect(context.workspaceKind).toBe('pnpm');
    expect(context.packageName).toBe('demo');
    expect(context.packageManager).toBe('pnpm@10.0.0');
  });

  it('resolves bare Vite config hints from the target package before the workspace root', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'typegpu-context-vite-package-'));
    const appRoot = join(workspaceRoot, 'apps/demo');
    const targetPath = join(appRoot, 'src/shaders.ts');
    await writePackage(workspaceRoot, { name: 'workspace', packageManager: 'pnpm@10.0.0' });
    await writeFile(join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
    await writeFile(join(workspaceRoot, 'vite.config.ts'), 'export default {};\n');
    await writePackage(appRoot, { name: 'demo' });
    await writeFile(join(appRoot, 'vite.config.ts'), 'export default {};\n');
    await mkdir(join(appRoot, 'src'), { recursive: true });
    await writeFile(targetPath, 'export const shader = 1;\n');

    const context = await resolveTypegpuContext({
      project: { root: workspaceRoot, viteConfigPath: 'vite.config.ts' },
      targetPath,
      cwd: workspaceRoot,
    });

    expect(context.viteConfigPath).toBe(join(appRoot, 'vite.config.ts'));
  });

  it('resolves workspace-relative Vite config hints after package-local candidates', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'typegpu-context-vite-workspace-'));
    const appRoot = join(workspaceRoot, 'apps/demo');
    const targetPath = join(appRoot, 'src/shaders.ts');
    await writePackage(workspaceRoot, { name: 'workspace', packageManager: 'pnpm@10.0.0' });
    await writeFile(join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
    await writePackage(appRoot, { name: 'demo' });
    await writeFile(join(appRoot, 'vite.config.ts'), 'export default {};\n');
    await mkdir(join(appRoot, 'src'), { recursive: true });
    await writeFile(targetPath, 'export const shader = 1;\n');

    const context = await resolveTypegpuContext({
      project: { root: workspaceRoot, viteConfigPath: 'apps/demo/vite.config.ts' },
      targetPath,
      cwd: workspaceRoot,
    });

    expect(context.viteConfigPath).toBe(join(appRoot, 'vite.config.ts'));
  });

  it('anchors virtual target paths to explicit roots even when the virtual file does not exist', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'typegpu-context-virtual-'));
    const appRoot = join(workspaceRoot, 'apps/demo');
    await writePackage(workspaceRoot, { name: 'workspace', packageManager: 'pnpm@10.0.0' });
    await writeFile(join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
    await writePackage(appRoot, { name: 'demo' });

    const context = await resolveTypegpuContext({
      project: { root: workspaceRoot },
      targetPath: 'apps/demo/src/__mcp_probe.ts',
      targetPathKind: 'virtual',
      cwd: resolve(import.meta.dirname, '..'),
    });

    expect(context.targetPath).toBe(join(workspaceRoot, 'apps/demo/src/__mcp_probe.ts'));
    expect(context.targetPathExists).toBe(false);
    expect(context.targetPathKind).toBe('virtual');
    expect(context.targetPathSource).toBe('explicit-project-root');
    expect(context.cwd).toBe(appRoot);
    expect(context.packageRoot).toBe(appRoot);
  });

  it('warns when a missing relative file path would resolve inside the bundled MCP package', async () => {
    const context = await resolveTypegpuContext({
      targetPath: 'apps/demo/src/missing.ts',
      cwd: resolve(import.meta.dirname, '..'),
    });

    expect(context.targetPathExists).toBe(false);
    expect(context.targetPathSource).toBe('bundled-fallback');
    expect(context.warnings.some((warning) => warning.includes('MCP package root'))).toBe(true);
  });

  it('uses nodeModulesDir as a dependency resolution hint', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'typegpu-context-node-modules-'));
    await writePackage(tempDir, { name: 'uses-node-modules-hint' });

    const context = await resolveTypegpuContext({
      project: {
        root: tempDir,
        nodeModulesDir: resolve(import.meta.dirname, '..', 'node_modules'),
      },
      cwd: tempDir,
    });

    expect(context.nodeModulesDir).toBe(resolve(import.meta.dirname, '..', 'node_modules'));
    expect(context.dependencies.typegpu?.source).toBe('nodeModulesDir');
    expect(context.dependencies['unplugin-typegpu/vite']?.source).toBe('nodeModulesDir');
  });

  it('warns when TypeGPU falls back to bundled dependencies in a monorepo without package links', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'typegpu-context-bundled-'));
    const appRoot = join(workspaceRoot, 'packages/demo');
    const targetPath = join(appRoot, 'src/shaders.ts');
    await writePackage(workspaceRoot, { name: 'workspace', packageManager: 'pnpm@10.0.0' });
    await writeFile(join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    await writePackage(appRoot, { name: 'demo' });
    await mkdir(join(appRoot, 'src'), { recursive: true });
    await writeFile(targetPath, 'export const shader = 1;\n');

    const context = await resolveTypegpuContext({
      project: { root: workspaceRoot },
      targetPath,
      cwd: workspaceRoot,
    });

    expect(context.dependencies.typegpu?.source).toBe('bundled');
    expect(context.dependencies['typegpu/data']?.source).toBe('bundled');
    expect(context.dependencies['typegpu/std']?.source).toBe('bundled');
    expect(context.dependencies['typegpu/common']?.source).toBe('bundled');
    expect(context.warnings.some((warning) => warning.includes('typegpu fell back'))).toBe(true);
  });

  it('uses project package-root aliases for TypeGPU core subpaths', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'typegpu-context-package-alias-'));
    const appRoot = join(workspaceRoot, 'packages/demo');
    const targetPath = join(appRoot, 'src/shaders.ts');
    const typegpuSourceRoot = join(workspaceRoot, 'packages/typegpu/src');
    await writePackage(workspaceRoot, { name: 'workspace', packageManager: 'pnpm@10.0.0' });
    await writeFile(join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    await writePackage(appRoot, { name: 'demo' });
    await writeTypegpuSourcePackage(workspaceRoot, '9.9.9');
    await mkdir(join(appRoot, 'src'), { recursive: true });
    await writeFile(targetPath, 'export const shader = 1;\n');

    const context = await resolveTypegpuContext({
      project: {
        root: workspaceRoot,
        dependencyAliases: { typegpu: 'packages/typegpu/src' },
      },
      targetPath,
      cwd: workspaceRoot,
    });

    expect(context.dependencyAliases.typegpu).toBe(typegpuSourceRoot);
    expect(context.dependencyResolution.packageAliases?.typegpu).toBe(typegpuSourceRoot);
    expect(context.dependencies.typegpu).toMatchObject({
      source: 'packageAlias',
      path: realpathSync.native(join(typegpuSourceRoot, 'index.ts')),
      version: '9.9.9',
    });
    expect(context.dependencies['typegpu/data']).toMatchObject({
      source: 'packageAlias',
      path: realpathSync.native(join(typegpuSourceRoot, 'data/index.ts')),
      version: '9.9.9',
    });
    expect(context.dependencies['typegpu/std']).toMatchObject({
      source: 'packageAlias',
      path: realpathSync.native(join(typegpuSourceRoot, 'std/index.ts')),
      version: '9.9.9',
    });
    expect(context.dependencies['typegpu/common']).toMatchObject({
      source: 'packageAlias',
      path: realpathSync.native(join(typegpuSourceRoot, 'common/index.ts')),
      version: '9.9.9',
    });
    expect(
      context.warnings.some((warning) => warning.includes('typegpu fell back')),
    ).toBe(false);
  });

  it('normalizes absolute project package-root aliases', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'typegpu-context-absolute-alias-'));
    const typegpuSourceRoot = join(workspaceRoot, 'packages/typegpu/src');
    await writePackage(workspaceRoot, { name: 'workspace' });
    await writeTypegpuSourcePackage(workspaceRoot, '9.9.10');

    const context = await resolveTypegpuContext({
      project: {
        root: workspaceRoot,
        dependencyAliases: { typegpu: typegpuSourceRoot },
      },
      cwd: workspaceRoot,
    });

    expect(context.dependencyAliases.typegpu).toBe(typegpuSourceRoot);
    expect(context.dependencies.typegpu).toMatchObject({
      source: 'packageAlias',
      path: realpathSync.native(join(typegpuSourceRoot, 'index.ts')),
      version: '9.9.10',
    });
  });

  it('warns when TypeGPU subpath aliases are provided without a root package alias', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'typegpu-context-subpath-alias-'));
    await writePackage(workspaceRoot, { name: 'workspace' });

    const context = await resolveTypegpuContext({
      project: {
        root: workspaceRoot,
        dependencyAliases: { 'typegpu/common': 'packages/typegpu/src/common' },
      },
      cwd: workspaceRoot,
    });

    expect(
      context.warnings.some((warning) =>
        warning.includes('TypeGPU subpath dependency aliases'),
      ),
    ).toBe(true);
    expect(context.dependencyResolution.packageAliases?.typegpu).toBeUndefined();
  });

  it('warns when resolved package versions differ from hints', async () => {
    const context = await resolveTypegpuContext({
      project: {
        root: resolve(import.meta.dirname, '..'),
        packageVersions: { typegpu: '0.0.0-test' },
      },
    });

    expect(context.warnings.some((warning) => warning.includes('0.0.0-test'))).toBe(true);
    expect(context.dependencies.typegpu?.warning).toContain('0.0.0-test');
  });

  it('returns sanitized agent-facing context and dependency summaries', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'typegpu-context-agent-output-'));
    const appRoot = join(workspaceRoot, 'packages/demo');
    const targetPath = join(appRoot, 'src/shaders.ts');
    await writePackage(workspaceRoot, { name: 'workspace', packageManager: 'pnpm@10.0.0' });
    await writeFile(join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    await writePackage(appRoot, { name: 'demo' });
    await writeTypegpuSourcePackage(workspaceRoot, '9.9.11');
    await mkdir(join(appRoot, 'src'), { recursive: true });
    await writeFile(targetPath, 'export const shader = 1;\n');

    const result = await resolveTypegpuContextTool(
      {
        project: {
          root: workspaceRoot,
          dependencyAliases: { typegpu: 'packages/typegpu/src' },
        },
        targetPath,
      },
      { cwd: workspaceRoot },
    );
    const json = JSON.stringify(result.structuredContent);

    expect(result.isError).toBe(false);
    expect(json).not.toContain(workspaceRoot);
    expect(json).not.toContain(tmpdir());
    expect(result.structuredContent.dependencySummary).toMatchObject({
      hasBundledTypegpuFallback: false,
      allCoreTypegpuFromPackageAlias: true,
    });
    expect(result.structuredContent.resolvedContext).toMatchObject({
      projectRoot: '<projectRoot>',
      packageRoot: '<packageRoot>',
      workspaceRoot: '<workspaceRoot>',
      pathAliases: expect.objectContaining({
        projectRoot: '<projectRoot>',
        packageRoot: '<packageRoot>',
      }),
    });
  });
});

describe('listTypegpuExportsFromFile', () => {
  it('lists exported symbols and flags likely TypeGPU exports', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'typegpu-export-scan-'));
    const modulePath = join(tempDir, 'shaders.ts');
    await writeFile(
      modulePath,
      `
import tgpu, { d } from 'typegpu';
export const helper = tgpu.fn([], d.f32)(() => { 'use gpu'; return 1; });
export const ParticleInstance = d.struct({ position: d.vec2f });
export const Vertex = d.struct({ position: d.vec3f });
export const computeLayout = tgpu.bindGroupLayout({ data: { storage: d.arrayOf(d.f32) } });
export const sizeSlot = tgpu.slot(d.vec2u(64, 64));
export const mainCompute = tgpu.computeFn({ workgroupSize: [1] })(() => { 'use gpu'; });
export const mainVertex = tgpu.vertexFn({ out: { position: d.builtin.position } })(() => {
  'use gpu';
  return { position: d.vec4f() };
});
export const mainFragment = tgpu.fragmentFn({ out: d.vec4f })(() => {
  'use gpu';
  return d.vec4f();
});
export const plainValue = 1;
export function computeLightDir(angle: number) { return [Math.cos(angle), 1, 0]; }
export function makePipeline() { return helper; }
export function createTerrainPipelines() { return makePipeline(); }
export const controls = defineControls({ color: d.vec3f(1, 1, 1) });
export function createResources(root: { createBuffer(input: unknown): unknown }) {
  return { buffer: root.createBuffer(d.arrayOf(d.f32, 4)) };
}
export function buildPipeline(root: { createRenderPipeline(input: unknown): unknown }) {
  return root.createRenderPipeline({});
}
`,
    );

    const result = await listTypegpuExportsFromFile(modulePath);

    expect(result.exports.map((entry) => entry.name)).toEqual([
      'helper',
      'ParticleInstance',
      'Vertex',
      'computeLayout',
      'sizeSlot',
      'mainCompute',
      'mainVertex',
      'mainFragment',
      'plainValue',
      'computeLightDir',
      'makePipeline',
      'createTerrainPipelines',
      'controls',
      'createResources',
      'buildPipeline',
    ]);
    expect(result.likelyTypegpuExports.map((entry) => entry.name)).toContain('helper');
    expect(result.exports.find((entry) => entry.name === 'helper')?.typegpuRole).toBe(
      'shader-helper',
    );
    expect(result.exports.find((entry) => entry.name === 'helper')?.suggestedTargetKind).toBe(
      'probe',
    );
    expect(result.exports.find((entry) => entry.name === 'ParticleInstance')?.typegpuRole).toBe(
      'schema',
    );
    expect(result.exports.find((entry) => entry.name === 'Vertex')?.typegpuRole).toBe('schema');
    expect(result.exports.find((entry) => entry.name === 'computeLayout')?.typegpuRole).toBe(
      'bind-group-layout',
    );
    expect(result.exports.find((entry) => entry.name === 'computeLayout')?.suggestedTargetKind)
      .toBeUndefined();
    expect(result.exports.find((entry) => entry.name === 'sizeSlot')?.typegpuRole).toBe(
      'binding-resource',
    );
    expect(result.exports.find((entry) => entry.name === 'mainCompute')?.typegpuRole).toBe(
      'compute-entrypoint',
    );
    expect(result.suggestedSymbolTargets).toContainEqual(
      expect.objectContaining({
        kind: 'resolvable',
        target: expect.objectContaining({ selector: 'helper', unwrap: false }),
      }),
    );
    expect(result.suggestedSymbolTargets).toContainEqual(
      expect.objectContaining({
        kind: 'compute-pipeline',
        target: expect.objectContaining({ compute: 'mainCompute' }),
      }),
    );
    expect(result.suggestedSymbolTargets).toContainEqual(
      expect.objectContaining({
        kind: 'render-pipeline',
        target: expect.objectContaining({ vertex: 'mainVertex', fragment: 'mainFragment' }),
      }),
    );
    expect(result.exports.find((entry) => entry.name === 'buildPipeline')?.typegpuRole)
      .toBe('pipeline-factory');
    expect(result.exports.find((entry) => entry.name === 'buildPipeline')?.suggestedTargetKind)
      .toBe('probe');
    expect(result.exports.find((entry) => entry.name === 'createResources')?.typegpuRole)
      .toBe('resource-factory');
    expect(result.exports.find((entry) => entry.name === 'createResources')?.suggestedTargetKind)
      .toBe('probe');
    expect(result.likelyTypegpuExports.map((entry) => entry.name)).not.toContain('plainValue');
    expect(result.likelyTypegpuExports.map((entry) => entry.name)).not.toContain('controls');
    expect(result.likelyTypegpuExports.map((entry) => entry.name)).not.toContain(
      'computeLightDir',
    );
    expect(result.likelyTypegpuExports.map((entry) => entry.name)).not.toContain(
      'createTerrainPipelines',
    );
  });

  it('suggests resolvable fallbacks for vertex-only exports', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'typegpu-export-vertex-only-'));
    const modulePath = join(tempDir, 'vertex.ts');
    await writeFile(
      modulePath,
      `
import tgpu, { d } from 'typegpu';
export const vertexFn = tgpu.vertexFn({ out: { position: d.builtin.position } })(() => {
  'use gpu';
  return { position: d.vec4f(0, 0, 0, 1) };
});
`,
    );

    const result = await listTypegpuExportsFromFile(modulePath);

    expect(result.suggestedSymbolTargets).toContainEqual(
      expect.objectContaining({
        kind: 'render-pipeline',
        target: expect.objectContaining({ vertex: 'vertexFn' }),
      }),
    );
    expect(result.suggestedSymbolTargets).toContainEqual(
      expect.objectContaining({
        kind: 'resolvable',
        target: expect.objectContaining({ selector: 'vertexFn', unwrap: false }),
      }),
    );
  });

  it('detects internal tagged-template vertex exports', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'typegpu-export-tagged-vertex-'));
    const modulePath = join(tempDir, 'full-screen.ts');
    await writeFile(
      modulePath,
      `
import { builtin } from '../builtin.ts';
import { vertexFn } from '../core/function/tgpuVertexFn.ts';
import { vec2f } from '../data/vector.ts';

export const fullScreenTriangle = vertexFn({
  in: { vertexIndex: builtin.vertexIndex },
  out: { pos: builtin.position, uv: vec2f },
})\`{
  return Out(vec4f(0, 0, 0, 1), vec2f(0, 0));
}\`;
`,
    );

    const result = await listTypegpuExportsFromFile(modulePath);
    const fullScreenTriangle = result.exports.find((entry) =>
      entry.name === 'fullScreenTriangle'
    );

    expect(fullScreenTriangle?.likelyTypegpu).toBe(true);
    expect(fullScreenTriangle?.typegpuRole).toBe('vertex-entrypoint');
    expect(result.suggestedSymbolTargets).toContainEqual(
      expect.objectContaining({
        kind: 'render-pipeline',
        target: expect.objectContaining({ vertex: 'fullScreenTriangle' }),
      }),
    );
    expect(result.suggestedSymbolTargets).toContainEqual(
      expect.objectContaining({
        kind: 'resolvable',
        target: expect.objectContaining({ selector: 'fullScreenTriangle', unwrap: false }),
      }),
    );
  });
});

async function writePackage(root: string, json: Record<string, unknown>): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), `${JSON.stringify(json, null, 2)}\n`);
}

async function writeTypegpuSourcePackage(workspaceRoot: string, version: string): Promise<void> {
  const packageRoot = join(workspaceRoot, 'packages/typegpu');
  await writePackage(packageRoot, { name: 'typegpu', version });
  for (const subdir of ['', 'data', 'std', 'common']) {
    const directory = join(packageRoot, 'src', subdir);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'index.ts'), 'export const marker = 1;\n');
  }
}
