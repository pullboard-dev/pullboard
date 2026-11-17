/** A RATCHET_ROSE refusal carries the identity ratchetMachineryRule computes for the same main and rules [C7,#9790]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureCommitAll } from '../../../gate/tests/fixtures/testkit.js';
import { checkRulesAt } from '../../index.js';
import { holdDoctrine } from '../../index.js';
import { ratchetMachineryRule } from '../../index.js';

const roots = [];
const home = privateFixtureFiles('doctrine-ratchet-identity-home-').root;
const previousHome = process.env.PULLBOARD_MACHINE_HOME;
process.env.PULLBOARD_MACHINE_HOME = home;
after(() => {
  for (const root of [...roots, home]) rmSync(root, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
  else process.env.PULLBOARD_MACHINE_HOME = previousHome;
});

// Main's declared count stays 0, as src/view.css's cap problem was absent from the count at 167251144.
const RULE = '- C9 [approved, must] Stylesheets stay under the cap. | gate: check grep -rn OVER src || true | count: 0';
const CSS = 'body { margin: 0; }\na { color: red; }\n';

/** Run Git without hooks or the caller's repository variables; fail with its stderr. */
function git(root, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

/** Stage everything and commit, returning the new commit id. */
function commitAll(root, message) {
  git(root, 'add', '-A', '--', '.');
  git(root, 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

/**
 * The item's frozen base has a clean src/view.css; main then gains one problem there without
 * raising its declared count, and may rewrite its doctrine rows. The item is built from the
 * frozen base in its own worktree.
 */
function repo({ mainRules } = {}) {
  const dir = privateFixtureFiles('doctrine-ratchet-identity-').root;
  roots.push(dir);
  const root = join(dir, 'main');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'DOCTRINE.md'), `## C · Code\n${RULE}\n`);
  writeFileSync(join(root, 'src/view.css'), CSS);
  writeFileSync(join(root, 'src/app.js'), 'export const app = 1;\n');
  fixtureCommitAll(root);
  const frozen = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'src/view.css'), `${CSS}/* OVER the cap */\n`);
  if (mainRules) writeFileSync(join(root, 'DOCTRINE.md'), `## C · Code\n${mainRules.join('\n')}\n`);
  const main = commitAll(root, 'feat: main grows the stylesheet over the cap');
  const item = join(dir, 'item');
  git(root, 'worktree', 'add', '-q', '-b', 'core/item', item, frozen);
  return { root, item, frozen, main };
}

/** The error a forced RATCHET_ROSE hold throws: the item adds a second problem to main's over-cap file. */
function roseError(box) {
  git(box.item, 'merge', '-q', '--no-edit', 'main');
  writeFileSync(join(box.item, 'src/view.css'), `${CSS}/* OVER the cap */\n/* OVER again */\n`);
  const commit = commitAll(box.item, 'feat: grow the stylesheet further');
  try { holdDoctrine(box.item, { mainCommit: box.frozen, commit, timeoutMs: 60000 }); } catch (error) { return error; }
  return assert.fail('the hold did not refuse');
}

/** The submit rules the refusal was held against at main. */
const rulesAt = (box) => checkRulesAt(box.item, box.main).filter((rule) => rule.runs === 'submit');

test('clause 1: ratchetMachineryRule equals the machineryRule on a RATCHET_ROSE refusal for the same main and rules [C7,#9790]', () => {
  const box = repo();
  const error = roseError(box);
  assert.equal(error.code, 'RATCHET_ROSE');
  assert.match(error.machineryRule, /^[0-9a-f]{64}$/u);
  assert.equal(ratchetMachineryRule(box.item, box.main, rulesAt(box)), error.machineryRule);
});

test('clause 2: ratchetMachineryRule changes when the rules change, and is null for an unreadable main [C7,#9790]', () => {
  const box = repo();
  const rules = rulesAt(box);
  const same = ratchetMachineryRule(box.item, box.main, rules);
  assert.notEqual(ratchetMachineryRule(box.item, box.main, [{ ...rules[0], count: rules[0].count + 1 }]), same);
  assert.notEqual(ratchetMachineryRule(box.item, box.main, []), same);
  assert.equal(ratchetMachineryRule(box.item, 'no-such-commit', rules), null);
});
