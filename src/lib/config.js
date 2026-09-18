import { createHash } from 'node:crypto';

const ID = /^[a-z][a-z0-9_-]{0,47}$/;
const BOT = /^cli_[A-Za-z0-9_-]+$/;
const own = (object, key) => Object.hasOwn(object, key);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, name, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`invalid_${name}`);
  return value.trim();
};
export const DEFAULT_ACTIONS = Object.freeze([
  { id: 'confirm', label: '确认结论', style: 'default', instruction: '用户已确认故障结论。记录确认，完成必要收尾，并结束本次故障处理。' },
  { id: 'repair', label: '授权修复', style: 'primary', confirmation: { title: '确认授权修复', text: '确认后，故障机器人将进入修复流程并记录本次授权。' }, instruction: '用户已明确授权修复。记录授权，按故障修复流程继续；仍需遵守现有发布、Review 和验证门禁。' },
  { id: 'continue', label: '继续排查', style: 'default', instruction: '用户要求继续排查。保持故障未关闭，基于现有证据继续诊断并汇报新的结论。' },
]);
export function normalizeActions(actions) {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 5) throw new Error('actions_must_have_1_to_5_buttons');
  const seen = new Set();
  return actions.map(action => {
    if (!plain(action) || !ID.test(action.id) || seen.has(action.id)) throw new Error('invalid_or_duplicate_action_id');
    seen.add(action.id);
    const style = action.style ?? 'default';
    if (!['default', 'primary', 'danger'].includes(style)) throw new Error('invalid_action_style');
    const result = { id: action.id, label: text(action.label, 'action_label', 40), style, instruction: text(action.instruction, 'action_instruction', 8000) };
    if (action.confirmation != null) {
      if (!plain(action.confirmation)) throw new Error('invalid_confirmation');
      result.confirmation = { title: text(action.confirmation.title, 'confirmation_title', 80), text: text(action.confirmation.text, 'confirmation_text', 500) };
    }
    if (action.target != null) {
      if (!plain(action.target) || Object.keys(action.target).some(key => !['botId', 'sessionId'].includes(key)) || !BOT.test(action.target.botId)) throw new Error('invalid_target_botId');
      result.target = { botId: action.target.botId };
      if (action.target.sessionId !== undefined) {
        if (!/^[A-Za-z0-9_-]{1,160}$/.test(action.target.sessionId)) throw new Error('invalid_target_sessionId');
        result.target.sessionId = action.target.sessionId;
      }
    }
    const known = new Set(['id', 'label', 'style', 'instruction', 'confirmation', 'target']);
    if (Object.keys(action).some(key => !known.has(key))) throw new Error('unknown_action_setting');
    return result;
  });
}
export function normalizeConfig(input) {
  if (input === undefined) input = { schemaVersion: 1, defaultProfile: 'incident', profiles: { incident: { actions: DEFAULT_ACTIONS } }, bots: {} };
  if (!plain(input) || input.schemaVersion !== 1 || !plain(input.profiles) || !plain(input.bots ?? {})) throw new Error('invalid_workflow_config');
  if (Object.keys(input).some(key => !['schemaVersion', 'defaultProfile', 'profiles', 'bots'].includes(key))) throw new Error('unknown_workflow_setting');
  const profiles = Object.create(null);
  for (const [id, profile] of Object.entries(input.profiles)) {
    if (!ID.test(id) || !plain(profile) || Object.keys(profile).some(key => key !== 'actions')) throw new Error('invalid_profile');
    profiles[id] = { actions: normalizeActions(profile.actions) };
  }
  if (!Object.keys(profiles).length) throw new Error('profiles_required');
  const defaultProfile = input.defaultProfile ?? null;
  if (defaultProfile !== null && !own(profiles, defaultProfile)) throw new Error('unknown_default_profile');
  const bots = Object.create(null);
  for (const [id, bot] of Object.entries(input.bots ?? {})) {
    if (!BOT.test(id) || !plain(bot) || typeof bot.enabled !== 'boolean' || Object.keys(bot).some(key => !['enabled', 'profile'].includes(key))) throw new Error('invalid_bot_setting');
    if (bot.profile !== undefined && !own(profiles, bot.profile)) throw new Error('unknown_bot_profile');
    if (bot.enabled && !bot.profile && !defaultProfile) throw new Error('bot_profile_required');
    bots[id] = { enabled: bot.enabled, ...(bot.profile ? { profile: bot.profile } : {}) };
  }
  return { schemaVersion: 1, defaultProfile, profiles, bots };
}
export function resolveActions(input, botId, requestedProfile) {
  const config = normalizeConfig(input);
  const bot = config.bots[botId];
  if (bot?.enabled === false || (!bot && config.defaultProfile === null)) throw new Error('bot_not_enabled');
  const profileId = requestedProfile ?? bot?.profile ?? config.defaultProfile;
  if (!profileId || !own(config.profiles, profileId)) throw new Error('unknown_profile');
  return { profileId, actions: config.profiles[profileId].actions };
}
export function actionsHash(actions) {
  return createHash('sha256').update(JSON.stringify(normalizeActions(actions))).digest('hex');
}
export function bindingActions(binding, payload) {
  if (!payload.actionsHash) return normalizeActions(DEFAULT_ACTIONS);
  const actions = normalizeActions(binding.actions);
  if (actionsHash(actions) !== payload.actionsHash) throw new Error('action_snapshot_mismatch');
  return actions;
}
