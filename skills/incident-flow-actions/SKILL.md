---
name: incident-flow-actions
description: 为机器人结果卡添加可配置操作按钮，支持按机器人选择方案、确认弹窗和点击后继续任务。适用于故障结论、Review 或其他需要用户选择下一步的卡片。
---

# 结果卡操作按钮

按钮及指令来自插件配置。发送前通过 `botmux incident-flow-actions:config --bot "$BOTMUX_LARK_APP_ID"` 查看当前机器人的方案，不能把默认的确认、修复、继续排查三个动作当作所有机器人的固定流程。

```bash
botmux incident-flow-actions:send \
  --incident-id '<稳定任务ID>' \
  --card-file '<卡片JSON绝对路径>' \
  --owner-file '<owner-identity.json>'
```

也可传 `--summary` 或 `--summary-file` 生成基础卡。`--profile <方案名>` 选择已配置方案；`--dry-run` 只生成预览，不发送消息。命令必须在有已验证请求人的 Botmux 会话中运行，卡片以当前机器人的身份发送。

负责人身份文件的 `repair_owner` 驱动 Markdown 中 `{{repair_owner}}` 和实际 mention。也支持重复传 `--mention <id或邮箱:展示名>`。直接响应真人且需要提醒原请求人时可加 `--mention-back`；后台交接不要自动 @ 交接机器人。未解析的负责人不得伪造真实 @。

默认只有请求人可点击，明确需要共同决策时可追加 `--allow-user <ou_...|on_...>`。点击后的指令和目标采用发卡时的快照；修改配置只影响新卡。一个卡片接受一次选择。失败会显示错误，不能把“点击被接收”称为业务执行完成。

回调通过 Trigger API 续接原会话。动作可配置目标机器人，同群、同话题中必须有唯一可确定的目标会话；缺失或歧义会报错，不自动建群或选择其他任务。跨机器人回调里的操作者 open_id 属于发卡应用，仅用于审计，不能当作目标应用的权限凭据。接手后按当前任务授权执行并汇报结果，不把按钮当作绕过既有授权边界的凭据。

## 配置入口

`botmux incident-flow-actions:config --file <配置JSON>` 只校验，追加 `--apply` 保存；不传文件则查看当前配置，不输出签名密钥。配置位于插件自己的 `workflowConfig` 字段：

- `schemaVersion: 1`，`profiles.<方案名>.actions` 定义 1～5 个有序按钮。
- 每个动作包含唯一 `id`、`label`、`style`（default、primary、danger）和 `instruction`。
- 可选 `confirmation: { title, text }` 设置确认弹窗。
- 可选 `target: { botId, sessionId? }` 指定接手机器人及会话；省略时续接原会话。
- `bots.<AppID>: { enabled, profile }` 按机器人选择方案。`defaultProfile: null` 只允许显式列出的机器人；字符串则为未单独配置的机器人提供默认方案。

插件可见范围另外由 `botmux plugin enable incident-flow-actions --bot <机器人名或索引>` 控制。插件全局启用时不能靠 bot 局部禁用覆盖全局范围，需要使用上面的配置限制或调整全局启用范围。
