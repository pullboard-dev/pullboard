/** The roadmap and milestone commands print what the board holds: landed counts, target, limit, foreign references and kept pins [N26,N22]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { claim } from '../../../../packages/store/index.js';
import { merged } from '../../../../packages/store/index.js';
import { register } from '../../../../packages/store/index.js';
import { reserveReview } from '../../../../packages/store/index.js';
import { verify } from '../../../../packages/store/index.js';
import { closeCellBoard } from '../../../../packages/store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../../packages/store/tests/fixtures/cell.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import {
  BIN,
  machine,
  project,
} from '../../tests/fixtures/cockpit/machine.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';

test('the roadmap and milestone commands print landed counts, target, limit, foreign references and kept pins [N26,N22]', t => {
  const box = machine(), alpha = project(box, 'milestone-text');
  for (const title of ['Landed work', 'Accepted work', 'Open work', 'Limit one', 'Limit two', 'Rank one', 'Rank two', 'Rank three']) {
    fileFixtureItem(box, alpha.repo, { lane: 'web', title, check: 'test -f pullboard.json', args: ['--specs', 'G1'], wait: true,
      run: (root, ...args) => ({ code: 0, out: box.run(root, ...args), err: '' }) });
  }
  const board = openCellBoard(join(alpha.repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => closeCellBoard(board));
  const reviewer = register(board, { lane: 'tests', path: join(box.dir, 'milestone-reviewer'), parentDigest: 'b'.repeat(64) });
  const head = box.git(alpha.repo, 'rev-parse', 'HEAD'), tree = box.git(alpha.repo, 'rev-parse', 'HEAD^{tree}');
  const frozen = { text: '{"rows":[]}', digest: 'milestone-text-synthetic-acceptance' };
  /** Take an item to accepted, and to landed on main's commit when asked. */
  const accept = (id, land) => {
    claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 3_600_000, head, freeze: () => frozen });
    submitFixture(board, id, { agentId: 'web-1', commit: head, tree });
    reserveReview(board, id, { agentId: reviewer, leaseMs: 3_600_000, policy: 'any' });
    verify(board, id, { agentId: reviewer, decision: 'ACCEPT', head, digest: frozen.digest, policy: 'any', familyPolicy: 'off',
      note: 'Synthetic fixture, not review assurance.', review: { commit: head, head, trunk: head, paths: [] } });
    if (land) merged(board, id, { agentId: 'coordinator', commit: head });
  };
  accept(1, true);
  accept(2, false);
  const run = (...args) => {
    const extra = args[0] === 'milestone' && (args[1] === 'order' || args[1] === 'add' && args.includes('--items')) ? ['--reason', 'fixture release setup'] : [];
    const result = runFixtureChild(process.execPath, [BIN, ...args, ...extra], { cwd: alpha.repo, env: box.env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    return result.stdout;
  };

  run('milestone', 'add', 'A', '--items', '1,2,3');
  run('milestone', 'edit', 'A', '--target', '2026-01-02T03:04Z');
  const roadmap = run('roadmap');
  assert.match(roadmap, /^A: 1\/3 landed · target 2026-01-02T03:04:00\.000Z, past target$/m, 'the text shows N/M landed, the target and past target');
  assert.match(roadmap, /^ {2}#\d+ Landed work — landed$/m);
  assert.match(roadmap, /^ {2}#\d+ Accepted work — accepted$/m);
  assert.match(roadmap, /^ {2}1\. #\d+ Open work — open$/m);

  run('milestone', 'add', 'release', '--items', '4,5');
  run('milestone', 'edit', 'release', '--limit', '2');
  assert.match(run('roadmap'), /release: .*2\/2 items/, 'a limited milestone shows its count against the limit');

  run('milestone', 'add', 'Text release', '--items', 'other-repo#31,third-repo#33');
  assert.match(run('milestone', 'ship', 'Text release'), /not moved across boards: other-repo#31, third-repo#33/,
    'human output names every foreign reference that stayed in place');

  run('milestone', 'add', 'ranked', '--items', '6,7,8');
  run('milestone', 'pin', 'ranked', '8', '--reason', 'First real priority');
  assert.ok(run('milestone', 'order', 'ranked', '6,7').includes('pins keep their place ahead of this order: #8'));
});
