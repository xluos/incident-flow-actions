import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { normalizeConfig, resolveActions, actionsHash, bindingActions, DEFAULT_ACTIONS } from '../src/lib/config.js';
import { renderActionCard } from '../src/lib/card.js';
import { enqueueContinuation } from '../src/lib/continuation.js';
import { encodePayload, signAction } from '../src/lib/protocol.js';
import { createIncidentActionHandler } from '../src/service/server.js';
import { writeCardBinding } from '../src/lib/storage.js';
import handlers, { configureActions } from '../src/cli/index.js';

const actions = [
  { id: 'inspect', label: '补查证据', style: 'primary', instruction: '只读核对证据，不修改代码。' },
  { id: 'review', label: '请质量机器人检查', style: 'default', instruction: '检查本群当前变更，报告风险。', confirmation: { title: '交给质量机器人', text: '将把本群任务交给质量机器人检查。' }, target: { botId: 'cli_quality', sessionId: 'review-session' } },
];
const config = { schemaVersion: 1, defaultProfile: null, profiles: { custom: { actions } }, bots: { cli_source: { enabled: true, profile: 'custom' }, cli_other: { enabled: false } } };
const payload = () => ({ schemaVersion: 1, cardId: 'card-custom', incidentId: 'issue-42', sessionId: 'source-session', chatId: 'oc_source', larkAppId: 'cli_source', sessionScope: 'chat', workingDir: '/tmp', allowedOperatorIds: ['ou_person123'], issuedAt: Date.now(), expiresAt: Date.now() + 60000, actionsHash: actionsHash(actions) });

test('per-bot profiles are opt-in and validate before configuration writes', async () => {
  assert.equal(resolveActions(config, 'cli_source').profileId, 'custom');
  assert.throws(() => resolveActions(config, 'cli_other'), /bot_not_enabled/);
  assert.throws(() => resolveActions(config, 'cli_unknown'), /bot_not_enabled/);
  assert.equal(resolveActions(undefined, 'cli_legacy').actions.length, 3);
  assert.throws(() => normalizeConfig({ ...config, defaultProfile: 'missing' }), /unknown_default/);
  assert.throws(() => normalizeConfig({ ...config, profiles: { custom: { actions: [actions[0], actions[0]] } } }), /duplicate/);
  assert.throws(() => normalizeConfig({ ...config, profiles: { custom: { actions: [{ ...actions[0], style: 'oops' }] } } }), /style/);
  assert.throws(() => normalizeConfig({ ...config, profiles: { custom: { actions: [{ ...actions[0], command: 'shell' }] } } }), /unknown_action/);
  let writes = 0;
  const ctx = { args: [], api: { config: { get: () => config, set: () => writes++ } } };
  assert.equal(JSON.parse(await configureActions(ctx)).config.defaultProfile, null);
  assert.equal(writes, 0);
});

test('custom button order, labels, styles and confirmations work for legacy and Card 2.0', () => {
  for (const base of [{ elements: [] }, { schema: '2.0', body: { elements: [] } }]) {
    const rendered = renderActionCard(base, action => ({ action }), undefined, undefined, actions);
    const row = (rendered.body?.elements ?? rendered.elements)[0];
    const buttons = row.actions ?? row.columns.map(column => column.elements[0]);
    assert.deepEqual(buttons.map(button => button.text.content), actions.map(action => action.label));
    assert.equal(buttons[0].type, 'primary');
    assert.equal(buttons[1].confirm.text.content, actions[1].confirmation.text);
    const completed = renderActionCard(rendered, () => ({}), 'incident.flow.review', 'completed', actions);
    const elements = completed.body?.elements ?? completed.elements;
    assert.equal(elements.length, 1);
    assert.match(elements[0].content, /请质量机器人检查/);
  }
});

test('action snapshot cannot drift with later configuration edits and legacy cards still resolve', () => {
  const original = structuredClone(actions);
  const p = payload();
  const binding = { actions: original };
  const changed = structuredClone(config);
  changed.profiles.custom.actions[0].instruction = 'changed';
  assert.equal(bindingActions(binding, p)[0].instruction, actions[0].instruction);
  assert.throws(() => bindingActions({ actions: changed.profiles.custom.actions }, p), /snapshot_mismatch/);
  assert.deepEqual(bindingActions({}, {}), DEFAULT_ACTIONS);
});

test('cross-bot continuation verifies same chat and scope, retaining source identity only for audit', async () => {
  const calls = [];
  const result = await enqueueContinuation({ actionName: 'incident.flow.review', action: actions[1], payload: payload(), operatorId: 'ou_person123', eventId: 'event' }, {
    dashboardBase: 'http://localhost', dashboardToken: 'test', fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => url.endsWith('/api/sessions') ? [{ sessionId: 'review-session', larkAppId: 'cli_quality', chatId: 'oc_source', scope: 'chat' }] : { ok: true, triggerId: 'trigger-1' } };
    },
  });
  const body = JSON.parse(calls[1].options.body);
  assert.deepEqual(body.target, { kind: 'turn', botId: 'cli_quality', sessionId: 'review-session' });
  assert.equal(body.instruction, actions[1].instruction);
  assert.equal(body.envelope.payload.source_bot_id, 'cli_source');
  assert.equal(body.envelope.trusted, false);
  assert.equal(body.options.steer, undefined);
  assert.equal(result.sessionId, 'review-session');
});

