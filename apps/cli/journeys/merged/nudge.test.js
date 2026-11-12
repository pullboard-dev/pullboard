/** Every move of main nudges the main audit within one sentinel sweep, whatever moved it [C7]. */
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { board as store } from '../../../lib/index.js';
import { closeBoard } from '../../../lib/index.js';
import { openBoard } from '../../../lib/index.js';
import { activateMainAudits } from '../../../../packages/gate/index.js';
import { saveMainAudit } from '../../../../packages/gate/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { captureCommandInProcess } from '../../tests/fixtures/process.js';
import { main } from '../../tests/fixtures/native.js';

/**
 * A real project with an activated main audit whose last green tip is main's tip, and a sweep
 * that records each audit nudge instead of starting a detached full-suite worker.
 */
async function fixture(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const isolated = helpers.sandbox();
  isolated.env.PULLBOARD_MODEL = 'Main audit fixture model';
  const box = helpers.project('true', isolated);
  const nudges = [];
  /** Record the nudge the CLI would launch; the real worker would run the whole suite. */
  const nudgeMainAudit = async (root, workerUrl) => { nudges.push({ root, worker: fileURLToPath(workerUrl) }); return null; };
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const db = openBoard(join(box.repo, '.git/pullboard/board.sqlite'), undefined, { isMain: true, gitRoot: box.repo });
  let identity;
  try { identity = { id: store.boardId(db), after: store.events(db).at(-1).event_id }; }
  finally { closeBoard(db); }
  await activateMainAudits(box.repo, identity.after, identity.id);
  const directory = join(box.repo, '.git/pullboard/main-audits');
  /** Mark main's current tip as the last green audited tip. */
  const audited = () => saveMainAudit(join(directory, 'last-green.json'), { version: 1, complete: true, green: true,
    receiptId: 'fixture-receipt', tip: box.git(box.repo, 'rev-parse', 'HEAD'), tree: box.git(box.repo, 'rev-parse', 'HEAD^{tree}') });
  audited();
  /** Run one real sentinel sweep from the main checkout with the injected nudge. */
  const sweep = async () => {
    const result = await captureCommandInProcess((args, streams) => main(args, { ...streams, nudgeMainAudit }),
      ['sentinel', 'run', '--health-only'], { cwd: box.repo, env: box.env });
    assert.equal(result.code, 0, result.err + result.out);
  };
  return { box, nudges, sweep, audited };
}

test('a plain commit on main nudges the main audit within one sentinel sweep [C7]', async t => {
  const { box, nudges, sweep, audited } = await fixture(t);
  await sweep();
  assert.deepEqual(nudges, [], 'main at its last audited tip needs no audit');
  box.git(box.repo, 'commit', '-q', '--allow-empty', '-m', 'chore: coordinator hotfix with no pullboard command');
  await sweep();
  assert.equal(nudges.length, 1, 'one sweep after main moved nudges the audit once');
  assert.equal(realpathSync(nudges[0].root), realpathSync(box.repo), 'the nudge targets the main checkout');
  assert.equal(nudges[0].worker, fileURLToPath(new URL('../../src/io/landing/audit.js', import.meta.url)), 'the nudge starts the real audit worker');
  audited();
  await sweep();
  assert.equal(nudges.length, 1, 'once the new tip is audited the sweep stops nudging');
});
