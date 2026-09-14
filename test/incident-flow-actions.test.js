import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { renderActionCard, createSimpleResultCard } from '../src/lib/card.js';
import { enqueueContinuation } from '../src/lib/continuation.js';
import {
  ACTIONS,
  encodePayload,
  signAction,
  verifyActionSignature,
} from '../src/lib/protocol.js';
import { writeCardBinding } from '../src/lib/storage.js';
import { createIncidentActionHandler, isMainModule } from '../src/service/server.js';
import { buildSendMentionArgs } from '../src/cli/index.js';

const SECRET = 'test-signing-secret-that-is-long-enough';
const TOKEN = 'private-gateway-token';

function fixturePayload(overrides = {}) {
  const now = Date.now();
  return {
    schemaVersion: 1,
    cardId: 'card-123',
    incidentId: 'INC-42',
    sessionId: 'session-123',
    chatId: 'oc_chat123',
    larkAppId: 'cli_app123',
    sessionScope: 'thread',
    rootMessageId: 'om_root123',
    workingDir: '/tmp/workspace',
    dataDir: '/tmp/botmux-data',
    allowedOperatorIds: ['ou_allowed123'],
    issuedAt: now,
    expiresAt: now + 60_000,
    ...overrides,
  };
}

function callbackBody(actionName, payload, overrides = {}) {
  const encodedPayload = encodePayload(payload);
  return {
    schemaVersion: 1,
    eventId: 'evt-1',
    larkAppId: payload.larkAppId,
    operator: { open_id: 'ou_allowed123' },
    context: { open_message_id: 'om_card123' },
    actionName,
    action: {
      value: {
        action: actionName,
        payload: encodedPayload,
        signature: signAction(actionName, encodedPayload, SECRET),
      },
    },
    ...overrides,
  };
}

async function withHandler(t, setup = {}) {
  const home = mkdtempSync(join(tmpdir(), 'incident-actions-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const payload = fixturePayload();
  const encodedPayload = encodePayload(payload);
  const baseCard = createSimpleResultCard({ title: '结论', summary: '根因已经定位。' });
  writeCardBinding(home, {
    schemaVersion: 1,
    cardId: payload.cardId,
    messageId: 'om_card123',
    encodedPayload,
    baseCard,
  });
  const handler = createIncidentActionHandler({
    pluginHome: home,
    token: TOKEN,
    signingSecret: SECRET,
    enqueue: setup.enqueue ?? (async () => ({ taskId: 'task-1' })),
  });
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/botmux/card-actions/v1`;
  return { payload, url };
}

async function post(url, body, token = TOKEN) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('HMAC rejects a tampered action or payload', () => {
  const encoded = encodePayload(fixturePayload());
  const signature = signAction(ACTIONS.repair, encoded, SECRET);
  assert.equal(verifyActionSignature(ACTIONS.repair, encoded, signature, SECRET), true);
  assert.equal(verifyActionSignature(ACTIONS.continue, encoded, signature, SECRET), false);
  assert.equal(verifyActionSignature(ACTIONS.repair, `${encoded}x`, signature, SECRET), false);
});

test('incident card forwards explicit recipients and mention-back to botmux send', () => {
  assert.deepEqual(
    buildSendMentionArgs([
      '--mention', 'ou_owner:Owner',
      '--mention', 'ou_repair:Repair Owner',
      '--mention-back',
    ]),
    [
      '--mention', 'ou_owner:Owner',
      '--mention', 'ou_repair:Repair Owner',
      '--mention-back',
    ],
  );
  assert.deepEqual(buildSendMentionArgs([]), ['--no-mention']);
});

test('service entry detection follows installed symlinks', t => {
  const home = mkdtempSync(join(tmpdir(), 'incident-service-entry-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const realEntry = join(home, 'server.js');
  const linkedEntry = join(home, 'installed-server.js');
  writeFileSync(realEntry, '');
  symlinkSync(realEntry, linkedEntry);

  assert.equal(isMainModule(pathToFileURL(realEntry).href, linkedEntry), true);
});

test('repair action has a confirmation dialog and locked cards remove every action', () => {
  const valueFor = action => ({ action });
  const initial = renderActionCard(createSimpleResultCard({ title: '结论', summary: '内容' }), valueFor);
  const buttons = initial.elements.at(-1).actions;
  assert.ok(buttons.find(button => button.value.action === ACTIONS.repair).confirm);
  const locked = renderActionCard(initial, valueFor, ACTIONS.repair);
  assert.equal(locked.elements.some(element => element.element_id === 'incident_flow_actions'), false);
  assert.match(locked.elements.at(-1).content, /授权修复/);
});

test('continuation uses fixed execFile arguments and preserves the original topic', async () => {
  const calls = [];
  const result = await enqueueContinuation({
    actionName: ACTIONS.continue,
    payload: fixturePayload({ incidentId: 'INC-42;touch-pwned' }),
    operatorId: 'ou_allowed123',
    eventId: 'evt-1',
  }, {
    binary: '/usr/local/bin/botmux',
    run: async (binary, args, options) => {
      calls.push({ binary, args, options });
      return { stdout: calls.length === 1 ? '✅ 已创建定时任务 [task-abc] x\n' : 'ok\n', stderr: '' };
    },
  });
  assert.equal(result.taskId, 'task-abc');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].binary, '/usr/local/bin/botmux');
  assert.deepEqual(calls[0].args.slice(0, 3), ['schedule', 'add', '1d']);
  assert.ok(calls[0].args.includes('--topic'));
  assert.ok(calls[0].args.includes('om_root123'));
  assert.equal(calls[0].options.shell, undefined);
  assert.equal(calls[1].args[0], 'schedule');
  assert.equal(calls[1].args[2], 'task-abc');
});

test('callback rejects an invalid bearer token', async t => {
  const { payload, url } = await withHandler(t);
  const result = await post(url, callbackBody(ACTIONS.confirm, payload), 'wrong-token');
  assert.equal(result.status, 401);
  assert.equal(result.body.error, 'unauthorized');
});

test('callback rejects unknown actions and tampered signatures', async t => {
  const { payload, url } = await withHandler(t);
  const unknown = await post(url, callbackBody('incident.flow.unknown', payload));
  assert.match(unknown.body.ack.toast.content, /unknown_action/);
  const tampered = callbackBody(ACTIONS.confirm, payload);
  tampered.action.value.signature = 'invalid';
  const badSignature = await post(url, tampered);
  assert.match(badSignature.body.ack.toast.content, /invalid_signature/);
});

test('callback requires a verified allowed operator', async t => {
  const { payload, url } = await withHandler(t);
  const body = callbackBody(ACTIONS.confirm, payload, { operator: { open_id: 'ou_someone_else' } });
  const result = await post(url, body);
  assert.match(result.body.ack.toast.content, /仅本次请求人/);
});

test('card selection is idempotent and only starts one continuation', async t => {
  let calls = 0;
  const { payload, url } = await withHandler(t, {
    enqueue: async () => { calls++; return { taskId: 'task-1' }; },
  });
  const first = await post(url, callbackBody(ACTIONS.repair, payload));
  const second = await post(url, callbackBody(ACTIONS.continue, payload, { eventId: 'evt-2' }));
  assert.equal(calls, 1);
  assert.equal(first.body.ack.toast.type, 'success');
  assert.match(second.body.ack.toast.content, /无需重复操作/);
  assert.equal(second.body.ack.card.elements.some(element => element.element_id === 'incident_flow_actions'), false);
  assert.match(second.body.ack.card.elements.at(-1).content, /授权修复/);
});
