import { ACTION_META, ACTIONS } from './protocol.js';

export const ACTION_ELEMENT_ID = 'incident_flow_actions';
export const STATUS_ELEMENT_ID = 'incident_flow_status';

function callbackButton(actionName, valueFor, selectedAction) {
  const meta = ACTION_META[actionName];
  const selected = selectedAction === actionName;
  const button = {
    tag: 'button',
    text: { tag: 'plain_text', content: selected ? `✓ ${meta.label}` : meta.label },
    type: selected ? 'primary' : meta.style,
    disabled: !!selectedAction,
  };
  if (!selectedAction) button.behaviors = [{ type: 'callback', value: valueFor(actionName) }];
  if (actionName === ACTIONS.repair && !selectedAction) {
    button.confirm = {
      title: { tag: 'plain_text', content: '确认授权修复' },
      text: { tag: 'plain_text', content: '确认后，故障机器人将进入修复流程并记录本次授权。' },
    };
  }
  return button;
}

function v2Actions(valueFor, selectedAction) {
  return {
    tag: 'column_set',
    element_id: ACTION_ELEMENT_ID,
    flex_mode: 'none',
    horizontal_spacing: 'small',
    columns: Object.values(ACTIONS).map(actionName => ({
      tag: 'column',
      width: 'auto',
      elements: [callbackButton(actionName, valueFor, selectedAction)],
    })),
  };
}

function legacyActions(valueFor, selectedAction) {
  return {
    tag: 'action',
    element_id: ACTION_ELEMENT_ID,
    actions: Object.values(ACTIONS).map(actionName => {
      const button = callbackButton(actionName, valueFor, selectedAction);
      if (button.behaviors) {
        button.value = button.behaviors[0].value;
        delete button.behaviors;
      }
      return button;
    }),
  };
}

function statusElement(selectedAction, state) {
  if (!selectedAction) return null;
  const label = ACTION_META[selectedAction]?.label ?? selectedAction;
  const suffix = state === 'failed' ? '，但后续流程启动失败，请联系管理员处理' : '，后续流程已自动启动';
  return {
    tag: 'markdown',
    element_id: STATUS_ELEMENT_ID,
    content: `已选择：**${label}**${suffix}`,
  };
}

export function createSimpleResultCard({ title, summary }) {
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: title } },
    elements: [{ tag: 'markdown', content: summary }],
  };
}

export function renderActionCard(baseCard, valueFor, selectedAction, state = 'completed') {
  const card = structuredClone(baseCard);
  const isV2 = card.schema === '2.0' || card.body?.elements;
  const elements = isV2
    ? (card.body ??= {}).elements ??= []
    : card.elements ??= [];
  const retained = elements.filter(element =>
    element?.element_id !== ACTION_ELEMENT_ID && element?.element_id !== STATUS_ELEMENT_ID);
  // A completed decision is immutable. Remove callback-capable controls rather
  // than returning disabled buttons: Botmux intentionally rejects inert button
  // elements in plugin callback responses because they have no allowlisted
  // action payload.
  if (!selectedAction) {
    retained.push(isV2 ? v2Actions(valueFor, selectedAction) : legacyActions(valueFor, selectedAction));
  }
  const status = statusElement(selectedAction, state);
  if (status) retained.push(status);
  if (isV2) card.body.elements = retained;
  else card.elements = retained;
  return card;
}
