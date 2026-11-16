/**
 * The shared body of the submit size-note journeys: one real committed change submitted under a configured item budget [V4,C7].
 * Why a fixture: the six budget cases each settle a pulled gate, so they run as three files inside the 120 s file budget.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reviveFixtureLocalRunner } from '../runner/local-start.js';
import { CLI_ENTRY } from '../runner/entry.js';
import { fixtureAdd } from '../testkit.js';
import { settledGateJob } from './settle.js';

/** Submit a real committed change under the board's configured budget and inspect its public result. */
export async function submitSized(helpers, lines, budget) {
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
  const claimed = await box.runLocal(box.web, 'claim', '1');
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/big.txt'), Array.from({ length: lines }, (_, line) => `line ${line}`).join('\n') + '\n');
  box.git(box.web, 'add', 'web/big.txt');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): build the page [G1]');
  const submitted = await box.runLocal(box.web, 'submit', '1');
  const output = submitted.out + submitted.err;
  assert.equal(submitted.code, 0, output);
  // The pulled gate settles on the machine's loopback runner; the item moves to submitted once its receipt applies.
  reviveFixtureLocalRunner(box.repo, box.env, { entry: CLI_ENTRY });
  await settledGateJob(box, 1);
  const shown = await box.runLocal(box.repo, 'show', '1', '--json');
  assert.equal(shown.code, 0, shown.out + shown.err);
  assert.equal(JSON.parse(shown.out).item_status, 'submitted', output);
  return output;
}

/**
 * Submit `lines` changed lines under `budget` (the default 100 when undefined) and check the split note appears exactly when expected.
 *
 * @param {object} helpers - createE2eHelpers().
 * @param {Array<[number, number | undefined, boolean]>} cases - lines, budget, whether the note is expected.
 */
export async function expectSplitNotes(helpers, cases) {
  for (const [lines, budget, expected] of cases) {
    const output = await submitSized(helpers, lines, budget);
    const notes = output.match(/[^\n]*consider splitting[^\n]*/gu) ?? [];
    assert.equal(notes.length, expected ? 1 : 0, `${lines} changed lines with budget ${budget ?? 100}: ${output}`);
    if (expected) {
      assert.match(notes[0], new RegExp(`changes ${lines} lines against main, over twice the ${budget ?? 100}-line item budget; consider splitting it into a chain`, 'u'));
    }
  }
}
