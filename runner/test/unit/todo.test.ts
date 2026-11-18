// A todo (docs/protocol.md, "Todos"): threads.create with run: false keeps
// a note Mike wrote for himself as a thread in his inbox, with no turn and
// no CLI, and the first message he sends it starts a fresh session told the
// note is his own to-do, not an instruction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, tick } from '../helpers/fakes.ts';

const note = 'read https://iang.org/papers/market_for_silver_bullets.html';

test('a todo is a seen, idle thread with just the note and no CLI', () => {
  const h = makeHarness();
  const { thread } = h.runner.createTodo({ text: `  ${note}\n` });
  assert.equal(h.adapter.sessions.length, 0, 'no turn runs');
  const evs = h.events(thread.id);
  assert.deepEqual(evs.map((e) => e.type), ['user.message']);
  assert.equal(evs[0].text, note);
  assert.equal(evs[0].turnId, undefined, 'outside any turn');
  const summary = h.runner.get(thread.id);
  assert.equal(summary.status, 'idle');
  assert.equal(summary.todo, true);
  assert.equal(summary.needsYou, false);
  assert.equal(summary.lastSeenSeq, summary.lastSeq, 'Mike wrote it, so it is read');
  assert.equal(summary.cwd, h.cfg.defaults.cwd);
  assert.match(summary.preview ?? '', /silver_bullets/);
  assert.equal(summary.asked, note);
});

test('a todo needs text and takes no pictures', () => {
  const h = makeHarness();
  assert.throws(() => h.runner.createTodo({ text: '   ' }), /text required/);
  assert.throws(() => h.runner.createTodo({ text: 'look at this', images: [{ path: '/tmp/x.png', mime: 'image/png' } as never] }), /pictures/);
});

test("the first message starts a fresh session told the note is the user's own todo", async () => {
  const h = makeHarness();
  const { thread } = h.runner.createTodo({ text: note });
  h.runner.send(thread.id, 'Summarise it in three bullets for me');
  await tick();
  const s = h.adapter.last;
  assert.equal(s.opts.resume, false);
  const sent = s.sent[0].text;
  assert.match(sent, /^\[Threadbear handoff\] This thread began on .* as a todo the user wrote for themself, not a message to you/);
  assert.match(sent, /User: read https:\/\/iang\.org/);
  assert.ok(sent.endsWith('Summarise it in three bullets for me'));
  assert.equal(h.runner.get(thread.id).todo, undefined, 'no longer a todo');
  assert.ok(!h.events(thread.id).some((e) => e.type === 'system.note' && /Started a new session/.test(e.text)));
  // The next message resumes that session with no handoff.
  s.init();
  s.text('m1:0', 'Done.');
  s.result('completed', 0.01);
  await tick();
  h.runner.send(thread.id, 'thanks');
  await tick();
  assert.equal(h.adapter.last.sent.at(-1)!.text, 'thanks');
});

test("one an agent filed is unread, and says who filed it", async () => {
  const h = makeHarness();
  const { thread } = h.runner.createTodo({ text: 'Reply to Alon about onboarding Will', startedBy: { kind: 'schedule', label: 'Morning scan' } });
  const filed = h.runner.get(thread.id);
  assert.ok((filed.lastSeenSeq ?? 0) < filed.lastSeq, 'unread');
  h.runner.send(thread.id, 'Draft the reply');
  await tick();
  assert.match(h.adapter.last.sent[0].text, /as a todo filed for the user by Morning scan, not a message to you/);
});

test('archiving a todo runs nothing', () => {
  const h = makeHarness();
  const { thread } = h.runner.createTodo({ text: note });
  h.runner.update({ threadId: thread.id, archived: true });
  assert.equal(h.adapter.sessions.length, 0);
  assert.ok(h.runner.get(thread.id).archivedAt);
});

test("create_thread's todo: true files one with nothing run, nested under no thread", async () => {
  const { buildThreadbearTools } = await import('../../src/threadbear-mcp.ts');
  const h = makeHarness();
  const parent = h.runner.create({ text: 'scan my Slack', cwd: h.cfg.defaults.cwd }).thread.id;
  const sessions = h.adapter.sessions.length;
  const t = buildThreadbearTools(h.runner, parent, () => Date.now()).find((x) => x.name === 'create_thread')!;
  const r = (await t.handler({ text: 'Reply to Alon about onboarding Will', folder: '.', todo: true } as never, {})) as { content: { text: string }[] };
  assert.match(r.content[0].text, /^Filed todo .* No agent runs on it until they send it something\.$/);
  assert.equal(h.adapter.sessions.length, sessions, 'no new CLI');
  const filed = h.runner.list().find((x) => x.todo)!;
  assert.equal(filed.startedBy?.kind, 'thread');
  assert.equal(filed.detached, true);
});

test('the note shows on another Mac and the phone, before the reply it later got', async () => {
  const { threeWays } = await import('../helpers/routes.ts');
  const { SCENARIOS } = await import('../helpers/scenario-list.ts');
  const s = SCENARIOS.find((x) => x.todo)!;
  const { views } = await threeWays(s.play, s.todo);
  for (const v of [views.here, views.relay, views.phone]) {
    assert.deepEqual(v.messages.map((m) => `${m.role}: ${m.text}`), [
      'user: read the market for silver bullets paper',
      'user: Summarise it for me.',
      'assistant: Three points from the paper.',
    ]);
  }
});
