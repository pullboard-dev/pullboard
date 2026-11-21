/** Add accepts three numbered clauses and refuses a fourth, exercising the production add command [B35,C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { fixtureAdd } from '../../../fixtures/testkit.js';

/** Run the real CLI and require its successful versioned JSON result. */
async function json(box, ...args) {
  const result = await box.runLocal(box.repo, ...args, '--json');
  assert.equal(result.code, 0, result.out + result.err);
  return JSON.parse(result.out);
}

/** Commit empty files at `paths` on the fixture main, so a bar that names them is one a build can satisfy. */
function seedPaths(box, paths) {
  for (const path of paths) {
    mkdirSync(join(box.repo, path, '..'), { recursive: true });
    writeFileSync(join(box.repo, path), '');
  }
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: seed bar paths');
}

test('cli.journeys-add-brief.add-accepts-three-numbered-clauses-and: add accepts three numbered clauses and refuses a fourth even inside one cell [B35,C7]', async t => {
  const helpers = createE2eHelpers(); t.after(helpers.cleanup);
  const box = helpers.project('true');
  seedPaths(box, ['packages/alpha/a.js']);
  const criterion = '(1) Read packages/alpha/a.js. (2) Change it. (3) Prove it.';
  await json(box, 'add', 'web', 'Three clauses', '--specs', 'G1', '--criterion', criterion);
  const refused = await fixtureAdd(box.runLocal, box.repo, 'web', 'Four clauses', '--specs', 'G1', '--criterion', criterion + ' (4) Also publish it.', '--json');
  assert.equal(JSON.parse(refused.out).error.code, 'ITEM_TOO_LARGE');
  assert.match(JSON.parse(refused.out).error.next, /at most three numbered clauses/u);
});
