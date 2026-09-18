import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderActionCard } from '../lib/card.js';
import {
  ACTION_PREFIX,
  decodePayload,
  operatorIsAllowed,
  validatePayload,
  verifyActionSignature,
} from '../lib/protocol.js';
import { bindingActions } from '../lib/config.js';
import { enqueueContinuation } from '../lib/continuation.js';
import { ActionStore, readCardBinding } from '../lib/storage.js';

const MAX_BODY_BYTES = 256 * 1024;

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function ack({ toastType, toast, card }) {
  return {
    schemaVersion: 1,
    ack: {
      ...(toast ? { toast: { type: toastType ?? 'info', content: toast } } : {}),
      ...(card ? { card } : {}),
    },
  };
}

function loadSigningSecret(pluginHome) {
  const config = JSON.parse(readFileSync(join(pluginHome, 'config.json'), 'utf8'));
  if (typeof config.signingSecret !== 'string' || config.signingSecret.length < 32) {
    throw new Error('signing_secret_unavailable');
  }
  return config.signingSecret;
}

export function createIncidentActionHandler(options = {}) {
  const pluginHome = options.pluginHome ?? process.env.BOTMUX_PLUGIN_HOME;
  const token = options.token ?? process.env.BOTMUX_PLUGIN_CARD_ACTION_TOKEN;
  if (!pluginHome || !token) throw new Error('plugin_service_environment_missing');
  const store = options.store ?? new ActionStore(pluginHome);
  const enqueue = options.enqueue ?? enqueueContinuation;

  return async function handler(req, res) {
    if (req.method !== 'POST' || req.url !== '/botmux/card-actions/v1') {
      return json(res, 404, { error: 'not_found' });
    }
    const bearer = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : '';
    if (!safeEqual(bearer, token)) return json(res, 401, { error: 'unauthorized' });

    let body;
    try { body = await readBody(req); }
    catch (error) { return json(res, 400, { error: error.message }); }
    try {
      if (body?.schemaVersion !== 1 || typeof body.eventId !== 'string') throw new Error('invalid_request');
      const actionName = body.actionName;
      if (typeof actionName !== 'string' || !/^incident\.flow\.[a-z][a-z0-9_-]{0,47}$/.test(actionName)) throw new Error('unknown_action');
      const encodedPayload = body.action?.value?.payload;
      const signature = body.action?.value?.signature;
      const secret = options.signingSecret ?? loadSigningSecret(pluginHome);
      if (!verifyActionSignature(actionName, encodedPayload, signature, secret)) throw new Error('invalid_signature');
      const payload = validatePayload(decodePayload(encodedPayload));
      if (payload.larkAppId !== body.larkAppId) throw new Error('lark_app_mismatch');
      if (!operatorIsAllowed(payload, body.operator)) {
        return json(res, 200, ack({ toastType: 'error', toast: '仅本次请求人或指定人员可操作' }));
      }
      const binding = readCardBinding(pluginHome, payload.cardId);
      if (!binding || binding.encodedPayload !== encodedPayload) throw new Error('card_binding_missing');
      const actions = bindingActions(binding, payload);
      const action = actions.find(item => ACTION_PREFIX + item.id === actionName);
      if (!action) throw new Error('unknown_action');
      if (binding.messageId !== body.context?.open_message_id) throw new Error('message_binding_mismatch');
      const operatorId = body.operator.open_id ?? body.operator.union_id;
      if (typeof operatorId !== 'string') throw new Error('operator_required');

      const claim = await store.claim({
        cardId: payload.cardId,
        eventId: body.eventId,
        actionName,
        operatorId,
      });
      if (claim.kind !== 'claimed') {
        const selectedAction = claim.record.actionName;
        const card = renderActionCard(binding.baseCard, () => ({}), selectedAction, claim.record.status, actions);
        return json(res, 200, ack({ toast: `已选择“${actions.find(item => ACTION_PREFIX + item.id === selectedAction)?.label ?? selectedAction}”，无需重复操作`, card }));
      }

      let record;
      try {
        const result = await enqueue({ actionName, action, payload, operatorId, eventId: body.eventId });
        record = await store.finish(payload.cardId, {
          status: 'completed',
          triggerId: result.triggerId,
          sessionId: result.sessionId,
        });
      } catch (error) {
        record = await store.finish(payload.cardId, { status: 'failed', errorCode: error.message });
      }
      const card = renderActionCard(binding.baseCard, () => ({}), actionName, record.status, actions);
      return json(res, 200, ack({
        toastType: record.status === 'completed' ? 'success' : 'error',
        toast: record.status === 'completed' ? '选择已接收，后续任务已提交' : '选择已记录，但后续流程启动失败',
        card,
      }));
    } catch (error) {
      return json(res, 200, ack({ toastType: 'error', toast: `操作未执行：${error.message}` }));
    }
  };
}

export function startServer(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? 9360);
  const startedAt = new Date().toISOString();
  const actionHandler = createIncidentActionHandler(options);
  const server = createServer((req, res) => {
    if (req.url === '/health') return json(res, 200, { ok: true, pid: process.pid, startedAt });
    if (req.url === '/') return json(res, 200, { ok: true, plugin: 'incident-flow-actions' });
    actionHandler(req, res).catch(() => json(res, 500, { error: 'internal_error' }));
  });
  server.listen(port, '127.0.0.1');
  return server;
}

export function isMainModule(metaUrl, entryPath) {
  if (!entryPath) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(entryPath);
  } catch {
    return false;
  }
}

const isMain = isMainModule(import.meta.url, process.argv[1]);
if (isMain) {
  const server = startServer();
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
