/** A landing amend uses its verified item through the installed hook; an ordinary worktree cannot [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import { landingBatchItemsAtRoot } from '../../../../packages/landing/index.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures(e2e);

/** Add a placeholder engine so the landing must amend its verified merge commit. */
function unlandedEngine(name) {
  return `import { unassignedEngine } from './engine-next.js';\nexport const ${name.toUpperCase()}_ENGINE = unassignedEngine();\n`;
}

test('an automatic landing amends through the real hook while an ordinary worktree stays refused [C7]', { timeout: 240_000 }, () => { // budget: real Git, native submit/review and a complete hooked landing batch.
  // This case opens its own item worktree; an unused default seat would add an unrelated join-output contract.
  const box = landProject({ withWorktree: false });
  box.env.PULLBOARD_MODEL = 'Landing hook fixture';
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.lanes.web.owns = [...new Set([...config.lanes.web.owns, 'src/', 'docs/', 'packages/state/src/logic/engines/'])];
  config.landing = { ...config.landing, parallel: false, publish: 'separate' };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  for (const name of ['src', 'docs', 'web']) mkdirSync(join(box.repo, name), { recursive: true });
  mkdirSync(join(box.repo, 'packages/state/src/logic/engines'), { recursive: true });
  writeFileSync(join(box.repo, 'packages/state/src/logic/engines/base-engine.js'), '/** The landed base engine. */\nexport const BASE_ENGINE = 80;\n');
  writeFileSync(join(box.repo, 'docs/formats.md'), '| Format | Version |\n| --- | --- |\n| `move engine` | `80` | fixture |\n');
  box.git(box.repo, 'add', '-A');
  const configured = box.tryGit(box.repo, 'commit', '-q', '-m', 'chore: configure hook fixture');
  assert.equal(configured.status, 0, configured.stderr);
  box.git(box.repo, 'push', '-q', 'origin', 'main');

  const entry = itemWorktree(box, 1, 'web/land-1.test.js');
  mkdirSync(join(entry.path, 'packages/state/src/logic/engines'), { recursive: true });
  writeFileSync(join(entry.path, 'packages/state/src/logic/engines/alpha-engine.js'), unlandedEngine('alpha'));
  submitItem(box, entry);
  acceptItem(box, entry);

  const before = box.git(entry.path, 'rev-parse', 'HEAD').trim();
  const unauthorized = box.tryGit(entry.path, 'commit', '--allow-empty', '--amend', '-m',
    `feat(merge): claim the verified item\n\nPullboard-Item: #${entry.item}`);
  assert.notEqual(unauthorized.status, 0, "the verified item's trailer is not authority in its ordinary worktree");
  assert.match(unauthorized.stderr, /verified item in the landing checkout/u);
  assert.equal(box.git(entry.path, 'rev-parse', 'HEAD').trim(), before, 'the refusal leaves the verified commit intact');

  const result = box.run(box.repo, 'land', '--json');
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  const landed = JSON.parse(result.out);
  assert.deepEqual(landed.landed, [entry.item], landed.batch?.refusal?.message ?? JSON.stringify(landed));
  const shown = box.run(box.repo, 'show', String(entry.item), '--json');
  assert.equal(shown.code, 0, shown.err);
  const item = JSON.parse(shown.out);
  assert.equal(box.git(box.repo, 'rev-list', '--parents', '-n', '1', item.item_merged_commit).split(' ').length, 3,
    'the automatic engine amendment remains inside the landed merge');
  assert.match(box.git(box.repo, 'show', `${item.item_merged_commit}:packages/state/src/logic/engines/alpha-engine.js`), /ALPHA_ENGINE = 81;/u,
    "the installed commit-msg hook allowed the landing's verified item trailer");
  assert.match(box.git(box.repo, 'show', `${item.item_merged_commit}:docs/formats.md`), /`move engine` \| `81`/u);
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), item.item_merged_commit, 'the amended merge reaches actual main');
  assert.ok(readFileSync(join(box.repo, '.githooks/commit-msg'), 'utf8').includes('hook commit-msg'), 'the real hook remains installed');
});

test('landing hook authority binds verified sources to the exact active batch or candidate [C7]', () => {
  const item = { item_id: 7, item_status: 'verified', item_commit: 'a'.repeat(40), item_merged_commit: 'b'.repeat(40) };
  const other = { ...item, item_id: 8, item_merged_commit: null };
  const entry = { id: 7, commit: item.item_commit };
  const batch = { state: 'merging', root: '/private/batch', base: 'c'.repeat(40), branch: 'refs/heads/main', candidates: [entry], items: [] };
  const selected = (value, root = batch.root, rows = [item, other]) => landingBatchItemsAtRoot([value], root, rows, row => row.item_effective_head ?? row.item_commit);
  assert.deepEqual(selected(batch), [item], 'a recorded merge cannot hide its still-owned verified source');
  assert.deepEqual(selected(batch, '/private/ordinary'), []);
  assert.deepEqual(selected({ ...batch, state: 'landed' }), []);
  assert.deepEqual(selected({ ...batch, state: 'blocked' }), []);
  assert.deepEqual(selected({ ...batch, state: 'gating' }), [], 'finished merge selection cannot borrow an excluded original candidate');
  assert.deepEqual(selected({ ...batch, state: 'gating', items: [entry] }), [item]);
  assert.deepEqual(selected(batch, batch.root, [{ ...item, item_status: 'claimed' }]), []);
  assert.deepEqual(selected(batch, batch.root, [{ ...item, item_commit: 'd'.repeat(40) }]), []);
  assert.deepEqual(selected(batch, batch.root, [{ ...item, item_effective_head: 'f'.repeat(40) }]), [], 'a new reviewed head cannot borrow the old batch authority');
  const reviewed = { ...entry, reviewedCommit: 'f'.repeat(40) };
  assert.deepEqual(selected({ ...batch, candidates: [reviewed] }, batch.root, [{ ...item, item_effective_head: reviewed.reviewedCommit }]), [{ ...item, item_effective_head: reviewed.reviewedCommit }]);
  const snapshot = { root: '/private/candidate', state: 'merging', base: batch.base, branch: batch.branch, candidates: [entry], items: [] };
  const parallel = { ...batch, candidates: [entry, { id: 8, commit: other.item_commit }], parallelCandidates: [{ snapshot }] };
  assert.deepEqual(selected(parallel, snapshot.root), [item], 'a candidate cannot borrow a sibling item');
  assert.deepEqual(selected({ ...parallel, base: 'e'.repeat(40) }, snapshot.root), []);
  assert.deepEqual(selected({ ...parallel, parallelCandidates: [{ snapshot: { ...snapshot, state: 'blocked' } }] }, snapshot.root), []);
  assert.deepEqual(selected({ ...batch, candidates: undefined, items: [entry] }), [item], 'ordinary recorded item lists remain supported');
});
