import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const children = [
  spawn(node, ['server/index.mjs'], { cwd: root, stdio: 'inherit', env: { ...process.env, API_ONLY: '1' } }),
  spawn(node, [vite, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', env: process.env }),
];
let closing = false;
function close(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) if (!child.killed) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 150).unref();
}
for (const child of children) child.on('exit', (code) => close(code || 0));
process.on('SIGINT', () => close(0));
process.on('SIGTERM', () => close(0));
