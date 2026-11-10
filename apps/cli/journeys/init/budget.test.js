/** claim, join and patch attach finish in under five seconds on a board at the measured production scale [C7,V4,H16]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  after,
  test,
} from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);
const BUDGET_MS = 5000; // budget: #2077, seats measured claim 58 s, join 22 s, patch 117 s on the real board

/** Seed the real tables at roughly the production population, so scans and per-seat reads show up. */
function seed(file) {
  const db = new DatabaseSync(file);
  const at = '2026-10-23T00:00:00.000Z';
  db.exec('BEGIN');
  const agent = db.prepare('INSERT INTO agent (agent_id, agent_lane, agent_path, agent_created_at) VALUES (?, ?, ?, ?)');
  for (let n = 1; n <= 800; n++) agent.run(`api-${n}`, 'api', `/seats/${n}`, at);
  const item = db.prepare(`INSERT INTO item (item_lane, item_title, item_criterion, item_status,
    item_created_by, item_created_at, item_updated_at) VALUES ('api', ?, 'The work is done.', 'open', 'coordinator', ?, ?)`);
  for (let n = 1; n <= 1000; n++) item.run(`Item ${n}`, at, at);
  const event = db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)');
  for (let n = 0; n < 45000; n++) event.run(at, `api-${1 + n % 800}`, n % 40 === 0 ? 'join' : n % 2 ? 'claim' : 'edit', 1 + n % 1000, '{}');
  const meta = db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)');
  for (let n = 0; n < 150000; n++) meta.run(`local:note-${n}`, `value ${n}`);
  const shout = db.prepare('INSERT INTO shout (shout_from, shout_to, shout_text, shout_at) VALUES (?, ?, ?, ?)');
  for (let n = 0; n < 23000; n++) shout.run(`api-${1 + n % 800}`, 'all', `Board activity ${n}`, at);
  db.exec('COMMIT');
  db.close();
}

/** Run one real CLI process, returning its wall time in ms; the command must succeed. */
function timed(box, cwd, ...args) {
  const started = performance.now();
  const result = box.run(cwd, ...args);
  const ms = performance.now() - started;
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}${result.out}`);
  return { ms, out: result.out };
}

/** The middle of an odd-sized sample. */
const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1];

test('claim, join and patch attach each finish under five seconds at production board scale [C7,V4,H16]', t => {
  const box = helpers.project('true');
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  seed(file);
  const joins = [];
  const claims = [];
  const patches = [];
  // @pullboard-board-file journey: submit fixture rows into the durable board the real CLI commands changed
  const board = openBoard(file);
  t.after(() => store.closeBoard(board));
  for (let round = 0; round < 3; round++) {
    const dir = join(box.dir, `web-r${round}`);
    box.git(box.repo, 'worktree', 'add', '-q', dir, '-b', `web/round-${round}`);
    joins.push(timed(box, dir, 'join', 'web', '--route', 'strong').ms);
    const item = JSON.parse(fixtureAdd(box.run, box.repo, 'web', `Timed work ${round}`, '--specs', 'G1', '--json').out).item.item_id;
    claims.push(timed(box, dir, 'claim', String(item)).ms);
    const author = JSON.parse(box.run(dir, 'whoami', '--json').out).id;
    const source = box.git(dir, 'rev-parse', 'HEAD');
    submitFixture(board, item, { agentId: author, commit: source, tree: box.git(dir, 'rev-parse', `${source}^{tree}`) });
    const patchFile = join(box.dir, `round-${round}.patch`);
    writeFileSync(patchFile, ['diff --git a/web/p.js b/web/p.js', 'new file mode 100644', 'index 0000000..e69de29',
      '--- /dev/null', '+++ b/web/p.js', '@@ -0,0 +1 @@', '+export const patched = true;', ''].join('\n'));
    patches.push(timed(box, box.repo, 'patch', 'attach', String(item), patchFile, '--key', 'timed', '--author', author, '--source', source, '--json').ms);
  }
  t.diagnostic(JSON.stringify({ joinMs: joins, claimMs: claims, patchMs: patches }));
  for (const [name, values] of Object.entries({ join: joins, claim: claims, patch: patches })) {
    assert.ok(median(values) < BUDGET_MS, `${name} median ${median(values).toFixed(0)} ms exceeds ${BUDGET_MS} ms`);
  }
});
