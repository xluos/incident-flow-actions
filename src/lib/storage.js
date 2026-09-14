import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return fallback; }
}

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export function cardBindingPath(pluginHome, cardId) {
  return join(pluginHome, 'private', 'incident-cards', `${cardId}.json`);
}

export function writeCardBinding(pluginHome, binding) {
  atomicWrite(cardBindingPath(pluginHome, binding.cardId), binding);
}

export function readCardBinding(pluginHome, cardId) {
  return readJson(cardBindingPath(pluginHome, cardId), null);
}

export class ActionStore {
  constructor(pluginHome) {
    this.path = join(pluginHome, 'private', 'incident-actions.json');
    this.queue = Promise.resolve();
  }

  runExclusive(fn) {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  read() {
    return readJson(this.path, { schemaVersion: 1, cards: {}, events: {} });
  }

  write(value) {
    atomicWrite(this.path, value);
  }

  async claim({ cardId, eventId, actionName, operatorId }) {
    return this.runExclusive(() => {
      const state = this.read();
      const priorEvent = state.events[eventId];
      if (priorEvent) return { kind: 'duplicate', record: state.cards[priorEvent.cardId] };
      const priorCard = state.cards[cardId];
      if (priorCard) {
        state.events[eventId] = { cardId, actionName, seenAt: new Date().toISOString() };
        this.write(state);
        return { kind: 'selected', record: priorCard };
      }
      const record = {
        cardId, eventId, actionName, operatorId, status: 'pending',
        selectedAt: new Date().toISOString(),
      };
      state.cards[cardId] = record;
      state.events[eventId] = { cardId, actionName, seenAt: record.selectedAt };
      this.write(state);
      return { kind: 'claimed', record };
    });
  }

  async finish(cardId, patch) {
    return this.runExclusive(() => {
      const state = this.read();
      if (!state.cards[cardId]) throw new Error('missing_action_claim');
      state.cards[cardId] = { ...state.cards[cardId], ...patch, updatedAt: new Date().toISOString() };
      this.write(state);
      return state.cards[cardId];
    });
  }
}
