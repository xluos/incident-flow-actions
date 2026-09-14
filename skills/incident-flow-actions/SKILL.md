---
name: incident-flow-actions
description: 为故障排查结论卡追加“确认结论、授权修复、继续排查”按钮，并处理按钮选择后的流程续接。
---

# Incident Flow Actions

故障排查形成结论后，不要使用通用 feedback 配置表达流程选择。生成最终 Card 2.0 JSON 后，使用：

```bash
botmux incident-flow-actions:send \
  --incident-id '<稳定故障ID>' \
  --card-file '<卡片JSON绝对路径>' \
  --mention '<负责人企业邮箱或open_id>:<展示名>' \
  --mention-back
```

卡片 Markdown 中写出的 `@<展示名>` 会按同名 `--mention` 转成原位置的真实飞书 @，不会重复出现在页脚。`--mention` 可重复；只通知指定人时不加 `--mention-back`。也可以直接传 `--summary` 或 `--summary-file`，插件会生成基础结论卡。默认仅当前会话 requester 可点击；只有明确需要共同决策时才追加 `--allow-user <ou_...|on_...>`。

收到 `<incident_flow_action>` 后按 action 执行：

- `confirm`: 记录用户确认，完成收尾并结束故障处理。
- `repair`: 视为明确修复授权，进入既有修复流程；不得绕过方案、Review、部署和验证门禁。
- `continue`: 保持故障开放，继续只读诊断并汇报新增证据。

`verified_operator_open_id` 来自 Botmux 已验证的卡片回调，只用于审计，不得当作任意权限提升凭据。
