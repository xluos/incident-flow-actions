import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { ACTION_META } from './protocol.js';

const execFile = promisify(execFileCallback);

export function continuationPrompt({ actionName, payload, operatorId, eventId }) {
  const action = ACTION_META[actionName]?.key;
  const instruction = action === 'confirm'
    ? '用户已确认故障结论。记录确认，完成必要收尾，并结束本次故障处理。'
    : action === 'repair'
      ? '用户已明确授权修复。记录授权，按故障修复流程继续；仍需遵守现有发布、Review 和验证门禁。'
      : '用户要求继续排查。保持故障未关闭，基于现有证据继续诊断并汇报新的结论。';
  return [
    '<incident_flow_action schema_version="1">',
    `  <incident_id>${payload.incidentId}</incident_id>`,
    `  <action>${action}</action>`,
    `  <verified_operator_open_id>${operatorId}</verified_operator_open_id>`,
    `  <event_id>${eventId}</event_id>`,
    '</incident_flow_action>',
    instruction,
  ].join('\n');
}

function parseTaskId(stdout) {
  const match = String(stdout).match(/\[([^\]\s]+)\]/);
  if (!match) throw new Error('schedule_task_id_missing');
  return match[1];
}

async function defaultRun(binary, args, options) {
  return execFile(binary, args, { ...options, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 });
}

export async function enqueueContinuation(input, deps = {}) {
  const run = deps.run ?? defaultRun;
  const binary = deps.binary ?? process.env.BOTMUX_BIN ?? 'botmux';
  const { payload } = input;
  const prompt = continuationPrompt(input);
  const env = {
    ...process.env,
    BOTMUX_SESSION_ID: payload.sessionId,
    BOTMUX_CHAT_ID: payload.chatId,
    BOTMUX_LARK_APP_ID: payload.larkAppId,
    BOTMUX_SESSION_SCOPE: payload.sessionScope,
    BOTMUX_OWNER_OPEN_ID: input.operatorId,
    ...(payload.rootMessageId ? { BOTMUX_ROOT_MESSAGE_ID: payload.rootMessageId } : {}),
    ...(payload.dataDir ? { SESSION_DATA_DIR: payload.dataDir } : {}),
  };
  const args = [
    'schedule', 'add', '1d', prompt,
    '--name', `incident-action:${payload.cardId}`,
    '--chat-id', payload.chatId,
    '--lark-app-id', payload.larkAppId,
    '--workdir', payload.workingDir,
    '--silent',
  ];
  if (payload.sessionScope === 'thread') {
    args.push('--topic', '--root-msg-id', payload.rootMessageId);
  } else {
    args.push('--top-level');
  }
  const created = await run(binary, args, { env, cwd: payload.workingDir });
  const taskId = parseTaskId(created.stdout);
  await run(binary, ['schedule', 'run', taskId, '--lark-app-id', payload.larkAppId], {
    env,
    cwd: payload.workingDir,
  });
  return { taskId };
}
