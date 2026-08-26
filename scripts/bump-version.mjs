#!/usr/bin/env node
// Usage: node scripts/bump-version.mjs 0.5.1
// All manifests share one version; the server launches the inspector at its own version.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// semver.org recommended pattern.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const TARGETS = [
  { file: 'Cargo.toml', kind: 'toml' },
  { file: 'extension.toml', kind: 'toml' },
  { file: 'package.json', kind: 'json' },
  { file: 'server/package.json', kind: 'json' },
  { file: 'editors/vscode/package.json', kind: 'json' },
  { file: 'inspector/package.json', kind: 'json' },
];

function fail(message) {
  process.stderr.write(`bump-version: ${message}\n`);
  process.exit(1);
}

function bumpJson(text, version) {
  // Top-level key only; dependency pins keep their values.
  const match = /^(\s*"version"\s*:\s*)"[^"]*"/m.exec(text);
  if (!match) return undefined;
  return `${text.slice(0, match.index)}${match[1]}"${version}"${
    text.slice(match.index + match[0].length)
  }`;
}

function bumpToml(text, version) {
  // First match only; later `version =` lines belong to [dependencies].
  const match = /^version\s*=\s*"[^"]*"/m.exec(text);
  if (!match) return undefined;
  return `${text.slice(0, match.index)}version = "${version}"${
    text.slice(match.index + match[0].length)
  }`;
}

const [, , requested, ...rest] = process.argv;
if (!requested || rest.length > 0) {
  fail('usage: node scripts/bump-version.mjs <version>');
}
if (!SEMVER.test(requested)) {
  fail(
    `"${requested}" is not a semantic version (expected e.g. 0.5.1 or 1.0.0-rc.1).`,
  );
}

const changed = [];
const unchanged = [];
for (const target of TARGETS) {
  const absolute = join(repoRoot, target.file);
  let text;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch (error) {
    fail(`could not read ${target.file} (${error.message}).`);
  }
  const next = target.kind === 'json'
    ? bumpJson(text, requested)
    : bumpToml(text, requested);
  if (next === undefined) {
    fail(`could not find a version field in ${target.file}.`);
  }
  if (next === text) {
    unchanged.push(target.file);
    continue;
  }
  writeFileSync(absolute, next);
  changed.push(target.file);
}

process.stdout.write(`Version set to ${requested}\n`);
for (const file of changed) {
  process.stdout.write(`  updated  ${relative(repoRoot, join(repoRoot, file))}\n`);
}
for (const file of unchanged) {
  process.stdout.write(`  already  ${file}\n`);
}
process.stdout.write(
  '\nRun `cargo check` to refresh Cargo.lock, then update CHANGELOG.md before tagging.\n',
);
