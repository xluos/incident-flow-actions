import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ACTION_META } from './protocol.js';

export function continuationInstruction(actionName) {
  const action = ACTION_META[actionName]?.key;
  if (!action) throw new Error('unknown_action');
  return action === 'confirm'
    ? '用户已确认故障结论。记录确认，完成必要收尾，并结束本次故障处理。'
    : action === 'repair'
      ? '用户已明确授权修复。记录授权，按故障修复流程继续；仍需遵守现有发布、Review 和验证门禁。'
      : '用户要求继续排查。保持故障未关闭，基于现有证据继续诊断并汇报新的结论。';
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
  const action = ACTION_META[input.actionName]?.key;
  if (!action) throw new Error('unknown_action');
  const dashboard = dashboardAccess(deps);
  const request = {
    source: {
      type: 'ui',
      connectorId: 'incident-flow-actions',
      requestId: `incident-action:${input.eventId}`,
      receivedAt: new Date().toISOString(),
    },
    target: {
      kind: 'turn',
      botId: payload.larkAppId,
      sessionId: payload.sessionId,
    },
    envelope: {
      format: 'incident_flow_action.v1',
      sourceName: 'Incident Flow Actions',
      trusted: false,
      payload: {
        incident_id: payload.incidentId,
        action,
        verified_operator_open_id: input.operatorId,
        event_id: input.eventId,
      },
    },
    instruction: continuationInstruction(input.actionName),
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
    sessionId: body.target?.sessionId ?? body.async?.sessionId ?? payload.sessionId,
  };
}
