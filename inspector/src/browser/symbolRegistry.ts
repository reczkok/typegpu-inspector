/** Per-page references to original lexical bindings. Nothing here evaluates a factory. */
type Scope = Record<string, unknown>;
type Instance = { value: unknown; scope: () => Scope };
type ModuleSymbols = { scope?: () => Scope; instances: Map<number, Instance[]> };
const modules = new Map<string, ModuleSymbols>();
const MAX_INSTANCES = 128;

/** Merge lookup scopes without reading unrelated bindings (which may still be in the TDZ). */
export function overlayScope(base: Scope, local: Scope, overrides: Scope = {}): Scope {
  return new Proxy({} as Scope, {
    get(_target, key) {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) return Reflect.get(overrides, key);
      return key in local ? Reflect.get(local, key) : Reflect.get(base, key);
    },
    has(_target, key) { return key in overrides || key in local || key in base; },
    getOwnPropertyDescriptor(_target, key) {
      if (key in overrides || key in local || key in base) {
        return { enumerable: true, configurable: true };
      }
      return undefined;
    },
  });
}

function symbols(path: string): ModuleSymbols {
  let value = modules.get(path);
  if (!value) modules.set(path, value = { instances: new Map() });
  return value;
}

export function registerModule(path: string, scope: () => Scope): void {
  symbols(path).scope = scope;
}

export function registerInstance(
  path: string, declaration: number, value: unknown, scope: () => Scope,
): void {
  const registry = symbols(path);
  let entries = registry.instances.get(declaration);
  if (!entries) registry.instances.set(declaration, entries = []);
  // Retain one overflow sentinel so selection cannot silently certify a truncated set.
  if (entries.length <= MAX_INSTANCES) entries.push({ value, scope });
}

export function moduleScope(path: string, exported: Scope): Scope {
  // Accessors preserve live bindings and avoid eagerly reading unrelated TDZs.
  return new Proxy({} as Scope, {
    get(_target, key) {
      const scope = symbols(path).scope?.();
      return scope && Object.prototype.hasOwnProperty.call(scope, key)
        ? Reflect.get(scope, key) : Reflect.get(exported, key);
    },
    has(_target, key) { return key in (symbols(path).scope?.() ?? {}) || key in exported; },
    ownKeys() { return [...new Set([...Reflect.ownKeys(exported), ...Reflect.ownKeys(symbols(path).scope?.() ?? {})])]; },
    getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; },
  });
}

export function selectInstances(path: string, declaration: number, instance?: number): Array<{
  value: unknown; scope: Scope; instance: number;
}> {
  const entries = symbols(path).instances.get(declaration) ?? [];
  if (entries.length === 0) {
    throw new Error('Could not resolve selector: this nested declaration has no runtime instance. Call its enclosing factory in setupBody or an inspection fixture.');
  }
  if (entries.length > MAX_INSTANCES) {
    throw new Error(`Could not resolve selector: more than ${MAX_INSTANCES} instances were created. Use a smaller inspection fixture.`);
  }
  if (instance !== undefined && (!Number.isInteger(instance) || instance < 0 || instance >= entries.length)) {
    throw new Error(`Could not resolve selector: instance ${instance} does not exist; available instance indices are 0–${entries.length - 1}.`);
  }
  return entries.flatMap((entry, index) => instance !== undefined && instance !== index
    ? [] : [{ value: entry.value, scope: entry.scope(), instance: index }]);
}
