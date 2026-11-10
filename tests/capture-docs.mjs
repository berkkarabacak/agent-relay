import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { chromium } from '@playwright/test';

const port = 7199;
const server = spawn(process.execPath, ['server/index.mjs'], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGENT_RELAY_ACCESS_TOKEN: '' }, stdio: 'ignore' });
let browser;
try {
  for (let attempt = 0; attempt < 80; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch { /* Server is starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fs.mkdirSync('docs/assets', { recursive: true });
  browser = await chromium.launch({ headless: true, channel: process.env.CHROME_CHANNEL || 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: 'docs/assets/agent-relay-ui.png', fullPage: true });
  console.log('Captured AgentRelay UI for GitHub Pages.');
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
