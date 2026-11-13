/** A pulled landing refreshes the test registries and badge documents inside its merge, as the batch lander did [C7]. */
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

const SCRIPT = 'packages/gate/src/io/test/scripts/registries.js';
const REGISTRY = 'packages/gate/data/tests/test-journeys.json';

/** The tree's own registry deriver in miniature: list every test file the merge added into one registry and print the changed paths. */
const DERIVER = `import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const at = process.argv.indexOf('--base');
const added = execFileSync('git', ['diff', '--name-only', '--diff-filter=A', process.argv[at + 1], 'HEAD'], { encoding: 'utf8' }).split('\\n').filter(file => file.endsWith('.test.js')).sort();
mkdirSync('packages/gate/data/tests', { recursive: true });
writeFileSync('${REGISTRY}', JSON.stringify({ files: added }, null, 2) + '\\n');
process.stdout.write(JSON.stringify(['${REGISTRY}']) + '\\n');
`;

test('a pulled landing lands the refreshed test registry and badge documents in its merge on main [C7]', { timeout: 240_000 }, async () => { // budget: real Git, native submit/review and a complete pulled landing.
  const box = landProject({ withWorktree: false });
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.landing = { ...config.landing, parallel: false, publish: 'separate' };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  mkdirSync(join(box.repo, 'packages/gate/src/io/test/scripts'), { recursive: true });
  writeFileSync(join(box.repo, SCRIPT), DERIVER);
  box.git(box.repo, 'add', '-A');
  const configured = box.tryGit(box.repo, 'commit', '-q', '-m', 'chore: configure registries fixture');
  assert.equal(configured.status, 0, configured.stderr);
  box.git(box.repo, 'push', '-q', 'origin', 'main');

  const entry = await itemWorktreeLocal(box, 1, 'web/land-1.test.js');
  await commitItemLocal(box, entry);
  await submitItemLocal(box, entry);
  await acceptItemLocal(box, entry);

  const result = box.run(box.repo, 'land', '--json');
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  const shown = await box.runLocal(box.repo, 'show', String(entry.item), '--json');
  const item = JSON.parse(shown.out);
  assert.ok(item.item_merged_commit, 'the item landed');
  assert.equal(box.git(box.repo, 'rev-list', '--parents', '-n', '1', item.item_merged_commit).split(' ').length, 3, 'the derived files ride inside the item merge');
  assert.equal(box.git(box.repo, 'rev-parse', 'main').trim(), item.item_merged_commit, 'the merge is main');
  assert.deepEqual(JSON.parse(box.git(box.repo, 'show', `main:${REGISTRY}`)).files, ['web/land-1.test.js'], 'the registry on main lists the test the item added');
  assert.match(box.git(box.repo, 'show', 'main:docs/badges/items.json'), /"message": "1 items"/u, 'the badge document on main counts the landed item');
});
