# botmux-plugin-incident-flow-actions

`@botmux-ai/plugin-incident-flow-actions` adds workflow actions to incident-result cards without changing Botmux core.

It provides three incident-specific actions: `确认结论`, `授权修复`, and `继续排查`. The callback service verifies the Botmux gateway token, an HMAC-bound card payload, the original message binding, and the verified operator. The first valid choice locks the card and injects a structured continuation into the original Botmux session through a one-shot scheduled turn.

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
