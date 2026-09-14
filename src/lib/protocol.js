import { createHmac, timingSafeEqual } from 'node:crypto';

export const ACTION_PREFIX = 'incident.flow.';
export const ACTIONS = Object.freeze({
  confirm: `${ACTION_PREFIX}confirm`,
  repair: `${ACTION_PREFIX}repair`,
  continue: `${ACTION_PREFIX}continue`,
});

export const ACTION_META = Object.freeze({
  [ACTIONS.confirm]: { key: 'confirm', label: '确认结论', style: 'default' },
  [ACTIONS.repair]: { key: 'repair', label: '授权修复', style: 'primary' },
  [ACTIONS.continue]: { key: 'continue', label: '继续排查', style: 'default' },
});

const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const OPEN_ID = /^(ou_|on_)[A-Za-z0-9_-]{4,128}$/;

export function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodePayload(encoded) {
  if (typeof encoded !== 'string' || encoded.length < 8 || encoded.length > 16_384) {
    throw new Error('invalid_payload_encoding');
  }
  const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid_payload');
  }
  return parsed;
}

export function signAction(actionName, encodedPayload, secret) {
  return createHmac('sha256', secret).update(`${actionName}.${encodedPayload}`).digest('base64url');
}

export function verifyActionSignature(actionName, encodedPayload, signature, secret) {
  if (typeof signature !== 'string') return false;
  const expected = Buffer.from(signAction(actionName, encodedPayload, secret));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function validatePayload(payload, now = Date.now()) {
  if (payload.schemaVersion !== 1) throw new Error('unsupported_payload_schema');
  for (const key of ['cardId', 'incidentId', 'sessionId', 'chatId', 'larkAppId']) {
    if (typeof payload[key] !== 'string' || !SAFE_ID.test(payload[key])) throw new Error(`invalid_${key}`);
  }
  if (!payload.larkAppId.startsWith('cli_')) throw new Error('invalid_larkAppId');
  if (payload.sessionScope !== 'thread' && payload.sessionScope !== 'chat') throw new Error('invalid_sessionScope');
  if (payload.sessionScope === 'thread') {
    if (typeof payload.rootMessageId !== 'string' || !payload.rootMessageId.startsWith('om_')) {
      throw new Error('invalid_rootMessageId');
    }
  }
  if (!Array.isArray(payload.allowedOperatorIds) || payload.allowedOperatorIds.length === 0
    || payload.allowedOperatorIds.length > 20
    || payload.allowedOperatorIds.some(id => typeof id !== 'string' || !OPEN_ID.test(id))) {
    throw new Error('invalid_allowedOperatorIds');
  }
  if (!Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt)
    || payload.expiresAt <= payload.issuedAt || payload.expiresAt < now) {
    throw new Error('expired_payload');
  }
  if (payload.expiresAt - payload.issuedAt > 31 * 24 * 60 * 60 * 1000) throw new Error('invalid_expiry');
  if (typeof payload.workingDir !== 'string' || !payload.workingDir.startsWith('/') || payload.workingDir.length > 4096) {
    throw new Error('invalid_workingDir');
  }
  if (payload.dataDir !== undefined
    && (typeof payload.dataDir !== 'string' || !payload.dataDir.startsWith('/') || payload.dataDir.length > 4096)) {
    throw new Error('invalid_dataDir');
  }
  return payload;
}

export function operatorIsAllowed(payload, operator) {
  const allowed = new Set(payload.allowedOperatorIds);
  return [operator?.open_id, operator?.union_id].some(id => typeof id === 'string' && allowed.has(id));
}
