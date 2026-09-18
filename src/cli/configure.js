// Host-side entrypoint for bot-scoped installs, whose commands are intentionally
// absent from Botmux's global CLI namespace.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configureActions } from './index.js';

const args = process.argv.slice(2);
const homeIndex = args.indexOf('--plugin-home');
const pluginHome = homeIndex < 0 ? join(homedir(), '.botmux', 'plugins', 'incident-flow-actions') : args[homeIndex + 1];
if (homeIndex >= 0) args.splice(homeIndex, 2);
if (!pluginHome) throw new Error('--plugin-home requires a path');
const path = join(pluginHome, 'config.json');
function readConfig() {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
try {
  const result = await configureActions({ args, api: { config: {
    get: key => readConfig()[key],
    set: (key, value) => {
      const current = readConfig();
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ ...current, [key]: value }, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, path);
    },
  } } });
  console.log(result);
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
}
