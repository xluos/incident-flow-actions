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
import {
  applyOwnerIdentity,
  buildOwnerMentionArgs,
  buildSendMentionArgs,
} from '../src/cli/index.js';

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
    enqueue: setup.enqueue ?? (async () => ({ triggerId: 'trigger-1', sessionId: payload.sessionId })),
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

test('incident card derives owner rendering and mention from one identity artifact', () => {
  const owner = {
    name: '汪睿麟',
    query: 'wangruilin.bruce@bytedance.com',
    mention_display_name: '汪睿麟',
    mention_status: 'resolved',
    mention_arg: 'wangruilin.bruce@bytedance.com:汪睿麟',
  };
  const card = createSimpleResultCard({ title: '结论', summary: '**修复负责人：** {{repair_owner}}' });

  assert.match(applyOwnerIdentity(card, owner).body.elements[0].content, /@汪睿麟/);
  assert.deepEqual(buildOwnerMentionArgs(owner), [
    '--mention', 'wangruilin.bruce@bytedance.com:汪睿麟',
  ]);
  assert.deepEqual(buildSendMentionArgs([], buildOwnerMentionArgs(owner)), [
    '--mention', 'wangruilin.bruce@bytedance.com:汪睿麟',
  ]);
});

test('incident card renders unresolved owner without inventing a mention', () => {
  const owner = {
    name: '张三',
    query: '张三',
    mention_display_name: 'unknown',
    mention_status: 'ambiguous',
  };
  const card = createSimpleResultCard({ title: '结论', summary: '**修复负责人：** {{repair_owner}}' });

  assert.match(applyOwnerIdentity(card, owner).body.elements[0].content, /未通知：ambiguous/);
  assert.deepEqual(buildOwnerMentionArgs(owner), []);
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
  const buttons = initial.body.elements.at(-1).columns.map(column => column.elements[0]);
  assert.ok(buttons.find(button => button.behaviors[0].value.action === ACTIONS.repair).confirm);
  const locked = renderActionCard(initial, valueFor, ACTIONS.repair);
  assert.equal(locked.body.elements.some(element => element.element_id === 'incident_flow_actions'), false);
  assert.match(locked.body.elements.at(-1).content, /授权修复/);
});

test('continuation triggers the original session directly without creating a schedule', async () => {
  const calls = [];
  const result = await enqueueContinuation({
    actionName: ACTIONS.continue,
    payload: fixturePayload({ incidentId: 'INC-42;touch-pwned' }),
    operatorId: 'ou_allowed123',
    eventId: 'evt-1',
  }, {
    dashboardBase: 'http://127.0.0.1:7891',
    dashboardToken: 'dashboard-token',
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        ok: true,
        triggerId: 'trigger-abc',
        target: { kind: 'turn', sessionId: 'session-123' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.deepEqual(result, { triggerId: 'trigger-abc', sessionId: 'session-123' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:7891/api/trigger');
  assert.equal(calls[0].init.headers.cookie, 'botmux_dashboard_token=dashboard-token');
  const request = JSON.parse(calls[0].init.body);
  assert.deepEqual(request.target, {
    kind: 'turn',
    botId: 'cli_app123',
    sessionId: 'session-123',
  });
  assert.equal(request.presentation.topicMessage, null);
  assert.equal(request.options.asyncReturnSessionId, true);
  assert.equal(request.options.turnIdempotencyKey, 'incident-action:card-123:continue');
  assert.equal(request.envelope.payload.incident_id, 'INC-42;touch-pwned');
  assert.equal(request.instruction.includes('INC-42;touch-pwned'), false);
});

test('continuation surfaces dashboard trigger failures', async () => {
  await assert.rejects(() => enqueueContinuation({
    actionName: ACTIONS.repair,
    payload: fixturePayload(),
    operatorId: 'ou_allowed123',
    eventId: 'evt-1',
  }, {
    dashboardBase: 'http://127.0.0.1:7891',
    dashboardToken: 'dashboard-token',
    fetch: async () => new Response(JSON.stringify({ ok: false, error: 'session not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    }),
  }), /trigger_failed:http_404:session not found/);
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
    enqueue: async () => { calls++; return { triggerId: 'trigger-1', sessionId: payload.sessionId }; },
  });
  const first = await post(url, callbackBody(ACTIONS.repair, payload));
  const second = await post(url, callbackBody(ACTIONS.continue, payload, { eventId: 'evt-2' }));
  assert.equal(calls, 1);
  assert.equal(first.body.ack.toast.type, 'success');
  assert.match(second.body.ack.toast.content, /无需重复操作/);
  assert.equal(second.body.ack.card.body.elements.some(element => element.element_id === 'incident_flow_actions'), false);
  assert.match(second.body.ack.card.body.elements.at(-1).content, /授权修复/);
});


test('simple card supports the Botmux mention footer without splitting delivery', () => {
  const card = renderActionCard(createSimpleResultCard({ title: '结果', summary: '原因和排查记录' }), action => ({ action }));
  assert.equal(card.schema, '2.0');
  assert.equal(card.elements, undefined);
  assert.equal(card.body.elements[0].content, '原因和排查记录');
  assert.equal(card.body.elements.some(e => e.element_id === 'botmux_reply_footer'), false);
});

test('explicit no-mention suppresses owner notifications and rejects conflicts', () => {
  assert.deepEqual(buildSendMentionArgs(['--no-mention'], ['--mention', 'owner@example.com']), ['--no-mention']);
  assert.throws(() => buildSendMentionArgs(['--no-mention', '--mention-back']), /cannot be combined/);
});
