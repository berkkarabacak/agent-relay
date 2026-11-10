import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const child = spawn(process.execPath, ['scripts/dev.mjs', '--host', '127.0.0.1', '--port', '7101'], {
  cwd: root,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const health = await fetch('http://127.0.0.1:7101/api/health');
      if (health.ok) { ready = true; break; }
    } catch { /* Vite and the API are starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert(ready, `Development server did not start.\n${output}`);
  const page = await fetch('http://127.0.0.1:7101/');
  const html = await page.text();
  assert(page.ok && html.includes('<title>AgentRelay</title>'), 'Vite should serve the application shell');
  console.log(JSON.stringify({ ok: true, cliPortForwarded: 7101, apiProxy: true, appShell: true }));
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
} finally {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}
