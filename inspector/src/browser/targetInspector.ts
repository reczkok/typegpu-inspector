import { tgpu, type Configurable as TgpuConfigurable } from 'typegpu';
import {
  MIN_BROWSER_WAIT_MS,
  serializeError,
  serializeCompilationMessage,
  summarizeCompilationMessages,
  withBrowserTimeout,
  type BrowserWaitBudget,
  type GpuRecorder,
} from './gpuRecorder.ts';
import {
  TargetDiagnosticError,
  classifyImmediatelyUnsupportedPipeline,
  classifyImmediatelyUnsupportedResolvable,
  createAutoBindingsNote,
  diagnoseTargetFailure,
} from './diagnostics.ts';
import {
  createEngineContext,
  createRequirementFailure,
  satisfiedSlotValues,
  satisfyAndAttempt,
  slotValueProvisions,
} from './engine/engine.ts';
import { collectShapeProvenances } from './engine/ledger.ts';
import type {
  EngineContext,
  LedgerEntry,
  RecordedBindingRegistry,
  TaggedBindingSource,
} from './engine/types.ts';
import {
  inferTargetKind,
  pipelineKindToResourceType,
  readResourceType,
  readTypegpuInternalProperty,
  readTypegpuSoulProperty,
  readTypegpuFunctionKind,
  summarizeTargetValue,
} from './typegpuIntrospection.ts';
import {
  flattenInspectableResources,
  inspectResolvedBindGroupLayouts,
  inspectResourceValue,
  shouldResolveResource,
  shouldUnwrapResource,
} from './resourceInspector.ts';
import type {
  InspectionTargetKind,
  RecordedGpuCall,
  ShaderCompilationMessage,
  TargetDiagnostic,
  TypeGpuTargetReport,
} from '../types.ts';
import { inferTargetOutcome } from './outcome.ts';
import {
  buildStatementMap,
  createStatementMapGenerator,
  currentRecorderSequence,
  findLatestRecordedFailure,
  findStatementMapForCode,
  type StatementMapRecorder,
} from './statementMap.ts';

export type TypeGpuInspectionTarget = {
  label?: string | undefined;
  kind?: InspectionTargetKind | undefined;
  value?: unknown;
  create?: (() => unknown) | undefined;
  error?: unknown;
  unwrap?: boolean | undefined;
  /** Structured provenance emitted by generated code (probes, synthesis). */
  ledger?: LedgerEntry[] | undefined;
};

