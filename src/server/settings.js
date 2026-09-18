import { normalizeConfig } from '../lib/config.js';

// The Dashboard adapter deliberately exposes only the public workflow settings.
export function getSettings(api) {
  return { workflowConfig: normalizeConfig(api.config.get('workflowConfig')) };
}
export function saveSettings(api, body) {
  if (!body || Object.keys(body).some(key => key !== 'workflowConfig')) throw new Error('invalid_settings');
  if (!body.workflowConfig) throw new Error('workflow_config_required');
  const workflowConfig = normalizeConfig(body.workflowConfig);
  api.config.set('workflowConfig', workflowConfig);
  return { workflowConfig };
}
