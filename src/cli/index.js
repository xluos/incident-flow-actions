import { randomBytes, randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { renderActionCard, createSimpleResultCard } from '../lib/card.js';
import { ACTIONS, encodePayload, signAction } from '../lib/protocol.js';
import { writeCardBinding } from '../lib/storage.js';

const execFile = promisify(execFileCallback);

function values(args, name) {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === name && args[i + 1]) out.push(args[++i]);
  return out;
}

function value(args, name) {
  return values(args, name).at(-1);
}

function requireValue(args, name) {
  const result = value(args, name)?.trim();
  if (!result) throw new Error(`${name} is required`);
  return result;
}

function readCard(args) {
  const cardFile = value(args, '--card-file');
  if (cardFile) return JSON.parse(readFileSync(resolve(cardFile), 'utf8'));
  const title = value(args, '--title')?.trim() || '故障排查结论';
  const summaryFile = value(args, '--summary-file');
  const summary = summaryFile
    ? readFileSync(resolve(summaryFile), 'utf8').trim()
    : value(args, '--summary')?.trim();
  if (!summary) throw new Error('--card-file or --summary/--summary-file is required');
  return createSimpleResultCard({ title, summary });
}

function parseSendOutput(stdout) {
  const lines = String(stdout).trim().split('\n').reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed?.success === true && typeof parsed.messageId === 'string') return parsed;
    } catch { /* keep looking */ }
  }
  throw new Error('botmux send did not return a messageId');
}

export function buildSendMentionArgs(args) {
  const explicit = values(args, '--mention')
    .map(item => item.trim())
    .filter(Boolean)
    .flatMap(item => ['--mention', item]);
  if (args.includes('--mention-back')) explicit.push('--mention-back');
  return explicit.length > 0 ? explicit : ['--no-mention'];
}

async function sendIncidentCard(ctx) {
  const args = ctx.args;
  if (args.includes('--help') || args.includes('-h')) {
    return `用法:
  botmux incident-flow-actions:send --incident-id <id> --card-file <card.json> [--mention <id:name>]... [--mention-back] [--allow-user <ou_...|on_...>]...
  botmux incident-flow-actions:send --incident-id <id> --summary <markdown> [--title <title>]

默认仅当前会话 requester 可点击。--allow-user 可追加指定操作者；--mention 会透传给 botmux send，并可将卡片 Markdown 中的 @姓名渲染为真实提及。`;
  }
  const incidentId = requireValue(args, '--incident-id');
  const sessionId = process.env.BOTMUX_SESSION_ID?.trim();
  const chatId = process.env.BOTMUX_CHAT_ID?.trim();
  const larkAppId = process.env.BOTMUX_LARK_APP_ID?.trim();
  const sessionScope = process.env.BOTMUX_SESSION_SCOPE === 'thread' ? 'thread' : 'chat';
  const rootMessageId = process.env.BOTMUX_ROOT_MESSAGE_ID?.trim();
  const requester = process.env.BOTMUX_OWNER_OPEN_ID?.trim() || process.env.__OWNER_OPEN_ID?.trim();
  if (!sessionId || !chatId || !larkAppId || !requester) {
    throw new Error('incident card must be sent from a managed Botmux session with a verified requester');
  }
  if (sessionScope === 'thread' && !rootMessageId) throw new Error('thread session is missing BOTMUX_ROOT_MESSAGE_ID');

  let secret = ctx.api.config.get('signingSecret');
  if (typeof secret !== 'string' || secret.length < 32) {
    secret = randomBytes(32).toString('base64url');
    ctx.api.config.set('signingSecret', secret);
  }
  const allowedOperatorIds = [...new Set([requester, ...values(args, '--allow-user').map(id => id.trim())])];
  const issuedAt = Date.now();
  const payload = {
    schemaVersion: 1,
    cardId: randomUUID(),
    incidentId,
    sessionId,
    chatId,
    larkAppId,
    sessionScope,
    ...(rootMessageId ? { rootMessageId } : {}),
    workingDir: process.cwd(),
    ...(process.env.SESSION_DATA_DIR ? { dataDir: resolve(process.env.SESSION_DATA_DIR) } : {}),
    allowedOperatorIds,
    issuedAt,
    expiresAt: issuedAt + 7 * 24 * 60 * 60 * 1000,
  };
  const encodedPayload = encodePayload(payload);
  const valueFor = actionName => ({
    action: actionName,
    payload: encodedPayload,
    signature: signAction(actionName, encodedPayload, secret),
  });
  const baseCard = readCard(args);
  const card = renderActionCard(baseCard, valueFor);
  const binary = process.env.BOTMUX_BIN || 'botmux';
  const sent = await execFile(binary, [
    'send', '--card-json', JSON.stringify(card),
    '--plugin-card-action', ctx.pluginId,
    ...buildSendMentionArgs(args),
  ], { env: process.env, cwd: process.cwd(), encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  const receipt = parseSendOutput(sent.stdout);
  const pluginHome = dirname(ctx.api.config.path);
  writeCardBinding(pluginHome, {
    schemaVersion: 1,
    cardId: payload.cardId,
    messageId: receipt.messageId,
    encodedPayload,
    baseCard,
    createdAt: new Date().toISOString(),
  });
  return JSON.stringify({
    success: true,
    incidentId,
    cardId: payload.cardId,
    messageId: receipt.messageId,
    actions: Object.values(ACTIONS),
  });
}

export default {
  'incident-flow-actions:send': {
    description: 'Send an incident result card with workflow action buttons.',
    run: sendIncidentCard,
  },
};