export async function inspectPipelineTargets(
  targets: TypeGpuInspectionTarget[],
  root: ReturnType<typeof tgpu.initFromDevice>,
  recorder: GpuRecorder,
  strictNames: boolean,
  options: {
    waitBudget?: BrowserWaitBudget | undefined;
    bindingSources?: TaggedBindingSource[] | undefined;
    recorded?: RecordedBindingRegistry | undefined;
    autoBind?: boolean | undefined;
  } = {},
): Promise<TypeGpuTargetReport[]> {
  const waitBudget = options.waitBudget ?? (() => MIN_BROWSER_WAIT_MS);
  // Sibling target values participate as borrow sources so a bare fn can
  // reuse a binding its already-bound sibling target carries. Sources are
  // ranked module-scope before import-scope; first origin wins on duplicates.
  const taggedSources: TaggedBindingSource[] = [
    ...(options.bindingSources ?? []).filter((source) => source.origin === 'module-scope'),
    ...targets
      .map((target) => target.value)
      .filter((value) => value !== undefined)
      .map((value) => ({ value, origin: 'module-scope' as const })),
    ...(options.bindingSources ?? []).filter((source) => source.origin === 'import-scope'),
    ...(options.bindingSources ?? []).filter((source) => source.origin === 'importer-scope'),
  ];
  const autoBind = options.autoBind !== false;
  const reports: TypeGpuTargetReport[] = [];

  for (const [index, target] of targets.entries()) {
    const callStart = recorder.calls.length;
    const recorderSequence = currentRecorderSequence();
    let targetValue = target.value;
    const report: TypeGpuTargetReport = {
      label: target.label ?? `target ${index + 1}`,
      kind: target.kind ?? inferTargetKind(target.value),
      ok: false,
      diagnostics: [],
      compilationMessages: [],
      compilationSummary: summarizeCompilationMessages([]),
      callIds: [],
    };
    // One engine context per target: the wrapped-pipeline pre-resolution, the
    // pipeline resolution, and the pipeline re-creation all share the
    // requirements satisfied along the way, and nothing leaks across targets.
    const engine = createEngineContext({
      enabled: autoBind,
      sources: taggedSources,
      recorded: options.recorded,
    });
    const synthesisNotes = collectShapeProvenances(target.ledger ?? []);
    if (synthesisNotes.length > 0) {
      report.diagnostics = [
        {
          code: 'inspection-defaults-applied',
          severity: 'note',
          message: 'Missing runtime inputs were synthesized.',
          hint: synthesisNotes.join(' '),
        },
      ];
    }

    try {
      if ('error' in target && target.error !== undefined) {
        throw target.error;
      }

      const value = typeof target.create === 'function' ? target.create() : target.value;
      targetValue = value;
      if (target.kind === undefined) {
        report.kind = inferTargetKind(value);
      }
      if (report.kind === 'resource') {
        await validateResourceTarget(
          root,
          value,
          report,
          recorder,
          strictNames,
          waitBudget,
        );
      } else if (report.kind === 'resolvable' || target.unwrap === false) {
        await validateResolvableTarget(
          value,
          report,
          recorder,
          strictNames,
          waitBudget,
          false,
          engine,
        );
      } else {
        const wrappedPipeline = readPipelineWrapperValue(value, report.kind);
        if (wrappedPipeline !== undefined) {
          await validateResolvableTarget(
            wrappedPipeline,
            report,
            recorder,
            strictNames,
            waitBudget,
            true,
            engine,
          );
        }
        await validatePipelineTarget(
          root,
          value,
          report,
          recorder,
          strictNames,
          waitBudget,
          engine,
        );
      }

      await recorder.flushCompilationInfo();
      hydrateReportFromCalls(report, recorder.calls.slice(callStart), recorderSequence);
      report.ok = !hasCompilationErrors(report.compilationMessages);
    } catch (error) {
      if (
        isDeviceSessionUnavailable(error) &&
        (report.resource !== undefined || report.wgsl !== undefined)
      ) {
        addTargetDiagnostics(report, [createValidationUnavailableDiagnostic()]);
        await recorder.flushCompilationInfo().catch(() => undefined);
        hydrateReportFromCalls(report, recorder.calls.slice(callStart), recorderSequence);
        report.ok = true;
      } else {
        report.error = serializeError(error);
        addTargetDiagnostics(report, diagnoseTargetFailure(targetValue, report.kind, error));
        await recorder.flushCompilationInfo().catch(() => undefined);
        hydrateReportFromCalls(report, recorder.calls.slice(callStart), recorderSequence);
        // A failure recorded by the newest generator locates the statement
        // that aborted this target, but only while no WGSL was produced:
        // afterwards the error came from the compiler or WebGPU, not from
        // resolution.
        const failure = report.wgsl === undefined
          ? findLatestRecordedFailure(recorderSequence)
          : undefined;
        if (failure) {
          report.statementMap = { functions: report.statementMap?.functions ?? [], failure };
        }
        report.ok = false;
      }
    } finally {
      const targetCalls = recorder.calls.slice(callStart);
      annotateCalls(targetCalls, report.label, report.kind);
      report.callIds = targetCalls.map((call) => call.id);
      report.compilationSummary = summarizeCompilationMessages(report.compilationMessages);
      const ledger = [...(target.ledger ?? []), ...engine.ledger];
      if (ledger.length > 0) {
        report.ledger = ledger;
      }
      report.outcome = inferTargetOutcome(report);
      if (report.diagnostics?.length === 0) {
        delete report.diagnostics;
      }
      reports.push(report);
    }
  }

  return reports;
}

