import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { appRoot, config } from './config.mjs';

function credentialMatches(actual, expected) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
import {
  confirmTool, createMemory, createStickyAgent, deleteMemory, getRemoteSession,
  getStickyAgent, interruptSession, listMemories, listSessionEvents, listStickyAgents,
  relayStatus, resetStickySession, sendMessage, streamMessage, updateMemory,
} from './relay.mjs';

export function createServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => {
    if (!config.accessToken || req.path === '/api/health') return next();
    const authorization = req.get('authorization') || '';
    let presented = '';
    if (authorization.startsWith('Bearer ')) {
      presented = authorization.slice(7);
    } else if (authorization.startsWith('Basic ')) {
      const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      presented = separator === -1 ? decoded : decoded.slice(separator + 1);
    }
    if (presented && credentialMatches(presented, config.accessToken)) return next();
    res.set('WWW-Authenticate', 'Basic realm="AgentRelay", charset="UTF-8"');
    return res.status(401).json({ error: { message: 'AgentRelay access token required', status: 401 } });
  });

  app.get('/api/status', (req, res) => res.json(relayStatus()));
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  const router = express.Router();
  router.get('/agents', (req, res) => res.json({ agents: listStickyAgents() }));
  router.post('/agents', async (req, res, next) => {
    try { res.status(201).json({ agent: await createStickyAgent(req.body || {}) }); } catch (error) { next(error); }
  });
  router.get('/agents/:key', async (req, res, next) => {
    try { res.json({ agent: await getStickyAgent(req.params.key, req.query.refresh === 'true') }); } catch (error) { next(error); }
  });
  router.get('/agents/:key/session', async (req, res, next) => {
    try { res.json({ session: await getRemoteSession(req.params.key) }); } catch (error) { next(error); }
  });
  router.get('/agents/:key/events', async (req, res, next) => {
    try { res.json(await listSessionEvents(req.params.key)); } catch (error) { next(error); }
  });
  router.post('/agents/:key/messages', async (req, res, next) => {
    try { res.status(202).json(await sendMessage(req.params.key, req.body?.message)); } catch (error) { next(error); }
  });
  router.post('/agents/:key/stream', async (req, res, next) => {
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    req.on('close', abort);
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': keepalive\n\n'); }, 15000);
    try {
      await streamMessage(req.params.key, req.body?.message, async (event) => {
        if (!res.headersSent) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
        }
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
      }, controller.signal);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'relay.done' })}\n\n`);
        res.end();
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (res.headersSent && !res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'relay.error', message: error.message || 'Stream failed' })}\n\n`);
        res.end();
      } else if (!res.headersSent) next(error);
    } finally {
      clearInterval(heartbeat);
      req.off('close', abort);
    }
  });
  router.post('/agents/:key/interrupt', async (req, res, next) => {
    try { res.json(await interruptSession(req.params.key)); } catch (error) { next(error); }
  });
  router.post('/agents/:key/confirmations', async (req, res, next) => {
    try { res.json(await confirmTool(req.params.key, req.body || {})); } catch (error) { next(error); }
  });
  router.post('/agents/:key/reset', async (req, res, next) => {
    try { res.json(await resetStickySession(req.params.key)); } catch (error) { next(error); }
  });
  router.get('/agents/:key/memories', async (req, res, next) => {
    try { res.json(await listMemories(req.params.key)); } catch (error) { next(error); }
  });
  router.post('/agents/:key/memories', async (req, res, next) => {
    try { res.status(201).json({ memory: await createMemory(req.params.key, req.body || {}) }); } catch (error) { next(error); }
  });
  router.put('/agents/:key/memories/:memoryId', async (req, res, next) => {
    try { res.json({ memory: await updateMemory(req.params.key, req.params.memoryId, req.body || {}) }); } catch (error) { next(error); }
  });
  router.delete('/agents/:key/memories/:memoryId', async (req, res, next) => {
    try { res.json(await deleteMemory(req.params.key, req.params.memoryId)); } catch (error) { next(error); }
  });
  app.use('/v1', router);

  if (!config.apiOnly) {
    const dist = path.join(appRoot, 'dist');
    app.use(express.static(dist));
    app.use((req, res, next) => {
      if (req.method === 'GET' && req.accepts('html')) return res.sendFile(path.join(dist, 'index.html'));
      next();
    });
  }
  app.use((req, res) => res.status(404).json({ error: { message: 'Route not found' } }));
  app.use((error, req, res, next) => {
    console.error(`[relay] ${error.message || error}`);
    const status = Number(error.status || error.statusCode || 500);
    res.status(status).json({ error: { message: error.message || 'Unexpected relay error', status } });
  });
  return app;
}

export function startServer() {
  const port = config.apiOnly ? config.apiPort : config.port;
  const app = createServer();
  const server = app.listen(port, config.host, () => {
    console.log(`[relay] ${config.apiOnly ? 'API' : 'AgentRelay'} listening on http://${config.host}:${port}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(appRoot, 'server', 'index.mjs')) startServer();
