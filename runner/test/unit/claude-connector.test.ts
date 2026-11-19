// Project boards read through a Claude login's claude.ai Notion connector
// when there's no gateway (models/claude-connector.ts, Models.connectorCall,
// notion-tasks.ts claudeConnectorCaller). The CLI's stream-json lines below
// are the 2.1.328 CLI's, cut down (18 Nov 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpDir } from '../helpers/fakes.ts';
import { FakeClock } from '../../src/clock.ts';
import { ensureHome } from '../../src/config.ts';
import { nullLogger } from '../../src/log.ts';
import { HAIKU, Models } from '../../src/models/index.ts';
import { ConnectorStream, connectorArgs, connectorPrompt, type ConnectorRequest, type ConnectorResponse } from '../../src/models/claude-connector.ts';
import { ledgerPath } from '../../src/models/ledger.ts';
import { CONNECTOR_POLL_MS, POLL_MS, TaskBoards, claudeConnectorCaller, type ConnectorModels } from '../../src/notion-tasks.ts';
import type { Account } from '../../src/protocol.ts';

const TOOL = 'mcp__claude_ai_Notion__notion-fetch';
const ARGS = { id: 'https://app.notion.com/p/41db', extra: { b: 1, a: 2 } };

const line = (o: unknown) => JSON.stringify(o) + '\n';
const assistant = (id: string, content: unknown[], usage = { input_tokens: 2, cache_read_input_tokens: 1000, output_tokens: 20 }) =>
  line({ type: 'assistant', message: { id, content, usage } });
const toolResult = (id: string, text: string, isError = false) =>
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], is_error: isError }] } });

test('connector stream: takes the asked-for call result as it is, and counts each message once', () => {
  const s = new ConnectorStream(TOOL, ARGS);
  s.push(line({ type: 'system', subtype: 'init' }));
  s.push(assistant('m1', [{ type: 'tool_use', id: 't0', name: 'ToolSearch', input: { query: `select:${TOOL}` } }]));
  s.push(toolResult('t0', ''));
  // Same message, two blocks, usage repeated: counted once.
  s.push(assistant('m2', [{ type: 'thinking' }]));
  const half = assistant('m2', [{ type: 'tool_use', id: 't1', name: TOOL, input: { extra: { a: 2, b: 1 }, id: ARGS.id } }]);
  s.push(half.slice(0, 20));
  assert.equal(s.outcome, undefined, 'a part line waits for the rest');
  s.push(half.slice(20));
  s.push(toolResult('t1', '{"title":"Tasks Tracker"}'));
  assert.deepEqual(s.outcome, { ok: true, text: '{"title":"Tasks Tracker"}', isError: false });
  assert.deepEqual(s.tokens(), { inputTokens: 2004, outputTokens: 40 });
});

test('connector stream: changed arguments, a second call or no call at all are failures, not results', () => {
  const changed = new ConnectorStream(TOOL, ARGS);
  changed.push(assistant('m1', [{ type: 'tool_use', id: 't1', name: TOOL, input: { id: 'https://elsewhere' } }]));
  changed.push(toolResult('t1', 'other page'));
  assert.deepEqual(changed.outcome, { ok: false, limit: false, message: 'the model changed the arguments' });

  const twice = new ConnectorStream(TOOL, ARGS);
  twice.push(assistant('m1', [{ type: 'tool_use', id: 't1', name: TOOL, input: ARGS }, { type: 'tool_use', id: 't2', name: TOOL, input: ARGS }]));
  assert.equal(twice.outcome?.ok, false);

  // Haiku writing the call out as text, as when the tool isn't there.
  const none = new ConnectorStream(TOOL, ARGS);
  none.push(assistant('m1', [{ type: 'text', text: `<invoke name="${TOOL}">` }]));
  none.push(line({ type: 'result', subtype: 'success', is_error: false, result: `<invoke name="${TOOL}">` }));
  assert.equal(none.outcome?.ok, false);
  assert.match((none.outcome as { message: string }).message, /isn't on this login's claude.ai connectors/);

  const limit = new ConnectorStream(TOOL, ARGS);
  limit.push(line({ type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 429, result: 'rate limited' }));
  assert.deepEqual(limit.outcome, { ok: false, limit: true, message: 'claude: rate limited' });
});

test('connector stream: a tool error is an answer, marked as one', () => {
  const s = new ConnectorStream(TOOL, ARGS);
  s.push(assistant('m1', [{ type: 'tool_use', id: 't1', name: TOOL, input: ARGS }]));
  s.push(toolResult('t1', 'MCP server "claude.ai Notion" needs you to sign in again', true));
  assert.deepEqual(s.outcome, { ok: true, text: 'MCP server "claude.ai Notion" needs you to sign in again', isError: true });
});