test('wrong chat, wrong topic, missing or ambiguous target never triggers a task', async () => {
  for (const sessions of [[], [{ sessionId: 'review-session', larkAppId: 'cli_quality', chatId: 'oc_other', scope: 'chat' }], [{ sessionId: 'review-session', larkAppId: 'cli_quality', chatId: 'oc_source', scope: 'thread', rootMessageId: 'om_other' }], Array(2).fill({ sessionId: 'review-session', larkAppId: 'cli_quality', chatId: 'oc_source', scope: 'chat' })]) {
    await assert.rejects(enqueueContinuation({ actionName: 'incident.flow.review', action: actions[1], payload: payload(), operatorId: 'ou_person123', eventId: 'event' }, {
      dashboardBase: 'http://localhost', dashboardToken: 'test', fetch: async url => {
        assert.ok(url.endsWith('/api/sessions'));
        return { ok: true, json: async () => sessions };
      },
    }), /target_session_missing_or_ambiguous/);
  }
});

test('configured custom callback runs once, rejects unrendered actions and snapshot tampering', async t => {
  const home = mkdtempSync(join(tmpdir(), 'custom-actions-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const p = payload(); const encoded = encodePayload(p); const secret = 'test-secret-test-secret-test-secret';
  const binding = { cardId: p.cardId, messageId: 'om_card', encodedPayload: encoded, baseCard: { elements: [] }, actions };
  writeCardBinding(home, binding);
  let calls = 0;
  const server = createServer(createIncidentActionHandler({ pluginHome: home, token: 'test-token', signingSecret: secret, enqueue: async input => { calls++; assert.equal(input.action.instruction, actions[0].instruction); return { triggerId: 'trigger' }; } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = async (name, event) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/botmux/card-actions/v1`, { method: 'POST', headers: { authorization: 'Bearer test-token' }, body: JSON.stringify({ schemaVersion: 1, eventId: event, larkAppId: p.larkAppId, operator: { open_id: 'ou_person123' }, context: { open_message_id: 'om_card' }, actionName: name, action: { value: { action: name, payload: encoded, signature: signAction(name, encoded, secret) } } }) });
    return response.json();
  };
  assert.match((await post('incident.flow.repair', 'unknown')).ack.toast.content, /unknown_action/);
  assert.equal((await post('incident.flow.inspect', 'first')).ack.toast.type, 'success');
  assert.match((await post('incident.flow.review', 'second')).ack.toast.content, /补查证据/);
  assert.equal(calls, 1);
  writeCardBinding(home, { ...binding, actions: [{ ...actions[0], instruction: 'tampered' }] });
  assert.match((await post('incident.flow.inspect', 'third')).ack.toast.content, /snapshot_mismatch/);
  assert.equal(calls, 1);
});

test('send dry-run resolves bot profile without sending or persisting secrets', async t => {
  const keys = ['BOTMUX_SESSION_ID', 'BOTMUX_CHAT_ID', 'BOTMUX_LARK_APP_ID', 'BOTMUX_OWNER_OPEN_ID', 'BOTMUX_SESSION_SCOPE'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => keys.forEach(key => old[key] === undefined ? delete process.env[key] : process.env[key] = old[key]));
  Object.assign(process.env, { BOTMUX_SESSION_ID: 'session', BOTMUX_CHAT_ID: 'oc_chat', BOTMUX_LARK_APP_ID: 'cli_source', BOTMUX_OWNER_OPEN_ID: 'ou_person123', BOTMUX_SESSION_SCOPE: 'chat' });
  const result = JSON.parse(await handlers['incident-flow-actions:send'].run({ args: ['--incident-id', 'test', '--summary', 'Preview', '--dry-run'], pluginId: 'incident-flow-actions', api: { config: { get: key => key === 'workflowConfig' ? config : undefined, set: () => assert.fail('dry-run must not write') } } }));
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.actions.map(action => action.id), ['inspect', 'review']);
  const ctx = { args: ['--incident-id', 'test', '--summary', 'Preview', '--action', 'review', '--dry-run'], pluginId: 'incident-flow-actions', api: { config: { get: key => key === 'workflowConfig' ? config : undefined, set: () => assert.fail('dry-run must not write') } } };
  const selected = JSON.parse(await handlers['incident-flow-actions:send'].run(ctx));
  assert.deepEqual(selected.actions.map(action => action.id), ['review']);
  assert.equal(selected.card.schema, '2.0');
  assert.equal(selected.card.body.elements.at(-1).columns.length, 1);
  await assert.rejects(() => handlers['incident-flow-actions:send'].run({ ...ctx, args: [...ctx.args, '--action', 'unknown'] }), /unknown_action/);

});


test('host configuration entry validates without exposing or replacing the signing key', t => {
  const home = mkdtempSync(join(tmpdir(), 'host-actions-config-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ signingSecret: 'keep-private-secret', unrelated: true }));
  const file = join(home, 'workflow.json');
  writeFileSync(file, JSON.stringify(config));
  const run = extra => spawnSync(process.execPath, ['src/cli/configure.js', '--plugin-home', home, '--file', file, ...extra], { encoding: 'utf8' });
  const check = run([]);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(readFileSync(join(home, 'config.json'))).workflowConfig, undefined);
  const applied = run(['--apply']);
  assert.equal(applied.status, 0, applied.stderr);
  assert.ok(!applied.stdout.includes('keep-private-secret'));
  const saved = JSON.parse(readFileSync(join(home, 'config.json')));
  assert.equal(saved.signingSecret, 'keep-private-secret');
  assert.equal(saved.unrelated, true);
  assert.equal(saved.workflowConfig.bots.cli_source.profile, 'custom');
  writeFileSync(file, JSON.stringify({ ...config, defaultProfile: 'unknown' }));
  assert.equal(run(['--apply']).status, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'config.json'))), saved);
});
