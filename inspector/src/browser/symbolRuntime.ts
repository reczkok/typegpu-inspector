import {
  createFragmentTargetsLedgerEntry,
  createVertexAttribsLedgerEntry,
  createZeroValue,
  synthesizeFragmentTargets,
  synthesizeVertexAttribs,
  unwrapZeroValueSchema,
} from './engine/synthesis.ts';
import type { LedgerEntry } from './engine/types.ts';

// Generated inspection modules import the zero-value helpers from this module
// (GENERATED_TOP_LEVEL_BINDINGS contract) — keep re-exporting them here.
export { createZeroValue, unwrapZeroValueSchema };

type SelectorRoots = Record<string, unknown> & {
  setup?: unknown;
};

type SymbolBinding = {
  slot: string;
  value: string;
};

type RootLike = {
  with(slot: unknown, value: unknown): RootLike;
  createComputePipeline(descriptor: Record<string, unknown>): unknown;
  createRenderPipeline(descriptor: Record<string, unknown>): unknown;
};

type DataNamespace = {
  arrayOf(schema: unknown): unknown;
  isBuiltin?(schema: unknown): boolean;
};

type TypeGpuNamespace = {
  vertexLayout(schemaForCount: (count: number) => unknown): {
    attrib: unknown;
  };
};

export function readSelector(
  inspectedModule: unknown,
  selector: string,
  label: string,
  roots: SelectorRoots,
): unknown {
  if (typeof selector !== 'string' || selector.trim() === '') {
    throw new Error(`Empty selector for ${label}.`);
  }

  const parts = selector.split('.').filter(Boolean);
  let value = inspectedModule;

  if (parts.length > 0 && Object.prototype.hasOwnProperty.call(roots, parts[0])) {
    value = roots[parts.shift() as string];
  }

  for (const part of parts) {
    if (value === null || value === undefined || !(part in Object(value))) {
      throw new Error(`Could not resolve selector '${selector}' for ${label}; missing '${part}'.`);
    }
    value = (Object(value) as Record<string, unknown>)[part];
  }

  return value;
}

export function createComputePipeline(
  root: RootLike,
  inspectedModule: unknown,
  bindings: SymbolBinding[],
  roots: SelectorRoots,
  label: string,
  descriptor: Record<string, unknown>,
  compute: unknown,
): unknown {
  return applyBindings(root, inspectedModule, bindings, roots, label).createComputePipeline({
    ...descriptor,
    compute,
  });
}

export function createRenderPipeline(
  root: RootLike,
  tgpu: TypeGpuNamespace,
  d: DataNamespace,
  inspectedModule: unknown,
  bindings: SymbolBinding[],
  roots: SelectorRoots,
  label: string,
  descriptor: Record<string, unknown>,
  vertex: unknown,
  fragment: unknown,
  attribs: unknown,
  synthesizeMissing = true,
): { create: () => unknown; ledger: LedgerEntry[] } {
  const ledger: LedgerEntry[] = [];
  const finalDescriptor: Record<string, unknown> = { ...descriptor, vertex };

  if (fragment !== undefined) {
    finalDescriptor.fragment = fragment;
  }
  if (attribs !== undefined) {
    finalDescriptor.attribs = attribs;
  } else if (synthesizeMissing) {
    const synthesizedAttribs = synthesizeVertexAttribs(tgpu, d, vertex);
    if (Object.keys(synthesizedAttribs).length > 0) {
      finalDescriptor.attribs = synthesizedAttribs;
      ledger.push(createVertexAttribsLedgerEntry());
    }
  }

  if (
    fragment !== undefined &&
    finalDescriptor.targets === undefined &&
    synthesizeMissing
  ) {
    const targets = synthesizeFragmentTargets(d, fragment);
    if (targets !== undefined) {
      finalDescriptor.targets = targets;
      ledger.push(createFragmentTargetsLedgerEntry());
    }
  }

  return {
    ledger,
    create: () =>
      applyBindings(root, inspectedModule, bindings, roots, label)
        .createRenderPipeline(finalDescriptor),
  };
}

function applyBindings(
  root: RootLike,
  inspectedModule: unknown,
  bindings: SymbolBinding[],
  roots: SelectorRoots,
  label: string,
): RootLike {
  let branch = root;
  for (const [index, binding] of bindings.entries()) {
    const slot = readSelector(inspectedModule, binding.slot, `${label}.with[${index}].slot`, roots);
    if (typeof binding.value !== 'string' || binding.value.trim() === '') {
      throw new Error(
        `${label}.with[${index}].value is required. Provide an explicit setup/module selector for the resource to bind.`,
      );
    }
    branch = branch.with(
      slot,
      readSelector(inspectedModule, binding.value, `${label}.with[${index}].value`, roots),
    );
  }
  return branch;
}
