import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packageJson: { version: string } = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
);

// Mirror the `--define` values from the `build` script so tests exercise the
// same version strings the bundled server ships with (see src/buildInfo.d.ts).
export default defineConfig({
  define: {
    __TYPEGPU_SERVER_VERSION__: JSON.stringify(packageJson.version),
    __TYPEGPU_INSPECTOR_VERSION__: JSON.stringify(packageJson.version),
  },
});
