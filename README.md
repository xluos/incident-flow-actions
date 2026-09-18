# botmux-plugin-incident-flow-actions

`@botmux-ai/plugin-incident-flow-actions` adds workflow actions to incident-result cards without changing Botmux core.

The default preset provides `确认结论`, `授权修复`, and `继续排查`. Button order, labels, styles, confirmation dialogs, continuation instructions and target bots are configurable per bot. The callback service verifies the Botmux gateway token, an HMAC-bound card payload, the original message binding, and the verified operator. The first valid choice locks the card and injects a structured continuation directly into the original Botmux session through the local Trigger API.

## Contract

The repository root is the development and npm publishing envelope. `dist/` is
the only Botmux installation and runtime unit; the build bundles JavaScript
dependencies and copies static assets so it can run without the repository's
`node_modules/`.

| Path | Purpose | Build source |
| --- | --- | --- |
| `dist/skills/*/SKILL.md` | Skills delivered from the current Bot plugin set at CLI process start | copied from `skills/` |
| `dist/mcp/index.json` | One MCP connection aggregated by the Botmux Gateway | generated from `src/mcp/index.js` |
| `dist/cli/index.js` | Bundled handler map for top-level `botmux <command>` | bundled from `src/cli/index.js` |
| `dist/cli/commands.json` | Install-time command index | generated from the handler map |
| `dist/dashboard/index.js` | Bundled Dashboard React component entry | bundled from `src/dashboard/index.js` |
| `dist/service/index.js` | Bundled PM2 service definition | bundled from `src/service/index.js` |

Paths inside `dist/mcp/index.json` are relative to the installed `dist/` root.
Use `./...` for plugin-owned scripts. The MCP identity and PM2 service name are
derived from the plugin id `incident-flow-actions`.

## Develop

```bash
npm run build
npm test
botmux plugin install . --link
botmux plugin enable incident-flow-actions
botmux incident-flow-actions:send --help
```

The service is automatic. Start it immediately after installation with:

```bash
botmux plugin service start incident-flow-actions
botmux plugin service status
```

Plugin dependencies are explicit. If this plugin declares another plugin in
`package.json#botmux.dependencies.plugins`, that dependency must already be
enabled in the same machine or Bot scope before this plugin can be enabled.

## Authoring

- Edit handler code under `src/cli/`.
- Configure the single MCP connection under `src/mcp/`.
- Add plugin-owned skills under `skills/`.
- Export the Dashboard component from `src/dashboard/index.js`.
- Return the PM2 definition from `src/service/index.js`.
- Run `npm run build` after changing source contributions.
- Publish from the repository root with `npm publish`; `package.json#files`
  includes only `dist/`, while npm still supplies the root package metadata.

Botmux does not add namespaces to commands or skills. Authors own their names.
Runtime worker/daemon hooks are intentionally outside the current template and
remain a later extension.

## Configure action profiles

Start with `examples/workflow-config.json`, replace the example App IDs, and use:

```bash
botmux incident-flow-actions:config --file /absolute/path/workflow-config.json
botmux incident-flow-actions:config --file /absolute/path/workflow-config.json --apply
botmux incident-flow-actions:config --bot cli_YOUR_INCIDENT_APP
botmux plugin enable incident-flow-actions --bot "YOUR_BOT_NAME"
```

`defaultProfile: null` makes the configuration opt-in by App ID. A string selects
an inherited profile for bots without an override. Each bot has `enabled` and an
optional `profile`. Plugin enablement in Botmux is a separate gate; global
plugin enablement is additive, so prefer bot-scoped enablement for selected bots.
The configuration command does not expose or overwrite the signing secret.
For a bot-scoped install, Botmux exposes plugin commands only inside that bot's
managed sessions. From the host shell use the standalone configuration entry:

```bash
node ~/.botmux/plugins/incident-flow-actions/dist/cli/configure.js --file /absolute/path/workflow-config.json --apply
```

It uses the same validation and preserves unrelated config including the signing
key. Changes take effect for newly sent cards without restarting the plugin service.

Each profile has 1–5 ordered actions with `id`, `label`, `style` (`default`,
`primary`, `danger`), and `instruction`. Optional `confirmation: {title, text}`
controls the dialog. Optional `target: {botId, sessionId?}` dispatches to that bot's
existing session in the **same chat and scope/topic**. With no session ID, exactly
one matching session is required. Missing or ambiguous sessions fail visibly;
no unrelated session or new project is selected. Omit `target` to continue the
original session. Instructions are data, never shell commands. Cross-bot operator
open IDs retain their source app context and are audit data, not target credentials.

`send --profile <name>` selects a configured profile; `send --dry-run` generates
preview JSON without posting a message or persisting a signing key. Sending still
requires a managed session. The sending bot is that session's bot; target only
controls who receives the continuation after the click.

Cards store an action snapshot whose hash is included in the signed payload.
Editing a profile cannot silently change a previously sent button's behavior.
Legacy cards retain the original three actions. Existing HMAC verification,
message binding, allowed-operator checks and one-choice idempotency remain in
place. A successful click means the continuation was accepted, not that the
business task has completed.

### Dashboard 配置页面

在 Botmux 插件列表进入 Incident Flow Actions，可编辑按钮方案（1–5 个按钮）、顺序、文字、样式、二次确认、点击指令与接手机器人，并给不同机器人绑定方案。保存后新卡片立即使用新配置，旧卡片仍使用发送时的快照。插件的启用范围仍在插件列表按机器人设置。

此页面要求宿主向插件提供 `api.react`、`api.getSettings()`、`api.saveSettings(value)` 和 `api.listBots()`。服务端通过 `dist/server/settings.js` 适配器验证并读写 `workflowConfig`，不向浏览器返回插件签名密钥。旧版宿主会显示升级提示。
