/** A submit over twice its board item budget advises a split and never blocks [V4,C7].
 * Material test fixture parent: core616/tests53, submitted383cd010; repaired by core631 whole420/475.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

/** Submit a real committed change under the board's configured budget and inspect its public result. */
function submitSized(helpers, lines, budget) {
  const box = helpers.project('true');
  const configPath = join(box.repo, 'pullboard.json');
  if (budget !== undefined) {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.itemSizeBudget = budget;
    writeFileSync(configPath, JSON.stringify(config, null, 2));
  }
  writeFileSync(join(box.repo, 'check.cjs'), `const fs = require('node:fs');
process.exit(fs.existsSync('web/big.txt') ? 0 : 1);
`);
  box.git(box.repo, 'add', 'check.cjs', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'test: record size fixture check [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const added = fixtureAdd(box.run, box.repo, 'web', 'Build the page', '--criterion', 'the page is built', '--check', 'node check.cjs');
  assert.equal(added.code, 0, added.out + added.err);
  const claimed = box.run(box.web, 'claim', '1');
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/big.txt'), Array.from({ length: lines }, (_, line) => `line ${line}`).join('\n') + '\n');
  box.git(box.web, 'add', 'web/big.txt');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): build the page [G1]');
  const submitted = box.run(box.web, 'submit', '1');
  const output = submitted.out + submitted.err;
  assert.equal(submitted.code, 0, output);
  const shown = box.run(box.repo, 'show', '1', '--json');
  assert.equal(shown.code, 0, shown.out + shown.err);
  assert.equal(JSON.parse(shown.out).item_status, 'submitted', output);
  return output;
}

test('a submit far over the size budget prints a split suggestion and still submits [V4,C7]', { timeout: 180_000 }, t => { // budget: six real Git/SQLite submissions prove configurable boundaries.
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  for (const [lines, budget, expected] of [[101, 50, true], [250, undefined, true], [200, undefined, false], [100, 50, false], [250, 200, false], [401, 200, true]]) {
    const output = submitSized(helpers, lines, budget);
    const notes = output.match(/[^\n]*consider splitting[^\n]*/gu) ?? [];
    assert.equal(notes.length, expected ? 1 : 0, `${lines} changed lines with budget ${budget ?? 100}: ${output}`);
    if (expected) {
      assert.match(notes[0], new RegExp(`changes ${lines} lines against main, over twice the ${budget ?? 100}-line item budget; consider splitting it into a chain`, 'u'));
    }
  }
});
