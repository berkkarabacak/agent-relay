import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const appRoot = path.resolve(here, '..');
dotenv.config({ path: path.join(appRoot, '.env'), quiet: true });

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 7100),
  apiPort: Number(process.env.API_PORT || 8787),
  apiOnly: process.env.API_ONLY === '1',
  model: process.env.ANTHROPIC_MODEL || 'claude-opus-5-5',
  budgetCents: Number(process.env.SESSION_BUDGET_CENTS || 1000),
  environmentId: process.env.ANTHROPIC_ENVIRONMENT_ID || '',
  accessToken: process.env.AGENT_RELAY_ACCESS_TOKEN || '',
};

export const MANAGED_AGENTS_BETA = 'managed-agents-2026-04-01';
