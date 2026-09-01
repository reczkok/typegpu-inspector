import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open, readFile, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  chromium,
  type Browser,
  type BrowserContextOptions,
} from 'playwright-chromium';

/**
 * The inspector loads a loopback Vite server inside an isolated
 * Playwright context. Project Vite configs commonly enable HTTPS with a
 * development certificate (for example @vitejs/plugin-basic-ssl), which is
 * intentionally not trusted by Chromium. Trust it inside this disposable
 * inspection context so the harness behaves like the project's dev server
 * without requiring users to modify their machine certificate store.
 */
export const INSPECTOR_BROWSER_CONTEXT_OPTIONS = {
  ignoreHTTPSErrors: true,
} satisfies BrowserContextOptions;

const BROWSER_LAUNCH_ARGS = [
  '--enable-unsafe-webgpu',
  '--disable-gpu-sandbox',
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
];
let sharedBrowser: Browser | undefined;
let sharedBrowserPromise: Promise<Browser> | undefined;
let chromiumInstallPromise: Promise<void> | undefined;

export async function launchInspectorBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({
      headless: true,
      args: BROWSER_LAUNCH_ARGS,
    });
  } catch (error) {
    if (!isMissingChromiumError(error)) {
      throw error;
    }
    // npx installs this package without running playwright-chromium's browser
    // download script, so a cold machine reaches this point on every first
    // inspection. Self-heal instead of asking the user to run a command.
    try {
      await installChromiumOnce();
    } catch (installError) {
      throw new Error(
        `Could not launch Playwright Chromium for the TypeGPU inspector, and downloading it automatically failed.

${formatUnknownError(installError)}

${browserInstallHint()}`,
        { cause: error },
      );
    }
    return await chromium.launch({
      headless: true,
      args: BROWSER_LAUNCH_ARGS,
    });
  }
}

/** Downloads Chromium if this Playwright copy has none; call before starting an inspection budget. */
export async function ensureChromiumInstalled(): Promise<boolean> {
  if (existsSync(chromium.executablePath())) return false;
  await installChromiumOnce();
  return true;
}

/** Runs `playwright install chromium` from this package's own Playwright copy. */
function installChromiumOnce(): Promise<void> {
  if (!chromiumInstallPromise) {
    chromiumInstallPromise = runChromiumInstall().catch((error) => {
      chromiumInstallPromise = undefined;
      throw error;
    });
  }
  return chromiumInstallPromise;
}

async function runChromiumInstall(): Promise<void> {
  // Inspectors started together (a CLI per module, two editor windows) all
  // find the browser missing at once; one downloads while the others wait
  // on the lock and then find it installed.
  const releaseLock = await acquireChromiumInstallLock();
  try {
    if (existsSync(chromium.executablePath())) return;
    await downloadChromium();
  } finally {
    await releaseLock();
  }
}

function downloadChromium(): Promise<void> {
  // cli.js is not in the package's exports map (only the bin field points at
  // it), so resolve the exported package.json and join from its directory.
  const cli = join(
    dirname(createRequire(import.meta.url).resolve('playwright-chromium/package.json')),
    'cli.js',
  );
  const startedAt = performance.now();
  process.stderr.write(
    '[typegpu-inspector] Playwright Chromium is not installed; downloading it once (about 550 MB). This can take several minutes on a slow connection.\n',
  );
  return new Promise((resolveInstall, rejectInstall) => {
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const collect = (chunk: unknown) => {
      tail = `${tail}${String(chunk)}`.slice(-4_000);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', rejectInstall);
    child.on('close', (code) => {
      if (code === 0) {
        process.stderr.write(
          `[typegpu-inspector] Playwright Chromium downloaded in ${Math.round((performance.now() - startedAt) / 1000)}s.\n`,
        );
        resolveInstall();
      } else {
        rejectInstall(
          new Error(`playwright install chromium exited with code ${code}.\n${tail}`),
        );
      }
    });
  });
}

const CHROMIUM_INSTALL_LOCK_TIMEOUT_MS = 15 * 60_000;

/**
 * A pid-stamped lock file beside the system temp directory; a lock whose
 * owner is gone is taken over, and a wait that outlasts the timeout goes
 * ahead anyway rather than never installing.
 */
async function acquireChromiumInstallLock(): Promise<() => Promise<void>> {
  const lockPath = join(tmpdir(), 'typegpu-inspector-chromium-install.lock');
  const deadline = Date.now() + CHROMIUM_INSTALL_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => {
        await unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!(await lockOwnerAlive(lockPath))) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
  }
  return async () => undefined;
}

async function lockOwnerAlive(lockPath: string): Promise<boolean> {
  try {
    const pid = Number.parseInt(await readFile(lockPath, 'utf8'), 10);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function getSharedBrowser(): Promise<Browser> {
  if (sharedBrowser?.isConnected()) {
    return sharedBrowser;
  }

  if (!sharedBrowserPromise) {
    sharedBrowserPromise = launchInspectorBrowser()
      .then((browser) => {
        sharedBrowser = browser;
        browser.on('disconnected', () => {
          if (sharedBrowser === browser) {
            sharedBrowser = undefined;
          }
          sharedBrowserPromise = undefined;
        });
        return browser;
      })
      .catch((error) => {
        sharedBrowserPromise = undefined;
        throw error;
      });
  }

  return sharedBrowserPromise;
}

export async function closeSharedBrowser(): Promise<void> {
  const pending = sharedBrowserPromise;
  sharedBrowser = undefined;
  sharedBrowserPromise = undefined;
  const browser = await pending?.catch(() => undefined);
  if (sharedBrowser === browser) {
    sharedBrowser = undefined;
    sharedBrowserPromise = undefined;
  }
  await browser?.close().catch(() => undefined);
}

function isMissingChromiumError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Executable doesn\'t exist') ||
    message.includes('Please run the following command to download new browsers')
  );
}

function browserInstallHint(): string {
  return 'Install the browser manually with `npx -y playwright-chromium install chromium`, then run `npx -y typegpu-runtime-inspector-mcp@latest doctor` to verify setup.';
}