async function validateResourceTarget(
  root: ReturnType<typeof tgpu.initFromDevice>,
  value: unknown,
  report: TypeGpuTargetReport,
  recorder: GpuRecorder,
  strictNames: boolean,
  waitBudget: BrowserWaitBudget,
): Promise<void> {
  report.resource = inspectResourceValue(value);
  const values = flattenInspectableResources(value);
  const resolvable = values.filter(shouldResolveResource);

  if (values.length === 0) {
    addTargetDiagnostics(report, [{
      code: 'structural-resource-only',
      severity: 'note',
      message:
        'No TypeGPU resource or pipeline to validate; structure only.',
      hint:
        'Select the shader or pipeline itself to validate work behind object methods.',
    }]);
  }

  if (values.length === 1 && resolvable.length === 1) {
    try {
      await validateResolvableTarget(resolvable[0], report, recorder, strictNames, waitBudget);
    } catch (error) {
      addTargetDiagnostics(report, [{
        code: 'resource-wgsl-unavailable',
        message: 'Structural resource inspection succeeded, but standalone WGSL resolution did not.',
        hint: serializeError(error).message,
      }]);
      report.compilationMessages = [];
      delete report.wgsl;
      delete report.wgslSize;
      delete report.resolutionMs;
    }
  }

  const materializable = values.filter((value) =>
    shouldUnwrapResource(value) &&
    !isOwnedByDifferentDevice(value, recorder.device)
  );
  if (
    values.some((value) =>
      shouldUnwrapResource(value) &&
      isOwnedByDifferentDevice(value, recorder.device)
    )
  ) {
    addTargetDiagnostics(report, [{
      code: 'module-device-resource',
      message:
        'Not re-created on the inspector device: the resource belongs to the module’s own root.',
      hint:
        'Size, format, usage, schema, layout, and bindings are reported from the existing object.',
    }]);
  }
  if (materializable.length === 0) return;

  recorder.device.pushErrorScope('validation');
  let unwrapError: unknown;
  try {
    for (const resource of materializable) {
      try {
        root.unwrap(resource as never);
      } catch (error) {
        unwrapError ??= error;
      }
    }
  } finally {
    const validationError = await withBrowserTimeout(
      recorder.device.popErrorScope(),
      waitBudget(),
      `Timed out while validating resource '${report.label}'.`,
    );
    if (validationError) throw validationError;
  }
  if (unwrapError !== undefined) throw unwrapError;
}

export function normalizeTargets(
  value: TypeGpuInspectionTarget[] | TypeGpuInspectionTarget,
): TypeGpuInspectionTarget[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map((entry) => {
    if (
      entry &&
      typeof entry === 'object' &&
      ('value' in entry || 'create' in entry || 'error' in entry)
    ) {
      return entry;
    }
    return { value: entry };
  });
}

function annotateCalls(calls: RecordedGpuCall[], label: string, kind: InspectionTargetKind): void {
  for (const call of calls) {
    call.targetLabel = label;
    call.targetKind = kind;
  }
}

