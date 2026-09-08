import type { TypegpuSymbolTarget } from '../types.ts';

/** A selected shader value and explicit/inferred argument plan become one standalone probe. */
export function buildHelperProbe(target: Extract<TypegpuSymbolTarget, { selector: string }>, index: number, selected: string) {
  const lines: string[] = [];
  let valueExpression = selected;
  let ledgerExpression = '[]';
  const probeArguments = target.probeArguments ?? [];
  const probeArgumentPlan =
    target.probeArgumentPlan ??
    probeArguments.map((schema) => ({ schema }));
  const probeBindings = target.probeBindings ?? [];
  if (probeArgumentPlan.length > 0 || probeBindings.length > 0) {
    const probePrelude: string[] = [];
    const argumentExpressions = probeArgumentPlan.map((argument, argumentIndex) => {
      if ('value' in argument) {
        // Resolve the selector root through readSelector so setup-returned
        // roots are honored, but keep the trailing property path inside the
        // probe body: accessors such as `.$` are only valid on the GPU side.
        const local = `__typegpuMcpProbeValue${index}_${argumentIndex}`;
        const { root, path } = splitSelectorRoot(argument.value);
        lines.push(
          `const ${local} = __typegpuMcpReadSelector(inspectedModule, ${JSON.stringify(
            root,
          )}, ${JSON.stringify(
            `targets[${index}].probeArgumentPlan[${argumentIndex}].value`,
          )}, roots);`,
        );
        return `${local}${path.map((part) => `[${JSON.stringify(part)}]`).join('')}`;
      }
      const ref = 'refSchema' in argument;
      const schema = normalizeSchemaSelector(
        ref ? argument.refSchema : argument.schema,
      );
      const local = `__typegpuMcpProbeSchema${index}_${argumentIndex}`;
      const schemaLabel = target.probeArgumentPlan
        ? `targets[${index}].probeArgumentPlan[${argumentIndex}].${ref ? 'refSchema' : 'schema'}`
        : `targets[${index}].probeArguments[${argumentIndex}]`;
      // Decorated schemas (d.align(...), d.size(...)) are descriptor objects
      // and are not callable; unwrap on the CPU so the probe body can still
      // build the zero value inside the shader.
      lines.push(
        `const ${local} = __typegpuMcpUnwrapZeroValueSchema(__typegpuMcpReadSelector(inspectedModule, ${JSON.stringify(
          schema,
        )}, ${JSON.stringify(schemaLabel)}, roots), ${JSON.stringify(schemaLabel)});`,
      );
      if (ref) {
        // Take the reference directly from a typed constructor expression.
        // An intermediate scalar variable becomes an alias in TGSL, and
        // taking a reference to that alias is illegal even when declared let.
        const refLocal = `__typegpuMcpProbeRef${index}_${argumentIndex}`;
        probePrelude.push(`const ${refLocal} = d.ref(${local}());`);
        return refLocal;
      }
      return `${local}()`;
    });
    const probe = `__typegpuMcpProbe${index}`;
    lines.push(
      `let ${probe} = tgpu.fn([])(() => {`,
      `  'use gpu';`,
      ...probePrelude.map((line) => `  ${line}`),
      `  ${selected}(${argumentExpressions.join(', ')});`,
      `});`,
    );
    for (const [bindingIndex, binding] of probeBindings.entries()) {
      const slotLocal = `__typegpuMcpProbeSlot${index}_${bindingIndex}`;
      const schemaLocal = `__typegpuMcpProbeBindingSchema${index}_${bindingIndex}`;
      const schemaLabel = `targets[${index}].probeBindings[${bindingIndex}].schema`;
      lines.push(
        `const ${slotLocal} = __typegpuMcpReadSelector(inspectedModule, ${JSON.stringify(
          binding.slot,
        )}, ${JSON.stringify(
          `targets[${index}].probeBindings[${bindingIndex}].slot`,
        )}, roots);`,
        `const ${schemaLocal} = __typegpuMcpReadSelector(inspectedModule, ${JSON.stringify(
          normalizeSchemaSelector(binding.schema),
        )}, ${JSON.stringify(schemaLabel)}, roots);`,
        `${probe} = ${probe}.with(${slotLocal}, __typegpuMcpCreateZeroValue(${schemaLocal}, ${JSON.stringify(
          schemaLabel,
        )}));`,
      );
    }
    valueExpression = probe;
    // Structured user-explicit provenance: these entries pre-satisfy the
    // requirements a probe wrapper exists for, so the engine never
    // re-extracts them, and the compat note derives from their provenance.
    ledgerExpression = JSON.stringify([
      {
        tier: 'target',
        kind: 'argument-values',
        key: `argument-values:${target.selector}`,
        status: 'satisfied',
        discoveredBy: 'shape',
        provider: target.context
          ? probeArgumentPlan.some(argument => !('value' in argument)) ? 'synthesis' : 'inspection-context'
          : target.probeContext ? 'synthesis' : 'user-explicit',
        provenance: probeArgumentPlan.length > 0
          ? describeProbeArgumentDefaults(probeArgumentPlan)
          : 'Called the selected zero-argument helper from an inspection wrapper.',
        detail: { argumentCount: probeArgumentPlan.length, arguments: probeArgumentPlan },
      },
      ...probeBindings.map((binding) => ({
        tier: 'resource',
        kind: 'slot-value',
        key: `slot-value:${binding.slot}`,
        status: 'satisfied',
        discoveredBy: 'shape',
        provider: 'user-explicit',
        provenance:
          `Bound inspection-only zero values for accessors: ${binding.slot}.`,
        detail: { slotName: binding.slot, schema: binding.schema },
      })),
    ]);
  }

  return { lines, valueExpression, ledgerExpression };
}

function splitSelectorRoot(selector: string): { root: string; path: string[] } {
  const parts = selector.split('.').filter(Boolean);
  const root = parts.shift() ?? selector;
  return { root, path: parts };
}

function normalizeSchemaSelector(selector: string): string {
  return selector.startsWith('d.') ? `ctx.${selector}` : selector;
}

function describeProbeArgumentDefaults(
  plan: Array<{ schema: string } | { refSchema: string } | { value: string }>,
): string {
  const schemas = plan.flatMap((entry) => 'schema' in entry ? [entry.schema] : []);
  const refs = plan.flatMap((entry) => 'refSchema' in entry ? [entry.refSchema] : []);
  const values = plan.flatMap((entry) => 'value' in entry ? [entry.value] : []);
  const details = [
    ...(schemas.length > 0
      ? [`zero values for: ${schemas.join(', ')}`]
      : []),
    ...(values.length > 0
      ? [`existing values for: ${values.join(', ')}`]
      : []),
    ...(refs.length > 0
      ? [`mutable reference locals for: ${refs.join(', ')}`]
      : []),
  ];
  return `Called the selected helper from a zero-argument tgpu.fn with ${details.join(' and ')}.`;
}
