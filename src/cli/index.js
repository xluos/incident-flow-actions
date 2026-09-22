import { randomBytes, randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { renderActionCard, createSimpleResultCard } from '../lib/card.js';
import { ACTION_PREFIX, encodePayload, signAction, validatePayload } from '../lib/protocol.js';
import { actionsHash, normalizeConfig, resolveActions } from '../lib/config.js';
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

export function buildSendMentionArgs(args, additional = []) {
  if (args.includes('--no-mention')) {
    if (args.includes('--mention') || args.includes('--mention-back')) throw new Error('--no-mention cannot be combined with --mention or --mention-back');
    return ['--no-mention'];
  }
  const explicit = [...additional, ...values(args, '--mention')
    .map(item => item.trim())
    .filter(Boolean)
    .flatMap(item => ['--mention', item])];
  if (args.includes('--mention-back')) explicit.push('--mention-back');
  return explicit.length > 0 ? explicit : ['--no-mention'];
}

export function readOwnerIdentity(args) {
  const ownerFile = value(args, '--owner-file');
  if (!ownerFile) return null;
  const parsed = JSON.parse(readFileSync(resolve(ownerFile), 'utf8'));
  return parsed.repair_owner || parsed.ownership?.repair_owner || null;
}

export function applyOwnerIdentity(card, owner) {
  if (!owner) return card;
  const displayName = owner.mention_status === 'resolved'
    ? owner.mention_display_name || owner.name
    : owner.name || owner.mention_display_name;
  if (!displayName) return card;
  const replacement = owner.mention_status === 'resolved' && owner.mention_arg
    ? `@${displayName}`
    : `${displayName}（未通知：${owner.mention_status || 'unavailable'}）`;
  const output = structuredClone(card);
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.tag === 'markdown' && typeof node.content === 'string') {
      node.content = node.content.replaceAll('{{repair_owner}}', replacement);
    }
    if (Array.isArray(node)) node.forEach(visit);
    else Object.values(node).forEach(visit);
  };
  visit(output);
  return output;
}

export function buildOwnerMentionArgs(owner) {
  if (owner?.mention_status !== 'resolved' || !owner.mention_arg) return [];
  return ['--mention', owner.mention_arg];
}

async function sendIncidentCard(ctx) {
  const args = ctx.args;
  if (args.includes('--help') || args.includes('-h')) {
    return `用法:
  botmux incident-flow-actions:send --incident-id <id> --card-file <card.json> [--owner-file <owner-identity.json>] [--mention-back] [--allow-user <ou_...|on_...>]...
  botmux incident-flow-actions:send --incident-id <id> --summary <markdown> [--title <title>]

可选 --profile <方案名>、重复 --action <动作ID> 选择本次按钮，和 --dry-run；按钮及指令由 incident-flow-actions:config 配置。默认仅当前会话 requester 可点击。--owner-file 会把 {{repair_owner}} 替换为负责人真实 @；--allow-user 可追加指定操作者。`;
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
    if (!args.includes('--dry-run')) ctx.api.config.set('signingSecret', secret);
  }
  const allowedOperatorIds = [...new Set([requester, ...values(args, '--allow-user').map(id => id.trim())])];
  const { profileId, actions: configuredActions } = resolveActions(ctx.api.config.get('workflowConfig'), larkAppId, value(args, '--profile'));
  const requestedActions = values(args, '--action');
  if (args.includes('--action') && requestedActions.length === 0) throw new Error('--action requires an action ID');
  if (requestedActions.some(id => !configuredActions.some(action => action.id === id))) throw new Error('unknown_action');
  const actions = requestedActions.length ? configuredActions.filter(action => requestedActions.includes(action.id)) : configuredActions;
  const issuedAt = Date.now();
  const payload = {
    schemaVersion: 1,
    actionsHash: actionsHash(actions),
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
  validatePayload(payload);
  const encodedPayload = encodePayload(payload);
  const valueFor = actionName => ({
    action: actionName,
    payload: encodedPayload,
    signature: signAction(actionName, encodedPayload, secret),
  });
  const rawOwner = readOwnerIdentity(args);
  const owner = rawOwner && args.includes('--no-mention')
    ? { ...rawOwner, mention_status: 'suppressed' }
    : rawOwner;
  const baseCard = applyOwnerIdentity(readCard(args), owner);
  const card = renderActionCard(baseCard, valueFor, undefined, 'completed', actions);
  if (args.includes('--dry-run')) return JSON.stringify({ success: true, dryRun: true, profileId, botId: larkAppId, actions, card });
  const binary = process.env.BOTMUX_BIN || 'botmux';
  const sent = await execFile(binary, [
    'send', '--card-json', JSON.stringify(card),
    '--plugin-card-action', ctx.pluginId,
    '--response-kind', 'final',
    ...buildSendMentionArgs(args, buildOwnerMentionArgs(owner)),
  ], { env: process.env, cwd: process.cwd(), encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  const receipt = parseSendOutput(sent.stdout);
  const pluginHome = dirname(ctx.api.config.path);
  writeCardBinding(pluginHome, {
    schemaVersion: 1,
    cardId: payload.cardId,
    messageId: receipt.messageId,
    encodedPayload,
    baseCard,
    actions,
    profileId,
    createdAt: new Date().toISOString(),
  });
  return JSON.stringify({
    success: true,
    incidentId,
    cardId: payload.cardId,
    messageId: receipt.messageId,
    profileId,
    actions: actions.map(action => ACTION_PREFIX + action.id),
  });
}

export async function configureActions(ctx) {
  const args = ctx.args;
  if (args.includes('--help')) return 'incident-flow-actions:config [--file <config.json> --apply] [--bot <cli_appid>]：默认只校验/查看，--apply 保存。';
  const file = value(args, '--file');
  if (args.includes('--apply') && !file) throw new Error('--file required with --apply');
  const config = normalizeConfig(file ? JSON.parse(readFileSync(resolve(file), 'utf8')) : ctx.api.config.get('workflowConfig'));
  const botId = value(args, '--bot');
  const resolved = botId ? resolveActions(config, botId) : undefined;
  if (args.includes('--apply')) ctx.api.config.set('workflowConfig', config);
  return JSON.stringify({ ok: true, applied: args.includes('--apply'), config, ...(resolved ? { resolved } : {}) });
}

export default {
  'incident-flow-actions:config': { description: 'Validate, inspect or apply per-bot action profiles.', run: configureActions },
  'incident-flow-actions:send': {
    description: 'Send an incident result card with workflow action buttons.',
    run: sendIncidentCard,
  },
};