async function validatePipelineTarget(
  root: ReturnType<typeof tgpu.initFromDevice>,
  value: unknown,
  report: TypeGpuTargetReport,
  recorder: GpuRecorder,
  strictNames: boolean,
  waitBudget: BrowserWaitBudget,
  engine?: EngineContext,
): Promise<void> {
  const { device } = recorder;
  report.pipelineCreation = { attempted: true, ok: false, callIds: [] };

  const unsupportedPipelineDiagnostic = classifyImmediatelyUnsupportedPipeline(value, report.kind);
  if (unsupportedPipelineDiagnostic) {
    throw new TargetDiagnosticError(unsupportedPipelineDiagnostic.message, [
      unsupportedPipelineDiagnostic,
    ]);
  }

  if (report.wgsl === undefined) {
    await validateResolvableTarget(
      value,
      report,
      recorder,
      strictNames,
      waitBudget,
      true,
      engine,
    );
  }

  const inspectable = createInspectablePipelineTarget(
    root,
    value,
    report.kind,
    engine ? slotValueProvisions(engine) : [],
    engine?.providerContext.recorded,
  );
  if (isOwnedByDifferentDevice(inspectable, device)) {
    report.pipelineCreation.ok = true;
    return;
  }

  device.pushErrorScope('validation');
  let unwrapError: unknown;
  try {
    try {
      root.unwrap(inspectable as never);
    } catch (error) {
      const fallback = readPipelineWrapperValue(value, report.kind);
      if (fallback === undefined) {
        unwrapError = error;
      } else {
        addTargetDiagnostics(report, [
          {
            code: 'pipeline-wrapper-unwrapped',
            severity: 'note',
            message:
              'Validated the pipeline inside this wrapper.',
            hint:
              'The wrapper was unwrapped through its public field or soul metadata.',
            valueSummary: summarizeTargetValue(value),
          },
        ]);
        root.unwrap(fallback as never);
      }
    }
  } finally {
    const validationError = await withBrowserTimeout(
      device.popErrorScope(),
      waitBudget(),
      `Timed out while reading WebGPU validation scope for '${report.label}'.`,
    );
    if (validationError) {
      throw validationError;
    }
  }
  if (unwrapError !== undefined) {
    throw unwrapError;
  }
  report.pipelineCreation.ok = true;
}

function isOwnedByDifferentDevice(
  value: unknown,
  device: GPUDevice,
): boolean {
  const owner = readTypegpuSoulProperty(value, 'device');
  return owner !== undefined && owner !== device;
}

function createInspectablePipelineTarget(
  root: ReturnType<typeof tgpu.initFromDevice>,
  value: unknown,
  kind: InspectionTargetKind,
  slotProvisions: Array<[unknown, unknown]>,
  recorded?: RecordedBindingRegistry | undefined,
): unknown {
  // When the engine discovered slot provisions this pipeline needs, an
  // already-created pipeline cannot be retro-bound — but if the recording
  // shim saw it being created, it can be recreated from its own descriptor
  // and slot pairs plus the provisions. Without provisions the pipeline
  // validates directly via root.unwrap below; recreating it would only
  // duplicate creation calls. This is the only re-creation route for compute
  // pipelines (their bindings are private).
  const record = slotProvisions.length > 0
    ? (recorded?.pipelines ?? []).find((entry) => entry.pipeline === value)
    : undefined;
  if (record && record.descriptor && (record.kind === 'compute' || record.kind === 'render')) {
    try {
      let branch = root as unknown as {
        with(slot: unknown, slotValue: unknown): typeof branch;
        createComputePipeline(descriptor: unknown): unknown;
        createRenderPipeline(descriptor: unknown): unknown;
      };
      for (const pair of [...record.slotPairs, ...slotProvisions]) {
        branch = branch.with(pair[0] as never, pair[1] as never);
      }
      return record.kind === 'compute'
        ? branch.createComputePipeline(record.descriptor)
        : branch.createRenderPipeline(record.descriptor);
    } catch {
      // Recreation from the recording is best-effort; fall through.
    }
  }

  if (kind === 'compute-pipeline' && readTypegpuFunctionKind(value) === 'compute') {
    let branch = root as unknown as {
      with(slot: unknown, value: unknown): typeof branch;
      createComputePipeline(descriptor: unknown): unknown;
    };
    for (const [slot, slotValue] of slotProvisions) {
      branch = branch.with(slot as never, slotValue as never);
    }
    return branch.createComputePipeline({ compute: value as never });
  }
  if (kind === 'render-pipeline') {
    const core = readTypegpuInternalProperty(value, 'core');
    const options = readRecordProperty(core, 'options');
    const descriptor = readRecordProperty(options, 'descriptor');
    if (descriptor) {
      let branch = root as unknown as {
        with(slot: unknown, value: unknown): typeof branch;
        createRenderPipeline(descriptor: unknown): unknown;
      };
      const slotBindings = readProperty(options, 'slotBindings');
      if (Array.isArray(slotBindings)) {
        for (const binding of slotBindings) {
          if (Array.isArray(binding) && binding.length >= 2) {
            branch = branch.with(binding[0] as never, binding[1] as never);
          }
        }
      }
      // Engine provisions cover slots the authored bindings above left
      // unbound (resolution reported them missing), so appending them cannot
      // shadow an authored value.
      for (const [slot, slotValue] of slotProvisions) {
        branch = branch.with(slot as never, slotValue as never);
      }
      return branch.createRenderPipeline(descriptor);
    }
  }
  return value;
}

