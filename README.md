# AgentRelay

Public preview: https://berkkarabacak.github.io/agent-relay/
Source repository: https://github.com/berkkarabacak/agent-relay

A local control plane for long-running Claude Managed Agents. Each sticky agent gets:

- a stable local API key such as `game-director`;
- a persistent managed session and conversation history;
- a dedicated remote memory store with versioned Markdown documents;
- live tool events, approval controls, interrupts, and session spend caps;
- a fresh-session option that retains project memory.

The browser UI never receives the Claude API key. Local mappings live in `data/agent-relay.db`; the key lives only in `.env` or the server process environment. Both paths are excluded from source control.

## Run on Windows

Requires Node.js 24 (the server uses `node:sqlite`).

### One-command start

Double-click `start-relay.cmd`, or run:

```bat
start-relay.cmd
```

The script installs dependencies when needed, runs credential setup on first launch, builds the UI, and opens `http://127.0.0.1:7100/`.

### Manual start

```bash
npm install
npm run setup
npm run build
npm start
```

`npm run setup` hides the key while typing and writes it to `.env`. You can instead provide `ANTHROPIC_API_KEY` directly in the process environment.

For hot-reload development:

```bash
npm run dev -- --host 127.0.0.1 --port 7100
```

The development command starts both the API and Vite and forwards host/port arguments to Vite.

## Family or shared-network deployment

GitHub Pages can host documentation and screenshots only; it cannot run this Express server, SQLite database, managed-agent worker, or Claude API credentials. Deploy `npm start` on a private Node.js host with HTTPS and set `AGENT_RELAY_ACCESS_TOKEN` to a long random value before sharing the URL.

When configured, the browser asks for Basic credentials (any username and the token as password), and API clients send `Authorization: Bearer <token>`. `/api/health` remains public for uptime checks; the UI, status, agents, messages, memories, streams, and approvals all require authentication. Never put the Claude API key or this access token in the repository, Pages files, or client-side JavaScript.

For the Python client, set `AGENT_RELAY_ACCESS_TOKEN` or pass `--access-token`. The Claude API key remains server-side in `.env` or the process environment.

## Use from another agent

A dependency-free Python client and CLI are included at `clients/agent_relay.py`:

```bash
python clients/agent_relay.py status
python clients/agent_relay.py recover
python clients/agent_relay.py run --message "Read project memory and continue the next milestone."
python clients/agent_relay.py stream --message "Report current project status."
```

It defaults to `http://127.0.0.1:7100` and `game-director`; override with `--base-url` and `--key` or `AGENT_RELAY_URL` and `AGENT_RELAY_KEY`. No Claude credential is needed by the client. Run its offline tests with `python -m unittest discover -s clients -p "test_*.py" -v`.

Send work to the existing sticky identity directly:

```bash
curl http://127.0.0.1:7100/v1/agents/game-director/messages \
  -H "content-type: application/json" \
  -d '{"message":"Read the project memory and continue the next game-development milestone."}'
```

The response is `202 Accepted` with the managed `sessionId`. Read persisted history at:

```bash
curl http://127.0.0.1:7100/v1/agents/game-director/events
```

For server-sent events instead, POST the same message body to `/v1/agents/game-director/stream`. Open the stream before or while sending; each SSE `data` payload is a managed session event.

### Main routes

| Route | Purpose |
| --- | --- |
| `GET /api/status` | Local configuration status; never returns the API key |
| `GET /v1/agents` | List sticky identities |
| `POST /v1/agents` | Provision an agent, memory store, and session |
| `GET /v1/agents/:key/session` | Retrieve status, usage, and spend |
| `POST /v1/agents/:key/messages` | Queue a user message |
| `POST /v1/agents/:key/stream` | Send a message and stream the turn |
| `GET /v1/agents/:key/events` | Recover full persisted event history |
| `POST /v1/agents/:key/interrupt` | Interrupt current work |
| `POST /v1/agents/:key/confirmations` | Allow or deny a tool call |
| `POST /v1/agents/:key/reset` | Archive the conversation, retain memory |
| `GET/POST /v1/agents/:key/memories` | List or create memories |
| `PUT/DELETE /v1/agents/:key/memories/:id` | Edit or delete a memory |

Example agent creation body:

```json
{
  "key": "world-builder",
  "name": "World Builder",
  "model": "claude-opus-5-5",
  "toolPolicy": "auto",
  "budgetCents": 1000,
  "project": "Own the open-world map, streaming regions, and environmental systems."
}
```

`toolPolicy` accepts `auto`, `always_ask`, or `always_allow`. The spend cap is in US cents; `1000` means $10.00.

## Let agents edit this PC’s game files

The default environment is an Anthropic-managed cloud sandbox. It cannot directly edit files on this PC. For local game development, use a self-hosted environment and run the included worker inside Linux or WSL. Native Windows memory-enabled workers are unsupported by the Managed Agents worker requirements.

1. Create a **self-hosted** environment in the Claude Console.
2. Generate its restricted **environment key** in the Console.
3. Set `ANTHROPIC_ENVIRONMENT_ID=env_...` in `.env` **before creating new sticky agents**. Existing agents retain the environment with which they were created.
4. In WSL, prepare the memory mount and working directory:

```bash
sudo mkdir -p /mnt/memory /workspace
sudo chown "$USER" /mnt/memory /workspace
```

5. From this project directory inside WSL, start the worker with only the restricted environment credential:

```bash
export ANTHROPIC_ENVIRONMENT_ID=env_...
export ANTHROPIC_ENVIRONMENT_KEY=sk-ant-oat01-...
export AGENT_WORKDIR=/mnt/c/path/to/game-project
npm run worker
```

The worker needs Node.js 22+, `/bin/bash`, `tar`, `unzip`, and outbound HTTPS. Keep the main Claude API key out of the worker environment and game workspace. The worker syncs attached memory stores every 15 seconds and performs a final sync on shutdown.

## Verification

With the API credential configured:

```bash
npm run test:live
npm run build
npm run test:ui
```

- `test:live` uses `game-director`, writes a verification codename to memory, resets the session, and verifies that the fresh session recovers it. It makes billable API calls and resets that agent’s current conversation.
- `test:ui` starts a temporary production server on port 7100, sends a short `UI_OK` message, creates and deletes a temporary memory, checks dialog/session/API interactions, captures desktop/mobile screenshots, and fails on console errors, failed requests, or mobile overflow. Stop any existing server on port 7100 first.

Production dependencies currently audit with no known vulnerabilities. Development-only lint tooling may report transitive advisories that do not ship in the production server bundle.

## Data behavior

Managed sessions are stateful: transcripts and remote sandbox state persist until deleted. Memory stores are independent resources and survive session archive/delete operations. Managed Agents is not eligible for Zero Data Retention or HIPAA BAA coverage. Do not put credentials or sensitive personal data in agent memory.
