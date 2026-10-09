/** Event-derived proof numbers have the same data in text and versioned JSON [R1,R2,A1]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { main } from '../src/cli.js';
import { proofStats } from '../src/stats.js';
import { serveApi } from '../src/api.js';
import { fetchFresh } from './http-fixture.js';

/** Capture the real CLI without spawning a second model or changing the machine's registry. */
async function run(root, args) {
  let stdout = '';
  let stderr = '';
  const code = await main(args, { cwd: root,
    stdout: { isTTY: false, write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } } });
  return { code, stdout, stderr, data: args.includes('--json') ? JSON.parse(stdout) : null };
}

/** Create an isolated Git board with one rejected submission and accepted rework. */
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-stats-cli-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'pipe' });
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ lanes: { web: { owns: ['web/'] } } }));
  writeFileSync(join(root, 'PRACTICE.md'), '');
  const clock = { now: () => new Date('2026-10-08T12:00:00.000Z') };
  const board = store.openBoard(join(root, '.git', 'pullboard', 'board.sqlite'), clock);
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: root });
  const builder = store.register(board, { lane: 'web', path: join(root, 'web') });
  const reviewer = store.register(board, { lane: 'review', path: join(root, 'review') });
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Proof fixture' });
  const freeze = () => ({ text: 'Proof fixture', digest: 'frozen' });
  const submit = (commit) => {
    store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 3_600_000, freeze });
    store.submit(board, id, { agentId: builder, commit, tree: 'b'.repeat(40) });
  };
  submit('a'.repeat(40));
  store.verify(board, id, { agentId: reviewer, decision: 'REJECT', reason: 'TEST_FAILURE', note: 'Fixture rejects the first attempt.', head: 'a'.repeat(40), digest: 'frozen', policy: 'any' });
  submit('c'.repeat(40));
  store.verify(board, id, { agentId: reviewer, decision: 'ACCEPT', note: 'Fixture rework meets its bar.', head: 'c'.repeat(40), digest: 'frozen', policy: 'any' });
  store.merged(board, id, { agentId: 'coordinator', commit: 'd'.repeat(40) });
  return { root, board };
}

test('[R1,R2,A1] stats JSON is versioned, text states the same proof numbers and neither records a move', async (t) => {
  const { root, board } = fixture(t);
  const before = store.events(board);
  const expected = proofStats(board);
  const json = await run(root, ['stats', '--json']);
  assert.equal(json.code, 0, json.stderr);
  assert.equal(json.stderr, '');
  assert.deepEqual(json.data, { version: 1, stats: expected });
  assert.deepEqual([expected.submissions, expected.rejections, expected.rejectionShare, expected.merged, expected.mergedWithoutAccept], [2, 1, 0.5, 1, 0]);
  const text = await run(root, ['stats']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /2 submissions · 1 rejections · 50\.0% sent back/u);
  assert.match(text.stdout, /1 items merged · 0 merged without an accept/u);
  assert.match(text.stdout, /3 agents · 1 family buckets: unknown \(3 agents,/u);
  assert.match(text.stdout, /agents: coordinator \(unknown; \d+ moves\), review-1 \(unknown; \d+ moves\), web-1 \(unknown; \d+ moves\)/u);
  assert.ok(text.stdout.includes(expected.firstEventAt));
  assert.ok(text.stdout.includes(expected.lastEventAt));
  assert.deepEqual(store.events(board), before, 'reading statistics appends no move');
});

test('[R2,A1] stats forwards the inclusive date window and returns an actionable invalid-date refusal', async (t) => {
  const { root, board } = fixture(t);
  const json = await run(root, ['stats', '--since', '2026-10-09', '--json']);
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(json.data.stats, proofStats(board, { since: '2026-10-09' }));
  assert.equal(json.data.stats.submissions, 0);
  assert.equal(json.data.stats.firstEventAt, null);
  const bad = await run(root, ['stats', '--since', '2026-02-30', '--json']);
  assert.equal(bad.code, 1);
  assert.equal(bad.data.version, 1);
  assert.equal(bad.data.error.code, 'BAD_SINCE');
  assert.match(bad.data.error.next, /--since 2026-10-08/u);
  const help = await run(root, ['stats', '--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--since <date>/u);
});

/** Exercise authenticated state from the same private board used by the command checks. */
test('[R1,R2,A2] local HTTP state exposes exactly the command statistics', async (t) => {
  const { root, board } = fixture(t);
  const api = await serveApi({ runCommand: main, projects: () => [{ root, name: 'Statistics fixture' }] });
  t.after(() => api.close());
  const url = new URL(api.url);
  const headers = { 'x-pullboard-key': url.searchParams.get('k') };
  const response = await fetchFresh(`${url.origin}/api/v1/boards/${store.boardId(board)}/state`, { headers });
  assert.equal(response.status, 200);
  const document = await response.json();
  const command = await run(root, ['stats', '--json']);
  assert.equal(command.code, 0, command.stderr);
  assert.equal(document.version, 1);
  assert.deepEqual(document.state.proofStats, command.data.stats);
});