test('connector CLI: only ToolSearch and the one tool may run, nothing that reads, writes or reaches out', () => {
  const args = connectorArgs({ model: HAIKU, tool: TOOL });
  assert.equal(args[args.indexOf('--allowedTools') + 1], `ToolSearch,${TOOL}`);
  const denied = args[args.indexOf('--disallowedTools') + 1]!.split(',');
  for (const t of ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'Task', 'Agent']) assert.ok(denied.includes(t), t);
  // claude.ai's servers don't load under --strict-mcp-config.
  assert.ok(!args.includes('--strict-mcp-config'));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.ok(connectorPrompt(TOOL, ARGS).includes(JSON.stringify(ARGS)));
});

function acct(id: string): Account {
  return { id, provider: 'claude', title: id, configDir: `/tmp/no-such/${id}`, usage: { windows: [{ kind: 'five_hour', title: '5-hour', remainingPercent: 80 }], readAt: new Date().toISOString(), source: 'live' } };
}

function setup(replies: ConnectorResponse[]) {
  const home = tmpDir();
  ensureHome(home);
  const asked: ConnectorRequest[] = [];
  const models = new Models({
    home,
    clock: new FakeClock(),
    log: nullLogger,
    settings: () => ({ privateFolders: [], pool: 'claude' }),
    claudePath: '/fake/claude',
    poolHost: { pool: () => ({ pool: { id: 'claude', title: 'Claude', accountIds: ['claude-main'] }, accounts: [acct('claude-main')] }), ranDry: () => {} },
    askCli: async () => assert.fail('no model call'),
    askConnector: async (req) => {
      asked.push(req);
      return replies.shift() ?? { ok: false, timedOut: false, limit: false, message: 'no more' };
    },
  });
  const ledger = () => fs.readFileSync(ledgerPath(home), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { models, asked, ledger };
}

test('connectorCall: runs on a pool login, and the usage file counts it under its feature with no text', async () => {
  const s = setup([{ ok: true, text: '{"secret":"board text"}', inputTokens: 24000, outputTokens: 29 }]);
  const r = await s.models.connectorCall({ feature: 'notion-tasks', tool: TOOL, args: ARGS });
  assert.ok(r.ok);
  assert.deepEqual(r.value, { text: '{"secret":"board text"}', isError: false });
  assert.equal(s.asked[0]!.tool, TOOL);
  assert.equal(s.asked[0]!.account.id, 'claude-main');
  assert.equal(s.asked[0]!.model, HAIKU);
  const [l] = s.ledger();
  assert.equal(l.feature, 'notion-tasks');
  assert.equal(l.job, 'connector');
  assert.equal(l.inputTokens, 24000);
  assert.ok(!JSON.stringify(l).includes('secret'));
});

test("claudeConnectorCaller: the gateway's tool names become claude.ai's, and a Notion error throws its sign-in line", async () => {
  const seen: string[] = [];
  const answers = [
    { ok: true as const, value: { text: 'rows', isError: false } },
    { ok: true as const, value: { text: 'Something went wrong\nMCP server "claude.ai Notion" needs you to sign in again', isError: true } },
    { ok: false as const, message: 'No pool called claude has a Claude login.' },
  ];
  const models: ConnectorModels = {
    connectorCall: async (p) => {
      seen.push(p.tool);
      assert.equal(p.feature, 'notion-tasks');
      return answers.shift()!;
    },
  };
  const call = claudeConnectorCaller(models);
  assert.equal(await call('notion__notion-query-data-sources', {}), 'rows');
  await assert.rejects(call('notion__notion-fetch', {}), /needs you to sign in again/);
  await assert.rejects(call('notion__notion-fetch', {}), /claude.ai's connector: No pool/);
  assert.deepEqual(seen, ['mcp__claude_ai_Notion__notion-query-data-sources', 'mcp__claude_ai_Notion__notion-fetch', 'mcp__claude_ai_Notion__notion-fetch']);
});

test('task boards: read unasked every pollMs when given, else every 5 minutes', () => {
  const waits: number[] = [];
  for (const pollMs of [undefined, CONNECTOR_POLL_MS]) {
    const boards = new TaskBoards({ home: tmpDir(), log: nullLogger, ...(pollMs ? { pollMs } : {}), setTimeout: (_fn, ms) => (waits.push(ms), { cancel() {} }), onChange: () => {} });
    boards.start(() => []);
    boards.stop();
  }
  assert.deepEqual(waits, [POLL_MS, CONNECTOR_POLL_MS]);
});
