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

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { landProject, itemWorktreeLocal, commitItemLocal, submitItemLocal, acceptItemLocal } = makeLandProjectFixtures(e2e);

/** Add a placeholder engine so the landing must amend its verified merge commit. */
function unlandedEngine(name) {
  return `import { unassignedEngine } from './engine-next.js';\nexport const ${name.toUpperCase()}_ENGINE = unassignedEngine();\n`;
}

test('an automatic landing amends through the real hook while an ordinary worktree stays refused [C7]', { timeout: 240_000 }, async () => { // budget: real Git, native submit/review and a complete hooked landing batch.
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

  const entry = await itemWorktreeLocal(box, 1, 'web/land-1.test.js');
  mkdirSync(join(entry.path, 'packages/state/src/logic/engines'), { recursive: true });
  writeFileSync(join(entry.path, 'packages/state/src/logic/engines/alpha-engine.js'), unlandedEngine('alpha'));
  await commitItemLocal(box, entry);
  await submitItemLocal(box, entry);
  await acceptItemLocal(box, entry);
  // A second verified item the landing is not offered: its trailer must stay no authority, and it must not land with the first [C7].
  const sibling = await itemWorktreeLocal(box, 2, 'web/land-2.test.js');
  await commitItemLocal(box, sibling);
  await submitItemLocal(box, sibling);
  await acceptItemLocal(box, sibling);

  const before = box.git(entry.path, 'rev-parse', 'HEAD').trim();
  const unauthorized = box.tryGit(entry.path, 'commit', '--allow-empty', '--amend', '-m',
    `feat(merge): claim the verified item\n\nPullboard-Item: #${entry.item}`);
  assert.notEqual(unauthorized.status, 0, "the verified item's trailer is not authority in its ordinary worktree");
  assert.match(unauthorized.stderr, /verified item in the landing checkout/u);
  assert.equal(box.git(entry.path, 'rev-parse', 'HEAD').trim(), before, 'the refusal leaves the verified commit intact');

  // The land job offers every verified unheld item, so the sibling is held: verified, unmerged and not offered [C7,#6807].
  const held = box.run(box.repo, 'hold', String(sibling.item), '--reason', 'not offered to this landing');
  assert.equal(held.code, 0, `${held.err}\n${held.out}`);
  // Pull dispatch offers the landing as a runner job; the spawned command returns once the loopback runner has settled it.
  const result = box.run(box.repo, 'land', '--json');
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  const shown = await box.runLocal(box.repo, 'show', String(entry.item), '--json');
  assert.equal(shown.code, 0, shown.err);
  const item = JSON.parse(shown.out);
  assert.equal(box.git(box.repo, 'rev-list', '--parents', '-n', '1', item.item_merged_commit).split(' ').length, 3,
    'the automatic engine amendment remains inside the landed merge');
  assert.match(box.git(box.repo, 'show', `${item.item_merged_commit}:packages/state/src/logic/engines/alpha-engine.js`), /ALPHA_ENGINE = 81;/u,
    "the installed commit-msg hook allowed the landing's verified item trailer");
  assert.match(box.git(box.repo, 'show', `${item.item_merged_commit}:docs/formats.md`), /`move engine` \| `81`/u);
  assert.equal(box.git(box.repo, 'rev-parse', 'main').trim(), item.item_merged_commit, 'the amended merge reaches actual main');
  // The job's authority is its own offered item: the sibling stays verified and unmerged, and its trailer is still no authority in its ordinary worktree.
  const other = JSON.parse((await box.runLocal(box.repo, 'show', String(sibling.item), '--json')).out);
  assert.equal(other.item_status, 'verified', 'the landing job did not take the item it was not offered');
  assert.equal(other.item_merged_commit, null);
  const borrowed = box.tryGit(sibling.path, 'commit', '--allow-empty', '--amend', '-m',
    `feat(merge): claim the verified item\n\nPullboard-Item: #${sibling.item}`);
  assert.notEqual(borrowed.status, 0, "the sibling's verified trailer is no authority after the job landed another item");
  assert.match(borrowed.stderr, /verified item in the landing checkout/u);
  assert.ok(readFileSync(join(box.repo, '.githooks/commit-msg'), 'utf8').includes('hook commit-msg'), 'the real hook remains installed');
});
