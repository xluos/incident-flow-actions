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

也可传 `--summary` 或 `--summary-file` 生成 schema 2.0 基础卡，正文、按钮和 @ 在同一张卡中发送。重复传 `--action <动作ID>` 可从当前方案选择本次适用的按钮；不传则保持方案原有按钮。不要显示不满足授权条件的动作。`--profile <方案名>` 选择已配置方案；`--dry-run` 只生成预览，不发送消息。命令必须在有已验证请求人的 Botmux 会话中运行，卡片以当前机器人的身份发送。

负责人身份文件的 `repair_owner` 驱动 Markdown 中 `{{repair_owner}}` 和实际 mention。也支持重复传 `--mention <id或邮箱:展示名>`。直接响应真人且需要提醒原请求人时可加 `--mention-back`；后台交接不要自动 @ 交接机器人。未解析的负责人不得伪造真实 @。`--no-mention` 会显式关闭包括负责人在内的通知，不能与 `--mention` 或 `--mention-back` 同用。

先对最终 `summary`/`summary-file`/卡片正文执行回复风格检查，再发送。发送失败先确认错误及是否已有消息 ID，只修正失败项后重试同一份结果；不另发“结果在下一张卡片”等重复通知。成功后回读卡片并保存消息 ID。

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

按机器人启用时，宿主 Shell 的 Botmux CLI 不会暴露插件命令。在宿主维护配置请使用 `node ~/.botmux/plugins/incident-flow-actions/dist/cli/configure.js --file <配置JSON> --apply`，会话内继续使用上述 `botmux incident-flow-actions:config`。此入口只更新 workflowConfig，保留签名密钥。
