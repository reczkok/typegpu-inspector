import { tgpu, d } from 'typegpu';

const state = globalThis as typeof globalThis & { __symbolFixtureImports?: number };
state.__symbolFixtureImports = (state.__symbolFixtureImports ?? 0) + 1;
const loadCount = tgpu.fn([], d.u32)(() => { 'use gpu'; return d.u32(state.__symbolFixtureImports!); });

function makeBlur(radius: number) {
  const helper = tgpu.fn([], d.f32)(() => { 'use gpu'; return d.f32(radius); });
  // Intentionally never returned or exported.
  void helper;
}

makeBlur(3);
makeBlur(7);

function createLater(radius: number) {
  const delayed = tgpu.fn([], d.f32)(() => { 'use gpu'; return d.f32(radius); });
  void delayed;
}

const bias = tgpu.slot<number>();
const withBias = tgpu.fn([], d.f32)(() => { 'use gpu'; return d.f32(bias.$); });

function createInvalid() {
  const invalid = tgpu.fn([], d.f32)`() -> f32 { return definitely_missing_symbol; }`;
  void invalid;
}

createInvalid();

function plusOne(value: number) {
  'use gpu';
  return value + 1;
}

function makeAdjusted(radius: number) {
  const adjusted = (coord: d.v2i) => {
    'use gpu';
    return d.i32(radius) + coord.x;
  };
  void adjusted;
}
