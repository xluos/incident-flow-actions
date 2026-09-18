import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ACTION_PREFIX } from './protocol.js';
import { DEFAULT_ACTIONS, normalizeActions } from './config.js';

function selectedAction(actionName, configured) {
  const action = configured ?? DEFAULT_ACTIONS.find(item => ACTION_PREFIX + item.id === actionName);
  if (!action || ACTION_PREFIX + action.id !== actionName) throw new Error('unknown_action');
  return normalizeActions([action])[0];
}

export function continuationInstruction(actionName, action) {
  return selectedAction(actionName, action).instruction;
}

async function resolveTarget(action, payload, dashboard, fetchImpl) {
  if (!action.target) return { kind: 'turn', botId: payload.larkAppId, sessionId: payload.sessionId };
  const response = await fetchImpl(`${dashboard.base}/api/sessions`, {
    headers: { cookie: `botmux_dashboard_token=${dashboard.token}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('target_sessions_unavailable');
  const body = await response.json();
  const sessions = Array.isArray(body) ? body : body.sessions;
  if (!Array.isArray(sessions)) throw new Error('target_sessions_invalid');
  const candidates = sessions.filter(session => session.larkAppId === action.target.botId
    && session.chatId === payload.chatId
    && session.scope === payload.sessionScope
    && (payload.sessionScope !== 'thread' || session.rootMessageId === payload.rootMessageId)
    && (!action.target.sessionId || session.sessionId === action.target.sessionId));
  if (candidates.length !== 1) throw new Error('target_session_missing_or_ambiguous');
  return { kind: 'turn', botId: action.target.botId, sessionId: candidates[0].sessionId };
}

function readTrimmed(path) {
  return readFileSync(path, 'utf8').trim();
}

function dashboardAccess(deps) {
  if (deps.dashboardBase && deps.dashboardToken) {
    return { base: deps.dashboardBase, token: deps.dashboardToken };
  }
  const configDir = deps.configDir ?? join(homedir(), '.botmux');
  const port = readTrimmed(join(configDir, '.dashboard-port'));
  const token = readTrimmed(join(configDir, '.dashboard-token'));
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('dashboard_port_invalid');
  }
  if (!token) throw new Error('dashboard_token_missing');
  return { base: `http://127.0.0.1:${port}`, token };
}

export async function enqueueContinuation(input, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const { payload } = input;
  const definition = selectedAction(input.actionName, input.action);
  const action = definition.id;
  const dashboard = dashboardAccess(deps);
  const target = await resolveTarget(definition, payload, dashboard, fetchImpl);
  const request = {
    source: {
      type: 'ui',
      connectorId: 'incident-flow-actions',
      requestId: `incident-action:${input.eventId}`,
      receivedAt: new Date().toISOString(),
    },
    target,
    envelope: {
      format: 'incident_flow_action.v1',
      sourceName: 'Incident Flow Actions',
      trusted: false,
      payload: {
        incident_id: payload.incidentId,
        source_bot_id: payload.larkAppId,
        source_session_id: payload.sessionId,
        source_chat_id: payload.chatId,
        action_label: definition.label,
        action,
        verified_operator_open_id: input.operatorId,
        event_id: input.eventId,
      },
    },
    instruction: continuationInstruction(input.actionName, definition),
    presentation: { topicMessage: null },
    options: {
      asyncReturnSessionId: true,
      turnIdempotencyKey: `incident-action:${payload.cardId}:${action}`,
    },
  };
  const response = await fetchImpl(`${dashboard.base}/api/trigger`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `botmux_dashboard_token=${dashboard.token}`,
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok !== true) {
    throw new Error(`trigger_failed:http_${response.status}:${body?.error ?? body?.errorCode ?? 'unknown'}`);
  }
  return {
    triggerId: body.triggerId ?? null,
    sessionId: body.target?.sessionId ?? body.async?.sessionId ?? target.sessionId,
  };
}
