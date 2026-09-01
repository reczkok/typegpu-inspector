import { createFsModuleUrl } from './paths.ts';

/**
 * Generates the typegpu recording shim: a module served in place of the bare
 * 'typegpu' specifier that re-exports the real package and wraps ONLY the
 * public root API so the application's own slot bindings, pipeline creations,
 * and uniform initial values are recorded into a per-page registry the
 * requirement engine reads as the recorded-app-bindings provider.
 *
 * Invariants:
 * - Values are never wrapped: pipelines, functions, slots, buffers keep their
 *   original identity (WeakMap metadata, slot equality). Only root/branch
 *   objects get a forwarding Proxy, and every intercepted method falls back
 *   to the direct call on any error.
 * - The shim imports the real package by /@fs/ URL, which the alias table
 *   never matches — no recursion, and one shared module instance with the
 *   typegpu/data|std|common subpaths.
 */
export function buildRecordingShimModule(realTypegpuPath: string): string {
  const realUrl = createFsModuleUrl(realTypegpuPath);
  return `export * from ${JSON.stringify(realUrl)};
import __typegpuMcpRealDefault from ${JSON.stringify(realUrl)};
import * as __typegpuMcpRealNamespace from ${JSON.stringify(realUrl)};

const __typegpuMcpRegistry = (globalThis.__typegpuMcpRecording ??= {
  roots: [],
  slotBindings: [],
  pipelines: [],
  uniforms: [],
  frozen: false,
});

function __typegpuMcpRecord(collection, entry) {
  if (__typegpuMcpRegistry.frozen) return;
  try {
    __typegpuMcpRegistry[collection].push(entry);
  } catch {
    // Recording must never break the application.
  }
}

const __typegpuMcpRootHandlers = {
  with(target, pairs, args) {
    __typegpuMcpRecord('slotBindings', [args[0], args[1]]);
    return __typegpuMcpWrapRoot(target.with(...args), [...pairs, [args[0], args[1]]]);
  },
  createComputePipeline(target, pairs, args) {
    const pipeline = target.createComputePipeline(...args);
    __typegpuMcpRecord('pipelines', { kind: 'compute', descriptor: args[0], slotPairs: pairs, pipeline });
    return pipeline;
  },
  createRenderPipeline(target, pairs, args) {
    const pipeline = target.createRenderPipeline(...args);
    __typegpuMcpRecord('pipelines', { kind: 'render', descriptor: args[0], slotPairs: pairs, pipeline });
    return pipeline;
  },
  createGuardedComputePipeline(target, pairs, args) {
    const pipeline = target.createGuardedComputePipeline(...args);
    __typegpuMcpRecord('pipelines', { kind: 'guarded-compute', slotPairs: pairs, pipeline });
    return pipeline;
  },
  createUniform(target, pairs, args) {
    const uniform = target.createUniform(...args);
    __typegpuMcpRecord('uniforms', { schema: args[0], initial: args[1], uniform });
    return uniform;
  },
  pipe(target, pairs, args) {
    // typegpu hands the transform a fresh configurable and merges the
    // bindings it returns into a new branch. Reading them off that return
    // value keeps bindings made inside a transform recorded, and re-wrapping
    // the branch keeps recording whatever is bound on it afterwards.
    const transform = args[0];
    let added = [];
    const observed = typeof transform === 'function'
      ? (configurable) => {
          const result = transform(configurable);
          if (Array.isArray(result?.bindings)) added = result.bindings;
          return result;
        }
      : transform;
    const branch = target.pipe(observed, ...args.slice(1));
    const addedPairs = added.filter((pair) => Array.isArray(pair) && pair.length >= 2);
    for (const pair of addedPairs) __typegpuMcpRecord('slotBindings', [pair[0], pair[1]]);
    return __typegpuMcpWrapRoot(branch, [...pairs, ...addedPairs]);
  },
};

function __typegpuMcpWrapRoot(root, pairs) {
  if (!root || (typeof root !== 'object' && typeof root !== 'function')) return root;
  return new Proxy(root, {
    get(target, property) {
      const handler = Object.prototype.hasOwnProperty.call(__typegpuMcpRootHandlers, property)
        ? __typegpuMcpRootHandlers[property]
        : undefined;
      if (handler && typeof target[property] === 'function') {
        return (...args) => {
          try {
            return handler(target, pairs, args);
          } catch {
            return target[property](...args);
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function __typegpuMcpWrapTgpu(target) {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) return target;
  return new Proxy(target, {
    get(target, property) {
      if (property === 'init') {
        return async (...args) => {
          const inspectorDevice = globalThis.__typegpuMcpInspectorDevice;
          const root = __typegpuMcpWrapRoot(
            inspectorDevice
              ? target.initFromDevice({ device: inspectorDevice })
              : await target.init(...args),
            [],
          );
          if (inspectorDevice) __typegpuMcpRegistry.usedInspectorDevice = true;
          __typegpuMcpRecord('roots', root);
          return root;
        };
      }
      if (property === 'initFromDevice') {
        return (...args) => {
          const root = __typegpuMcpWrapRoot(target.initFromDevice(...args), []);
          __typegpuMcpRecord('roots', root);
          return root;
        };
      }
      return Reflect.get(target, property, target);
    },
  });
}

const __typegpuMcpTgpu = __typegpuMcpWrapTgpu(__typegpuMcpRealDefault);
export const tgpu = __typegpuMcpWrapTgpu(__typegpuMcpRealNamespace.tgpu);
export default __typegpuMcpTgpu;
`;
}
