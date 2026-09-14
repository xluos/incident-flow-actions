import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

input.on('line', (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (request.id === undefined) return;
  if (request.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'incident-flow-actions', version: '0.1.0' },
      },
    });
    return;
  }
  if (request.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: request.id, result: { tools: [] } });
    return;
  }
  if (request.method === 'ping') {
    send({ jsonrpc: '2.0', id: request.id, result: {} });
    return;
  }
  send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
});
