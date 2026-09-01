// Stands in for 'typegpu/~internal' when the inspected project's TypeGPU
// does not export it; statement maps are then not recorded. A TypeGPU that
// exports it but predates 0.12 records nothing either (see statementMap.ts).
export const WgslGenerator = undefined;
