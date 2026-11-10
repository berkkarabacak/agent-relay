import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let muted = false;
const output = new Writable({
  write(chunk, encoding, callback) {
    if (!muted) process.stdout.write(chunk, encoding);
    callback();
  },
});
const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
console.log('AgentRelay local setup');
console.log('The key is written to .env, which is excluded from source control.');
muted = true;
const key = await rl.question('Claude API key: ');
muted = false;
rl.close();
process.stdout.write('\n');
if (!key.trim().startsWith('sk-ant-')) {
  console.error('A valid Claude API key is required. No file was changed.');
  process.exit(1);
}
const content = `ANTHROPIC_API_KEY=${key.trim()}\nANTHROPIC_MODEL=claude-opus-5-5\nSESSION_BUDGET_CENTS=1000\nPORT=7100\nAPI_PORT=8787\nHOST=127.0.0.1\n`;
fs.writeFileSync(path.join(root, '.env'), content, { mode: 0o600 });
console.log('Setup complete. Run npm start or npm run dev.');
