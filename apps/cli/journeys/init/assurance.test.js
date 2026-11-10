/** Assurance distinguishes recorded parent independence from procedural review [V1,B3]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { REVIEW_INDEPENDENCE_ENGINE } from '../../../../packages/state/light.js';
import { openBoard } from '../../../lib/index.js';
import { main } from '../../tests/fixtures/native.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import {
  applyEngineMove,
  prepareEngineMove,
} from '../../../../packages/state/index.js';

/** Real Git and SQLite, with one item per independently declared parent pair. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-verdict-assurance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true', lanes: { web: { owns: ['web/'] } } }));
  writeFileSync(join(root, 'SPEC.md'), '# Assurance fixture\n## G\n- G1 [approved, must] Reviews state their assurance. | gate: true\n');
  runFixtureGit(['add', 'pullboard.json', 'SPEC.md'], { cwd: root });
  runFixtureGit(['-c', 'user.name=Assurance fixture', '-c', 'user.email=assurance@example.invalid', 'commit', '-q', '-m', 'chore: initialize assurance fixture'], { cwd: root });
  mkdirSync(join(root, '.git', 'pullboard'), { recursive: true });
  const board = openBoard(join(root, '.git', 'pullboard', 'board.sqlite'), { now: () => new Date('2026-10-23T12:00:00.000Z') });
  t.after(() => store.closeBoard(board));
  const policy = { version: 1, commit: runFixtureGit(['rev-parse', 'HEAD'], { cwd: root }),
    verify: { policy: 'any', family: 'off' } };
  return { root, board, policy, sequence: 0 };
}

/** Build and accept once without inventing a gate execution for the board-state fixture. */
function accepted(box, builderParent, reviewerParent, { historicalUnknown = false, engine } = {}) {
  const number = store.listAgents(box.board).length;
  const builderPath = join(box.root, `builder-${number}`);
  const reviewerPath = join(box.root, `reviewer-${number}`);
  const builder = store.register(box.board, { lane: 'web', path: builderPath, parent: builderParent });
  const reviewer = store.register(box.board, { lane: 'web', path: reviewerPath, parent: reviewerParent });
  const id = store.addItem(box.board, { by: 'coordinator', lane: 'web', title: 'Assurance evidence', criterion: 'Review states its assurance', check: 'true' });
  const text = JSON.stringify({ rows: [], policy: box.policy });
  const digest = createHash('sha256').update(text).digest('hex');
  if (historicalUnknown) {
    const prior = store.register(box.board, { lane: 'web', path: join(box.root, `prior-${number}`) });
    store.claim(box.board, id, { agentId: prior, lane: 'web', leaseMs: 3600000,
      freeze: () => ({ text, digest }) });
    store.release(box.board, id, prior, 'Return the prior fixture claim before the verdict check.', 'OTHER');
  }
  store.claim(box.board, id, { agentId: builder, lane: 'web', leaseMs: 3600000,
    freeze: () => ({ text, digest }) });
  const commit = String(id).padStart(40, 'a');
  submitFixture(box.board, id, { agentId: builder, commit, tree: String(id).padStart(40, 'b') });
  const verdict = { agentId: reviewer, decision: 'ACCEPT', policy: 'any', head: commit, digest,
    note: 'Changed the private fixture edge; its assertion failed, then passed when restored.' };
  if (engine !== undefined) {
    const move = { ...prepareEngineMove(box.board, 'verify', [id, verdict]), engine };
    const outcome = applyEngineMove(box.board, move, { sequence: ++box.sequence, at: '2026-10-23T12:00:00.000Z' });
    assert.equal(outcome.error, undefined, 'the historical verdict replays through the ordinary engine');
  } else store.verify(box.board, id, verdict);
  return { id, builderPath, reviewerPath };
}

test('[V1,B3] verdicts record independent assurance only for recorded different parents and show prints the tier', async (t) => {
  const box = fixture(t);
  const independent = accepted(box, 'parent-P', 'parent-Q', { engine: 90 });
  assert.equal(store.verdictsFor(box.board, independent.id)[0].assurance, 'independent');
  for (const parents of [[undefined, 'parent-Q'], ['parent-P', undefined], [undefined, undefined]]) {
    const procedural = accepted(box, ...parents);
    assert.equal(store.verdictsFor(box.board, procedural.id)[0].assurance, 'procedural');
    if (parents.every(parent => parent === undefined)) {
      store.register(box.board, { lane: 'web', path: procedural.builderPath, parent: 'parent-P' });
      store.register(box.board, { lane: 'web', path: procedural.reviewerPath, parent: 'parent-Q' });
      assert.equal(store.verdictsFor(box.board, procedural.id)[0].assurance, 'procedural', 'later parent enrollment cannot upgrade an old verdict');
    }
  }
  // Authors are the committed authors from the two-tier review engine on; an earlier claimant counts only before it.
  const historical = accepted(box, 'parent-P', 'parent-Q', { historicalUnknown: true, engine: REVIEW_INDEPENDENCE_ENGINE - 1 });
  assert.equal(store.verdictsFor(box.board, historical.id)[0].assurance, 'procedural', 'an earlier unknown author still limits assurance');
  const legacy = accepted(box, 'parent-P', 'parent-Q', { engine: 80 });
  assert.equal(store.verdictsFor(box.board, legacy.id)[0].assurance, 'procedural', 'old verdicts never invent parent assurance');
  const restored = openBoard(join(box.root, 'restored.sqlite'));
  try {
    importBoard(restored, exportBoard(box.board));
    assert.equal(store.verdictsFor(restored, independent.id)[0].assurance, 'independent');
    assert.equal(store.verdictsFor(restored, historical.id)[0].assurance, 'procedural');
  } finally { store.closeBoard(restored); }
  let stdout = '';
  let stderr = '';
  const code = await main(['show', String(independent.id)], { cwd: box.root,
    stdout: { isTTY: false, write: part => { stdout += part; } },
    stderr: { write: part => { stderr += part; } } });
  assert.equal(code, 0, stderr);
  assert.match(stdout, /assurance: independent/u);
});

test('[V1,B3] at the current engine an earlier claimant who committed nothing does not limit assurance, and a committed author does', async (t) => {
  const box = fixture(t);
  const claimedOnly = accepted(box, 'parent-P', 'parent-Q', { historicalUnknown: true });
  assert.equal(store.verdictsFor(box.board, claimedOnly.id)[0].assurance, 'independent',
    'an earlier unknown claimant that submitted no commit is not an author');
  const committedUnknown = accepted(box, undefined, 'parent-Q');
  assert.equal(store.verdictsFor(box.board, committedUnknown.id)[0].assurance, 'procedural',
    'the committed author with no recorded parent still limits assurance');
});
