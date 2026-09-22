import { ACTION_PREFIX } from './protocol.js';
import { DEFAULT_ACTIONS } from './config.js';

export const ACTION_ELEMENT_ID = 'incident_flow_actions';
export const STATUS_ELEMENT_ID = 'incident_flow_status';

function callbackButton(meta, valueFor, selectedAction) {
  const actionName = ACTION_PREFIX + meta.id;
  const selected = selectedAction === actionName;
  const button = {
    tag: 'button',
    text: { tag: 'plain_text', content: selected ? `✓ ${meta.label}` : meta.label },
    type: selected ? 'primary' : meta.style,
    disabled: !!selectedAction,
  };
  if (!selectedAction) button.behaviors = [{ type: 'callback', value: valueFor(actionName) }];
  if (meta.confirmation && !selectedAction) {
    button.confirm = {
      title: { tag: 'plain_text', content: meta.confirmation.title },
      text: { tag: 'plain_text', content: meta.confirmation.text },
    };
  }
  return button;
}

function v2Actions(valueFor, selectedAction, actions) {
  return {
    tag: 'column_set',
    element_id: ACTION_ELEMENT_ID,
    flex_mode: 'none',
    horizontal_spacing: 'small',
    columns: actions.map(meta => ({
      tag: 'column',
      width: 'auto',
      elements: [callbackButton(meta, valueFor, selectedAction)],
    })),
  };
}

function legacyActions(valueFor, selectedAction, actions) {
  return {
    tag: 'action',
    element_id: ACTION_ELEMENT_ID,
    actions: actions.map(meta => {
      const button = callbackButton(meta, valueFor, selectedAction);
      if (button.behaviors) {
        button.value = button.behaviors[0].value;
        delete button.behaviors;
      }
      return button;
    }),
  };
}

function statusElement(selectedAction, state, actions) {
  if (!selectedAction) return null;
  const label = actions.find(action => ACTION_PREFIX + action.id === selectedAction)?.label ?? selectedAction;
  const suffix = state === 'failed' ? '，但后续流程启动失败，请联系管理员处理' : state === 'pending' ? '，正在提交后续任务' : '，后续任务已接收，将由对应机器人执行';
  return {
    tag: 'markdown',
    element_id: STATUS_ELEMENT_ID,
    content: `已选择：**${label}**${suffix}`,
  };
}

export function createSimpleResultCard({ title, summary }) {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: title } },
    body: { elements: [{ tag: 'markdown', content: summary }] },
  };
}

export function renderActionCard(baseCard, valueFor, selectedAction, state = 'completed', actions = DEFAULT_ACTIONS) {
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
    retained.push(isV2 ? v2Actions(valueFor, selectedAction, actions) : legacyActions(valueFor, selectedAction, actions));
  }
  const status = statusElement(selectedAction, state, actions);
  if (status) retained.push(status);
  if (isV2) card.body.elements = retained;
  else card.elements = retained;
  return card;
}
