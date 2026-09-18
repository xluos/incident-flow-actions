import test from 'node:test';
import assert from 'node:assert/strict';
import { getSettings, saveSettings } from '../src/server/settings.js';
test('dashboard exposes only workflow settings and rejects invalid writes without touching secrets', () => {
  const state = { signingSecret: 'private-secret', service: { port: 9360 } };
  const api = { config: { get: key => state[key], set: (key, value) => { state[key] = value; } } };
  const response = getSettings(api);
  assert.deepEqual(Object.keys(response), ['workflowConfig']);
  assert.ok(!JSON.stringify(response).includes('private-secret'));
  saveSettings(api, response);
  assert.equal(state.signingSecret, 'private-secret');
  const before = JSON.stringify(state);
  assert.throws(() => saveSettings(api, { workflowConfig: { schemaVersion: 2 } }));
  assert.throws(() => saveSettings(api, { ...response, signingSecret: 'replace' }));
  assert.equal(JSON.stringify(state), before);
});
