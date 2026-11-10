import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: root,
  env: { ...process.env, PORT: '7100', HOST: '127.0.0.1', API_ONLY: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk; });
server.stderr.on('data', (chunk) => { serverOutput += chunk; });
let browser;
const errors = [];
const failedResponses = [];
fs.mkdirSync(new URL('../test-results', import.meta.url), { recursive: true });

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:7100/api/health');
      if (response.ok) return;
    } catch { /* Server is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not start.\n${serverOutput}`);
}

try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });
  page.on('dialog', (dialog) => void dialog.accept());

  await page.goto('http://127.0.0.1:7100/', { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Game Director', exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole('tab', { name: 'Memory', exact: true }).click();
  await page.locator('.memory-list button').filter({ hasText: '/PROJECT.md' }).click();
  const projectMemory = await page.locator('.memory-editor textarea').inputValue();
  assert(projectMemory.includes('NEON HARBOR'), 'The UI should show the persisted codename');

  const composer = page.getByLabel('Message the sticky agent');
  await composer.fill('Reply with exactly UI_OK. Do not use tools.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.locator('.agent-message').filter({ hasText: 'UI_OK' }).last().waitFor({ timeout: 120000 });
  console.log('[ui] Streaming conversation returned UI_OK');

  await page.getByRole('button', { name: 'New memory', exact: true }).click();
  await page.locator('.memory-editor input').fill('/notes/ui-check.md');
  await page.locator('.memory-editor textarea').fill('Temporary browser verification note.');
  await page.locator('.memory-save-row .primary').click();
  await page.locator('.memory-list button').filter({ hasText: '/notes/ui-check.md' }).waitFor();
  await page.locator('.memory-list button').filter({ hasText: '/notes/ui-check.md' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.locator('.memory-list button').filter({ hasText: '/notes/ui-check.md' }).waitFor({ state: 'detached' });
  console.log('[ui] Memory create, edit selection, and delete passed');

  await page.getByRole('tab', { name: 'Session', exact: true }).click();
  await page.getByText('Current spend', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'API', exact: true }).click();
  await page.locator('.code-block').filter({ hasText: '/v1/agents/game-director/messages' }).waitFor();
  await page.getByRole('button', { name: 'Create sticky agent', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.getByRole('tab', { name: 'Memory', exact: true }).click();
  await page.locator('.memory-list button').filter({ hasText: '/PROJECT.md' }).waitFor();
  await page.screenshot({ path: 'test-results/agent-relay-desktop.png', fullPage: true });
  console.log('[ui] Session, API, and dialog interactions passed');

  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Game Director', exact: true }).waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(overflow <= 1, `Mobile layout overflows by ${overflow}px`);
  await page.screenshot({ path: 'test-results/agent-relay-mobile.png', fullPage: true });
  const metrics = await page.evaluate(() => ({
    resources: performance.getEntriesByType('resource').length,
    transferBytes: performance.getEntriesByType('resource').reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
    navigationMs: Math.round(performance.getEntriesByType('navigation')[0]?.duration || 0),
  }));
  assert.deepEqual(errors, [], `Browser console errors: ${errors.join('\n')}`);
  assert.deepEqual(failedResponses, [], `Failed requests: ${failedResponses.join('\n')}`);
  console.log(JSON.stringify({ ok: true, consoleErrors: 0, failedRequests: 0, mobileOverflow: overflow, ...metrics }, null, 2));
} catch (error) {
  console.error(error.stack || error);
  if (serverOutput) console.error(serverOutput);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (!server.killed) server.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    server.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}
