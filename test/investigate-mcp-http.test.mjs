// HTTP MCP investigation against a local stand-in server: what Spotter does when a
// provider refuses its unauthenticated query, and which servers it must not query at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listToolsHttp, McpHttpError } from '../src/tool-db/investigate-mcp-http.mjs';
import { listMcpToolsAll } from '../src/tool-db/investigate-mcp.mjs';
import { buildInvestigationSnapshot } from '../src/tool-db/investigate-claude.mjs';
import { getClaudeAiBaselineByServer } from '../src/tool-db/claude-ai-baseline.mjs';

const JSON_TYPE = 'application/json; charset=UTF-8';
const REFUSALS = [401, 403];
const STEPS = ['initialize', 'notifications/initialized', 'tools/list'];

// `plan` maps a JSON-RPC method to what the stand-in does there: an HTTP status to
// refuse with, 'rpc-error' for an in-band JSON-RPC error, or 'reset' to drop the
// connection. Unlisted methods complete the handshake. The first path segment names
// the server, so one stand-in can play several.
async function startStandIn(plan = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const rpc = JSON.parse(raw);
      const key = req.url.split('/')[1];
      received.push({ key, method: rpc.method, headers: req.headers, clientInfo: rpc.params?.clientInfo });
      const action = plan[rpc.method];
      if (action === 'reset') {
        req.socket.destroy();
        return;
      }
      if (typeof action === 'number') {
        res.writeHead(action, { 'Content-Type': JSON_TYPE });
        res.end(JSON.stringify({ error: { code: action, status: 'REFUSED' } }));
        return;
      }
      if (action === 'rpc-error') {
        res.writeHead(200, { 'Content-Type': JSON_TYPE });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32001, message: 'refused' } }));
        return;
      }
      if (rpc.method === 'initialize') {
        res.writeHead(200, { 'Content-Type': JSON_TYPE });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'stand-in', version: '1' } },
        }));
        return;
      }
      if (rpc.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': JSON_TYPE });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        result: { tools: [{ name: 'live_tool', description: `live description from ${key}` }] },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    received,
    url: (key) => `http://127.0.0.1:${server.address().port}/${key}/mcp`,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}

test('listToolsHttp: completes the handshake and sends no credentials', async () => {
  const standIn = await startStandIn();
  try {
    const tools = await listToolsHttp({ url: standIn.url('ok'), serverName: 'ok' });
    assert.deepEqual(tools, [{ name: 'live_tool', description: 'live description from ok' }]);
    assert.deepEqual(standIn.received.map((r) => r.method), STEPS);
    assert.equal(standIn.received.some((r) => 'authorization' in r.headers), false);
    assert.equal(standIn.received[0].clientInfo.name, 'spotter');
  } finally {
    await standIn.close();
  }
});

for (const status of REFUSALS) {
  for (const [index, step] of STEPS.entries()) {
    test(`listToolsHttp: HTTP ${status} at ${step} rejects with McpHttpError and stops there`, async () => {
      const standIn = await startStandIn({ [step]: status });
      try {
        await assert.rejects(
          listToolsHttp({ url: standIn.url('refused'), serverName: 'refused' }),
          (err) => err instanceof McpHttpError && err.server === 'refused' && err.message.startsWith(`HTTP ${status}`),
        );
        assert.deepEqual(standIn.received.map((r) => r.method), STEPS.slice(0, index + 1));
      } finally {
        await standIn.close();
      }
    });
  }
}

test('listToolsHttp: in-band JSON-RPC error at initialize rejects with McpHttpError', async () => {
  const standIn = await startStandIn({ initialize: 'rpc-error' });
  try {
    await assert.rejects(
      listToolsHttp({ url: standIn.url('refused'), serverName: 'refused' }),
      (err) => err instanceof McpHttpError && /^initialize failed: /.test(err.message),
    );
    assert.deepEqual(standIn.received.map((r) => r.method), ['initialize']);
  } finally {
    await standIn.close();
  }
});

test('listToolsHttp: dropped connection rejects', async () => {
  const standIn = await startStandIn({ initialize: 'reset' });
  try {
    await assert.rejects(listToolsHttp({ url: standIn.url('dropped'), serverName: 'dropped' }));
  } finally {
    await standIn.close();
  }
});

