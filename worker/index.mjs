import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { EnvironmentWorker } from '@anthropic-ai/sdk/helpers/beta/environments';

if (process.platform === 'win32') {
  console.error('Memory-enabled workers require Linux or macOS. Run this worker inside WSL.');
  process.exit(1);
}
const environmentId = process.env.ANTHROPIC_ENVIRONMENT_ID;
const environmentKey = process.env.ANTHROPIC_ENVIRONMENT_KEY;
if (!environmentId || !environmentKey) {
  console.error('Set ANTHROPIC_ENVIRONMENT_ID and ANTHROPIC_ENVIRONMENT_KEY before starting the worker.');
  process.exit(1);
}
const workdir = process.env.AGENT_WORKDIR || '/workspace';
fs.mkdirSync(workdir, { recursive: true });
const client = new Anthropic({ authToken: environmentKey, maxRetries: 2 });
const controller = new AbortController();
const worker = new EnvironmentWorker({
  client,
  environmentId,
  environmentKey,
  workdir,
  maxIdleMs: 0,
  memorySyncIntervalMs: 15000,
  memorySyncDeletions: 'enabled',
  signal: controller.signal,
});
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());
console.log(`[worker] Polling ${environmentId}; workdir ${workdir}`);
try {
  await worker.run();
} catch (error) {
  if (!controller.signal.aborted) {
    console.error(`[worker] ${error.message || error}`);
    process.exitCode = 1;
  }
}
