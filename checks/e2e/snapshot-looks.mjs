import { spawn, spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputDir = path.join(root, '.dev-snapshots/m2');
const presets = ['plain', 'kraft', 'black', 'engineering'];
const disallowedPorts = new Set([4173, 5173]);
const cameraOrbit = { azimuthDeg: 35, elevationDeg: 25 };

function findOpenPort() {
  for (let port = 4317; port < 4417; port += 1) {
    if (disallowedPorts.has(port)) continue;
    const probe = spawnSync('lsof', ['-i', `:${port}`], { encoding: 'utf8' });
    if (probe.status === 1 && probe.stdout === '' && probe.stderr === '') {
      return port;
    }
    if (probe.status !== 0) {
      throw new Error(
        `Could not verify port ${port} with lsof (exit ${String(probe.status)}): ${probe.stderr.trim()}`,
      );
    }
  }
  throw new Error('No open snapshot port found between 4317 and 4416.');
}

function startDevServer(port) {
  return spawn(
    'npm',
    ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: root,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

async function waitForDevServer(server, baseUrl) {
  let stderr = '';
  server.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });

  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Vite dev server exited with ${server.exitCode}: ${stderr.trim()}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // The server socket is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite dev server did not become ready at ${baseUrl}.`);
}

async function stopDevServer(server) {
  if (server.exitCode !== null || server.pid === undefined) return;

  const exited = new Promise((resolve) => server.once('exit', resolve));
  process.kill(-server.pid, 'SIGTERM');
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!stopped && server.exitCode === null) {
    process.kill(-server.pid, 'SIGKILL');
    await exited;
  }
}

async function setSlider(page, value) {
  const range = page.locator('.foldbar input[type="range"]');
  await range.evaluate((element, nextValue) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    if (!setter) throw new Error('Native range value setter unavailable.');
    setter.call(element, nextValue);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, String(value));
  await page.waitForFunction(
    (expected) => document.querySelector('.foldbar input[type="range"]')?.value === expected,
    String(value),
  );
}

async function waitForStableRender(page) {
  const canvas = page.locator('.fold-canvas');
  let previous = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const current = await canvas.screenshot();
    if (previous?.equals(current)) return;
    previous = current;
    await page.waitForTimeout(100);
  }
  throw new Error('Fold canvas did not settle before snapshot.');
}

async function enterFoldMode(page, baseUrl) {
  await page.addInitScript(() => localStorage.setItem('od.lang', 'en'));
  await page.goto(baseUrl);
  await page.evaluate(() => document.fonts.ready);

  const dialog = page.getByRole('dialog');
  if (await dialog.isVisible()) {
    await dialog.getByRole('button', { name: 'Close' }).click();
  }

  await page.getByRole('button', { name: 'Fold', exact: true }).click();
  await page.locator('.fold-canvas').waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => typeof window.__p3SetLook === 'function'
      && typeof window.__p3SetCameraOrbit === 'function',
  );
  const autoRotate = page.locator('.foldbar .compat .tick');
  if (await autoRotate.isChecked()) await autoRotate.uncheck();
  if (await autoRotate.isChecked()) throw new Error('Auto-rotate must be off for look snapshots.');
}

async function setLook(page, preset) {
  await page.evaluate((name) => {
    const hook = window.__p3SetLook;
    if (typeof hook !== 'function') throw new Error('__p3SetLook DEV hook is unavailable.');
    hook(name);
  }, preset);
}

async function setCameraOrbit(page) {
  await page.evaluate(({ azimuthDeg, elevationDeg }) => {
    const hook = window.__p3SetCameraOrbit;
    if (typeof hook !== 'function') {
      throw new Error('__p3SetCameraOrbit DEV hook is unavailable.');
    }
    hook(azimuthDeg, elevationDeg);
  }, cameraOrbit);
}

const port = findOpenPort();
const baseUrl = `http://127.0.0.1:${port}`;
const server = startDevServer(port);
let browser;

try {
  await waitForDevServer(server, baseUrl);
  await mkdir(outputDir, { recursive: true });
  browser = await chromium.launch();
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  await enterFoldMode(page, baseUrl);

  for (const preset of presets) {
    await setLook(page, preset);
    for (const [value, suffix] of [[1, 't1'], [0.5, 't05']]) {
      await setSlider(page, value);
      await setCameraOrbit(page);
      await waitForStableRender(page);
      const filename = `p3m2-look-${preset}-${suffix}.png`;
      await page.screenshot({ path: path.join(outputDir, filename) });
      console.log(`SNAPSHOT ${filename}`);
    }
  }

  await context.close();
  console.log(`SNAPSHOTS-DONE count=${presets.length * 2} port=${port}`);
} finally {
  await browser?.close();
  await stopDevServer(server);
  console.log('DEV-SERVER-STOPPED');
}