for (const status of REFUSALS) {
  test(`listMcpToolsAll: a server refusing with HTTP ${status} is logged and skipped, the rest still resolve`, async () => {
    const refusing = await startStandIn({ initialize: status });
    const healthy = await startStandIn();
    const logs = [];
    try {
      const out = await listMcpToolsAll({
        logFn: (line) => logs.push(line),
        servers: [
          { name: 'refusing', transport: 'http', url: refusing.url('refusing') },
          { name: 'healthy', transport: 'http', url: healthy.url('healthy') },
        ],
      });
      assert.deepEqual([...out.keys()], ['healthy']);
      assert.deepEqual(out.get('healthy'), [{ name: 'live_tool', description: 'live description from healthy' }]);
      assert.equal(logs.length, 1);
      assert.match(logs[0], new RegExp(`^mcp investigate failed for "refusing": HTTP ${status}`));
    } finally {
      await refusing.close();
      await healthy.close();
    }
  });
}

test('listMcpToolsAll: skipServerNames are never contacted and never logged', async () => {
  const standIn = await startStandIn();
  const logs = [];
  try {
    const out = await listMcpToolsAll({
      logFn: (line) => logs.push(line),
      servers: [
        { name: 'skipped', transport: 'sse', url: standIn.url('skipped') },
        { name: 'asked', transport: 'http', url: standIn.url('asked') },
      ],
      skipServerNames: new Set(['skipped']),
    });
    assert.deepEqual([...out.keys()], ['asked']);
    assert.deepEqual([...new Set(standIn.received.map((r) => r.key))], ['asked']);
    assert.deepEqual(logs, []);
  } finally {
    await standIn.close();
  }
});

function baselineEntries() {
  const entries = [];
  for (const tools of getClaudeAiBaselineByServer().values()) entries.push(...Object.entries(tools));
  return entries;
}

// The claude.ai Gmail / Calendar / Drive servers come from `claude mcp list` as bare
// sse URLs. Their descriptions are the hardcoded baseline; Spotter must not send them
// an unauthenticated query, whether the provider would answer it or refuse it.
for (const plan of [{}, { initialize: 401 }, { initialize: 403 }]) {
  const label = plan.initialize ? `would refuse with HTTP ${plan.initialize}` : 'would answer';
  test(`buildInvestigationSnapshot: baseline claude.ai servers are not queried (provider ${label})`, async () => {
    const provider = await startStandIn(plan);
    const userServer = await startStandIn();
    const projectRoot = await mkdtemp(join(tmpdir(), 'spotter-snapshot-'));
    const logs = [];
    try {
      const baselineServers = [...getClaudeAiBaselineByServer().keys()];
      const snapshot = await buildInvestigationSnapshot({
        projectRoot,
        logFn: (line) => logs.push(line),
        listMcpServersFn: async () => [
          ...baselineServers.map((name) => ({ name, transport: 'sse', url: provider.url(encodeURIComponent(name)) })),
          { name: 'user-http', transport: 'http', url: userServer.url('user-http') },
        ],
      });
      assert.deepEqual(provider.received, []);
      for (const [name, description] of baselineEntries()) {
        assert.equal(snapshot.get(name), description);
      }
      assert.equal(snapshot.get('mcp__user-http__live_tool'), 'live description from user-http');
      assert.equal([...snapshot.keys()].filter((name) => name.startsWith('mcp__')).length, baselineEntries().length + 1);
      assert.equal(logs.some((line) => line.startsWith('mcp investigate failed')), false);
    } finally {
      await provider.close();
      await userServer.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
}

for (const status of REFUSALS) {
  test(`buildInvestigationSnapshot: a non-baseline server refusing with HTTP ${status} leaves the baseline intact`, async () => {
    const refusing = await startStandIn({ initialize: status });
    const projectRoot = await mkdtemp(join(tmpdir(), 'spotter-snapshot-'));
    const logs = [];
    try {
      const snapshot = await buildInvestigationSnapshot({
        projectRoot,
        logFn: (line) => logs.push(line),
        listMcpServersFn: async () => [
          { name: 'claude.ai Gmail', transport: 'sse', url: refusing.url('gmail') },
          { name: 'claude.ai Other Connector', transport: 'sse', url: refusing.url('other') },
        ],
      });
      const gmail = Object.entries(getClaudeAiBaselineByServer().get('claude.ai Gmail'));
      assert.deepEqual(
        [...snapshot.entries()].filter(([name]) => name.startsWith('mcp__')),
        gmail,
      );
      assert.deepEqual(refusing.received.map((r) => `${r.key}:${r.method}`), ['other:initialize']);
      assert.deepEqual(
        logs.filter((line) => line.startsWith('mcp investigate failed')),
        [`mcp investigate failed for "claude.ai Other Connector": HTTP ${status} ${http.STATUS_CODES[status]}`],
      );
    } finally {
      await refusing.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
}