function readProperty(value: unknown, key: string): unknown {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined;
  }
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function readRecordProperty(
  value: unknown,
  key: string,
): Record<string, unknown> | undefined {
  const property = readProperty(value, key);
  return property && typeof property === 'object' && !Array.isArray(property)
    ? property as Record<string, unknown>
    : undefined;
}

async function validateResolvableTarget(
  value: unknown,
  report: TypeGpuTargetReport,
  recorder: GpuRecorder,
  strictNames: boolean,
  waitBudget: BrowserWaitBudget,
  allowPipeline = false,
  engine?: EngineContext,
): Promise<void> {
  const earlyDiagnostic = allowPipeline
    ? undefined
    : classifyImmediatelyUnsupportedResolvable(value);
  if (earlyDiagnostic) {
    throw new TargetDiagnosticError(earlyDiagnostic.message, [earlyDiagnostic]);
  }

  const { device } = recorder;
  const engineCtx = engine ?? createEngineContext({ enabled: false, sources: [] });
  const resolutionStart = performance.now();
  let statementRecorder: StatementMapRecorder | undefined;
  const result = satisfyAndAttempt(
    engineCtx,
    () => {
      const provisions = slotValueProvisions(engineCtx);
      const recording = createStatementMapGenerator();
      statementRecorder = recording?.recorder;
      return tgpu.resolveWithContext([value as never], {
        names: strictNames ? 'strict' : 'random',
        ...(recording ? { unstable_shaderGenerator: recording.generator } : {}),
        ...(provisions.length > 0
          ? {
            config: (cfg: TgpuConfigurable) =>
              provisions.reduce(
                (branch, [slot, slotValue]) =>
                  branch.with(slot as never, slotValue as never),
                cfg,
              ),
          }
          : {}),
      });
    },
    (requirement, error) =>
      createRequirementFailure(engineCtx, requirement, error, value),
  );
  report.resolutionMs = performance.now() - resolutionStart;
  report.wgsl = result.code;
  report.wgslSize = byteLength(result.code);
  const statementMap = statementRecorder
    ? buildStatementMap(statementRecorder, result.code)
    : undefined;
  if (statementMap) {
    report.statementMap = statementMap;
  }
  const bindGroupLayouts = inspectResolvedBindGroupLayouts(
    result.usedBindGroupLayouts,
  );
  if (bindGroupLayouts.length > 0) {
    report.bindGroupLayouts = bindGroupLayouts;
  }
  const autoBoundSlots = satisfiedSlotValues(engineCtx);
  if (autoBoundSlots.length > 0) {
    addTargetDiagnostics(report, [createAutoBindingsNote(autoBoundSlots)]);
  }

  device.pushErrorScope('validation');
  let validationError: GPUError | null = null;
  let validationOperationError: unknown;
  try {
    const module = device.createShaderModule({
      label: `${report.label} - Shader`,
      code: result.code,
    });
    const info = await withBrowserTimeout(
      module.getCompilationInfo(),
      waitBudget(),
      `Timed out while reading WGSL compilation info for '${report.label}'.`,
    );
    report.compilationMessages = info.messages.map(serializeCompilationMessage);
    const shaderCall = recorder.calls.findLast((call) => call.name === 'device.createShaderModule');
    if (shaderCall) {
      shaderCall.compilationMessages = report.compilationMessages;
    }
  } catch (error) {
    validationOperationError = error;
  } finally {
    try {
      validationError = await withBrowserTimeout(
        device.popErrorScope(),
        waitBudget(),
        `Timed out while reading WebGPU validation scope for '${report.label}'.`,
      );
    } catch (error) {
      validationOperationError ??= error;
    }
  }
  if (validationOperationError !== undefined) {
    if (!isDeviceSessionUnavailable(validationOperationError)) {
      throw validationOperationError;
    }
    addTargetDiagnostics(report, [createValidationUnavailableDiagnostic()]);
    return;
  }
  if (validationError) {
    throw validationError;
  }
  if (hasCompilationErrors(report.compilationMessages)) {
    throw new Error(`WGSL compilation failed for '${report.label}'.`);
  }
}

function isDeviceSessionUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Instance dropped|external Instance reference|device (?:was )?lost/i.test(message);
}

function createValidationUnavailableDiagnostic(): TargetDiagnostic {
  return {
    code: 'webgpu-validation-unavailable',
    severity: 'note',
    message: 'The WebGPU device was lost before validation completed.',
    hint: 'Structure and WGSL are included; rerun on a stable adapter to validate.',
  };
}

function readPipelineWrapperValue(
  value: unknown,
  kind: InspectionTargetKind,
): unknown | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  let candidate: unknown;
  try {
    candidate = (value as { pipeline?: unknown }).pipeline;
  } catch {
    candidate = undefined;
  }

  candidate ??= readTypegpuSoulProperty(value, 'pipeline');

  return readResourceType(candidate) === pipelineKindToResourceType(kind) ? candidate : undefined;
}

function addTargetDiagnostics(
  report: TypeGpuTargetReport,
  diagnostics: TargetDiagnostic[],
): void {
  if (diagnostics.length === 0) {
    return;
  }

  const existing = report.diagnostics ?? [];
  const seen = new Set(existing.map((diagnostic) => diagnostic.code));
  for (const diagnostic of diagnostics) {
    if (!seen.has(diagnostic.code)) {
      existing.push(diagnostic);
      seen.add(diagnostic.code);
    }
  }
  report.diagnostics = existing;
}

function hydrateReportFromCalls(
  report: TypeGpuTargetReport,
  calls: RecordedGpuCall[],
  recorderSequence: number,
): void {
  const shaderCalls = calls.filter((call) => call.name === 'device.createShaderModule');
  const pipelineCalls = calls.filter(
    (call) =>
      call.name === 'device.createComputePipeline' || call.name === 'device.createRenderPipeline',
  );

  if (!report.wgsl) {
    const descriptor = shaderCalls[0]?.descriptor;
    if (descriptor && typeof descriptor === 'object' && 'code' in descriptor) {
      report.wgsl = String(descriptor.code);
      report.wgslSize = byteLength(report.wgsl);
      const statementMap = findStatementMapForCode(report.wgsl, recorderSequence);
      if (statementMap) {
        report.statementMap = statementMap;
      }
    }
  }

  const messages = shaderCalls.flatMap((call) =>
    Array.isArray(call.compilationMessages) ? call.compilationMessages : [],
  );
  if (messages.length > 0) {
    report.compilationMessages = dedupeMessages([...report.compilationMessages, ...messages]);
  }

  if (report.pipelineCreation) {
    report.pipelineCreation.callIds = pipelineCalls.map((call) => call.id);
    report.pipelineCreation.ok =
      !report.error && (pipelineCalls.length === 0 || pipelineCalls.every((call) => call.ok === true));
    if (!report.error && pipelineCalls.length === 0) {
      addTargetDiagnostics(report, [
        {
          code: 'pipeline-validated-without-recorded-creation',
          severity: 'note',
          message:
            'Validated without a recorded createPipeline call.',
          hint:
            'Descriptors and per-call stats require the pipeline to be created inside the target.',
        },
      ]);
    }
  }
}

function dedupeMessages(messages: ShaderCompilationMessage[]): ShaderCompilationMessage[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    const key = `${message.type}:${message.lineNum}:${message.linePos}:${message.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function hasCompilationErrors(messages: ShaderCompilationMessage[]): boolean {
  return messages.some((message) => message.type === 'error');
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
