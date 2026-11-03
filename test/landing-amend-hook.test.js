/** A landing amend uses its verified item through the installed hook; an ordinary worktree cannot [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { makeLandProjectFixtures } from './land-project-fixture.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures(e2e);

/** Add a placeholder engine so the landing must amend its verified merge commit. */
function unlandedEngine(name) {
  return `import { unassignedEngine } from './engine-next.js';\nexport const ${name.toUpperCase()}_ENGINE = unassignedEngine();\n`;
}

test('an automatic landing amends through the real hook while an ordinary worktree stays refused [C7]', { timeout: 240_000 }, () => {
  const box = landProject();
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.lanes.web.owns = [...new Set([...config.lanes.web.owns, 'src/', 'docs/'])];
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  mkdirSync(join(box.repo, 'src'), { recursive: true });
  mkdirSync(join(box.repo, 'docs'), { recursive: true });
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'src/base-engine.js'), '/** The landed base engine. */\nexport const BASE_ENGINE = 80;\n');
  writeFileSync(join(box.repo, 'docs/formats.md'), '| Format | Version |\n| --- | --- |\n| `move engine` | `80` | fixture |\n');
  box.git(box.repo, 'add', '-A');
  const configured = box.tryGit(box.repo, 'commit', '-q', '-m', 'chore: configure hook fixture');
  assert.equal(configured.status, 0, configured.stderr);
  box.git(box.repo, 'push', '-q', 'origin', 'main');

  const entry = itemWorktree(box, 1, 'web/land-1.test.js');
  writeFileSync(join(entry.path, 'src/alpha-engine.js'), unlandedEngine('alpha'));
  submitItem(box, entry);
  acceptItem(box, entry);

  const before = box.git(entry.path, 'rev-parse', 'HEAD').trim();
  const unauthorized = box.tryGit(entry.path, 'commit', '--allow-empty', '--amend', '-m',
    `feat(merge): claim the verified item\n\nPullboard-Item: #${entry.item}`);
  assert.notEqual(unauthorized.status, 0, 'the verified item's trailer is not authority in its ordinary worktree');
  assert.match(unauthorized.stderr, /verified item in the landing checkout/u);
  assert.equal(box.git(entry.path, 'rev-parse', 'HEAD').trim(), before, 'the refusal leaves the verified commit intact');

  const result = box.run(box.repo, 'land', '--json');
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  const landed = JSON.parse(result.out);
  assert.deepEqual(landed.landed, [entry.item]);
  const item = JSON.parse(box.run(box.repo, 'show', String(entry.item), '--json').out).item;
  assert.equal(box.git(box.repo, 'rev-list', '--parents', '-n', '1', item.item_merged_commit).split(' ').length, 3,
    'the automatic engine amendment remains inside the landed merge');
  assert.match(box.git(box.repo, 'show', `${item.item_merged_commit}:src/alpha-engine.js`), /ALPHA_ENGINE = \d+;/u,
    'the installed commit-msg hook allowed the landing's verified item trailer');
});
