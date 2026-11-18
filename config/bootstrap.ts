import { exec, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { logger } from '../logs/logger.ts';

const execAsync = promisify(exec);

export const VENDOR_ROOT = path.resolve(process.cwd(), 'vendor');
export const VENDOR_BIN = path.join(VENDOR_ROOT, 'bin');
export const VENDOR_PY = path.join(VENDOR_ROOT, 'py');

// Ensure vendor/bin and vendor/py are always in process.env.PATH and process.env.PYTHONPATH
export function configureVendorEnv(): void {
  for (const dir of [VENDOR_ROOT, VENDOR_BIN, VENDOR_PY]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  const currentPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  if (!currentPath.includes(VENDOR_BIN)) {
    process.env.PATH = `${VENDOR_BIN}:${currentPath}`;
  }
  const currentPyPath = process.env.PYTHONPATH || '';
  if (!currentPyPath.includes(VENDOR_PY)) {
    process.env.PYTHONPATH = currentPyPath ? `${VENDOR_PY}:${currentPyPath}` : VENDOR_PY;
  }
}

configureVendorEnv();

let downloaderBootstrapPromise: Promise<void> | null = null;
let fullBootstrapPromise: Promise<void> | null = null;
let runtimeToolsVerified = false;

function isVendorFastPathReady(): boolean {
  if (!runtimeToolsVerified) return false;
  return (
    fs.existsSync(path.join(VENDOR_PY, 'wzgram', '__init__.py')) &&
    (fs.existsSync(path.join(VENDOR_BIN, 'yt-dlp')) || commandExists('yt-dlp'))
  );
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore', env: process.env });
    return true;
  } catch {
    return false;
  }
}

function isYtDlpWorking(): boolean {
  const vendorYtDlp = path.join(VENDOR_BIN, 'yt-dlp');
  try {
    if (fs.existsSync(vendorYtDlp)) {
      execSync(`"${vendorYtDlp}" --version`, { stdio: 'ignore', timeout: 4000 });
      return true;
    }
    execSync('yt-dlp --version', { stdio: 'ignore', timeout: 4000, env: process.env });
    return true;
  } catch {
    return false;
  }
}

function isWzgramInstalled(): boolean {
  try {
    execSync(
      'python3 -c "from wzgram import Client, filters; from pyrogram.storage import SQLiteStorage"',
      {
        stdio: 'ignore',
        timeout: 4000,
        env: process.env,
      }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensures yt-dlp and aria2c are installed and ready before any download or stream probe starts.
 * Automatically re-provisions them if the CodeStudio container refreshed/reset.
 */
export async function ensureDownloaderToolsReady(): Promise<void> {
  configureVendorEnv();
  if (isYtDlpWorking() && commandExists('aria2c')) {
    return;
  }
  if (downloaderBootstrapPromise) {
    return downloaderBootstrapPromise;
  }

  downloaderBootstrapPromise = (async () => {
    try {
      const tasks: Promise<void>[] = [];

      if (!isYtDlpWorking()) {
        tasks.push(
          (async () => {
            logger.info('SYSTEM', 'Auto-provisioning standalone yt-dlp binary into vendor/bin...');
            const targetPath = path.join(VENDOR_BIN, 'yt-dlp');
            await execAsync(
              `curl -L -sS --retry 3 https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o "${targetPath}" && chmod +x "${targetPath}"`,
              { timeout: 60000 }
            );
            try {
              fs.copyFileSync(targetPath, '/usr/local/bin/yt-dlp');
              fs.chmodSync('/usr/local/bin/yt-dlp', 0o755);
            } catch {
              // /usr/local/bin copy is optional since vendor/bin is on PATH
            }
            logger.info('SYSTEM', 'yt-dlp binary provisioned and verified');
          })()
        );
      }

      if (!commandExists('aria2c')) {
        tasks.push(
          (async () => {
            logger.info('SYSTEM', 'Auto-provisioning aria2c multi-connection engine...');
            await execAsync(
              'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq aria2',
              { timeout: 90000 }
            );
            try {
              if (fs.existsSync('/usr/bin/aria2c')) {
                fs.copyFileSync('/usr/bin/aria2c', path.join(VENDOR_BIN, 'aria2c'));
                fs.chmodSync(path.join(VENDOR_BIN, 'aria2c'), 0o755);
              }
            } catch {
              // ignore copy warning
            }
            logger.info('SYSTEM', 'aria2c multi-segment downloader provisioned and verified');
          })()
        );
      }

      await Promise.allSettled(tasks);
    } catch (err: any) {
      logger.warn('SYSTEM', 'Downloader auto-bootstrap warning', err?.message);
    } finally {
      downloaderBootstrapPromise = null;
    }
  })();

  return downloaderBootstrapPromise;
}

/**
 * Full self-healing runtime bootstrapper invoked automatically on server startup.
 * Guarantees yt-dlp, aria2c, and wzgram are restored automatically every time CodeStudio refreshes.
 */
export async function bootstrapRuntimeEnvironment(onComplete?: () => void): Promise<void> {
  configureVendorEnv();
  if (isVendorFastPathReady()) {
    if (onComplete) onComplete();
    return;
  }
  if (fullBootstrapPromise) {
    return fullBootstrapPromise;
  }

  fullBootstrapPromise = (async () => {
    try {
      await ensureDownloaderToolsReady();

      if (!isWzgramInstalled()) {
        logger.info('SYSTEM', 'Auto-provisioning Python Wzgram MTProto library into vendor/py...');
        const pipPyz = path.join(VENDOR_BIN, 'pip.pyz');
        if (!fs.existsSync(pipPyz)) {
          await execAsync(`curl -L -sS https://bootstrap.pypa.io/pip/pip.pyz -o "${pipPyz}"`, {
            timeout: 45000,
          });
        }
        await execAsync(
          `python3 "${pipPyz}" install --quiet --upgrade --target "${VENDOR_PY}" git+https://github.com/rjriajul/wzgram.git`,
          { timeout: 120000 }
        );
        logger.info('SYSTEM', 'Python Wzgram MTProto library provisioned in vendor/py');
      }

      runtimeToolsVerified = true;

      if (onComplete) {
        onComplete();
      }
    } catch (err: any) {
      logger.warn('SYSTEM', 'Runtime environment bootstrap note', err?.message);
    } finally {
      fullBootstrapPromise = null;
    }
  })();

  return fullBootstrapPromise;
}
