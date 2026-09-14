import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeRoot = join(repoRoot, 'dist');

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function assertNoSymlinks(path) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) fail(`plugin dist must not contain symlinks: ${path}`);
  if (!stat.isDirectory()) return;
  for (const name of readdirSync(path)) assertNoSymlinks(join(path, name));
}

const pkg = readJson(join(repoRoot, 'package.json'));
if (!pkg.keywords?.includes('botmux-plugin')) fail('package.json must include keywords: ["botmux-plugin"]');
if (!/^[a-z][a-z0-9._-]{0,63}$/.test(pkg.botmux?.id ?? '')) fail('package.json#botmux.id is invalid');
if (!Array.isArray(pkg.files) || pkg.files.length !== 1 || pkg.files[0] !== 'dist/') {
  fail('package.json#files must publish only dist/');
}
if (!existsSync(runtimeRoot)) fail('dist/ is missing; run npm run build');
if (pkg.botmux?.service && !existsSync(join(runtimeRoot, 'service', 'index.js'))) {
  fail('botmux.service is set, but dist/service/index.js does not exist');
}
assertNoSymlinks(runtimeRoot);

const mcp = readJson(join(runtimeRoot, 'mcp', 'index.json'));
if (mcp.name !== undefined) fail('dist/mcp/index.json must not declare a name; the plugin id is the MCP identity');
if (mcp.transport === 'streamable-http') {
  let url;
  try { url = new URL(mcp.url); } catch { fail('streamable-http MCP config requires a valid url'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('streamable-http MCP url must use http or https');
} else if (mcp.transport !== 'stdio') {
  fail(`unsupported MCP transport: ${mcp.transport}`);
}

const cleanRoot = mkdtempSync(join(tmpdir(), 'botmux-plugin-dist-'));
try {
  cpSync(runtimeRoot, cleanRoot, { recursive: true });
  const cleanCli = join(cleanRoot, 'cli', 'index.js');
  const cleanCommands = readJson(join(cleanRoot, 'cli', 'commands.json')).commands ?? [];
  const mod = await import(pathToFileURL(cleanCli).href + `?t=${Date.now()}`);
  const handlers = mod.default ?? mod;
  for (const command of cleanCommands) {
    const handler = handlers?.[command.name];
    if (typeof handler !== 'function' && typeof handler?.run !== 'function') {
      fail(`dist/cli/commands.json declares ${command.name}, but dist/cli/index.js has no handler`);
    }
  }

  await import(pathToFileURL(join(cleanRoot, 'service', 'index.js')).href + `?t=${Date.now()}`);

  if (mcp.transport === 'stdio') {
    if (mcp.command?.[0] !== 'node' || mcp.command?.[1] !== './mcp/server.js') {
      fail('template stdio MCP must use the dist-relative ./mcp/server.js entry');
    }
    const initialize = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'template-test', version: '1' } },
    }) + '\n';
    const probe = spawnSync(process.execPath, [join(cleanRoot, 'mcp', 'server.js')], {
      cwd: cleanRoot,
      input: initialize,
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (probe.status !== 0) fail(`template MCP initialize probe failed: ${probe.stderr}`);
    const response = JSON.parse((probe.stdout ?? '').trim());
    if (response.id !== 1 || response.result?.serverInfo?.name !== pkg.botmux.id) {
      fail('template MCP server did not return a valid initialize response');
    }
  }
} finally {
  rmSync(cleanRoot, { recursive: true, force: true });
}

console.log('generated botmux plugin validation passed');
