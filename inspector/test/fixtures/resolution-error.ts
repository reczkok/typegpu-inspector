// @ts-nocheck
export async function inspect() {
  const unresolvedFunction = (value) => {
    'use gpu';
    return value;
  };

  return {
    label: 'resolution error',
    kind: 'resolvable',
    value: unresolvedFunction,
  };
}
