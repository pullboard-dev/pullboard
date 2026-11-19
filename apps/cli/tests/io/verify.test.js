/** A reviewer's re-run applies the submit rule: a case an open Main red repair names never fails it [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureChild } from '../fixtures/child.js';
import { runFixtureGit } from '../fixtures/child.js';
import { createE2eHelpers } from '../fixtures/e2e.js';
import { joinFixtureSeat } from '../fixtures/testkit.js';
import { knownMainCheck } from '../../index.js';

const CHECK = 'node --test test/affected.test.js';
// The case fails on main and on the candidate with different messages, so no exact comparison of the two runs can match it.
const source = value => `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('x case [G1]', () => assert.equal('${value}', 'fixed'));\n`;

/** A real repository whose main fails the case, and the candidate's red run of the same check. */
function fixture(t) {
  // The nested node --test runs must not inherit this runner's test context, or they report nothing.
  const context = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  t.after(() => { if (context !== undefined) process.env.NODE_TEST_CONTEXT = context; });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-verify-known-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.invalid' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !/^GIT_(CONFIG|AUTHOR|COMMITTER)/u.test(key)) delete env[key];
  const git = (...args) => runFixtureGit(args, { cwd: root, env }).trim();
  git('init', '-q', '-b', 'main');
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'test/affected.test.js'), source('main'));
  git('add', '-A'); git('commit', '-q', '-m', 'test(core): main fixture [G1]');
  const main = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'test/affected.test.js'), source('item'));
  const ran = runFixtureChild(process.execPath, ['--test', 'test/affected.test.js'], { cwd: root, env, encoding: 'utf8' });
  const output = String(ran.stdout) + String(ran.stderr);
  const check = { state: 'red', checked: true, executionSourceUnchanged: true, exitCode: 1, output };
  return { root, main, check };
}

/** The open Main red repair whose own check runs the shared file. */
const repair = { item_id: 7, item_status: 'open', item_title: 'Main red: x case', item_check: CHECK, item_criterion: "The case 'x case [G1]' passes on main." };

test('cli.io-verify.a-re-run-whose-only-red-case: a re-run whose only red case an open Main red repair names is known main, not CHECK_RED [C7]', async t => {
  const { root, main, check } = fixture(t);
  const known = await knownMainCheck(root, check, { main, item: 9, items: () => [repair] });
  assert.ok(known, 'the owned case never fails the re-run');
  assert.deepEqual(known.failures.map(row => [row.file, row.name, row.item]), [['test/affected.test.js', 'x case [G1]', 7]]);
});

test('cli.io-verify.with-no-open-main-red-repair-naming: control: with no open Main red repair naming that case, the re-run stays red [C7]', async t => {
  const { root, main, check } = fixture(t);
  assert.equal(await knownMainCheck(root, check, { main, item: 9, items: () => [] }), null);
});

const MERGE_CRITERION = 'The page meets its bar:\n1) The page names its title [reasoning]';

/** An item with no test check, a tick at commit A by the reviewer, and a submitted head B that is A plus a merge of a main commit adding `mainFile`. */
async function mergedHeadItem(t, mainFile) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const ok = async (cwd, ...args) => {
    const result = await box.runIn(cwd, ...args);
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}\n${result.out}`);
  };
  await ok(box.repo, 'add', 'web', 'Merge tick fixture', '--specs', 'G1', '--criterion', MERGE_CRITERION, '--route', 'strong', '--brief', 'Files:\n- web/item-1.js\n- web/shared.js\nTest: the item is accepted with its recorded proof');
  await ok(box.web, 'claim', '1');
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/item-1.js'), 'export const complete = true;\n');
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): complete fixture 1 [G1]');
  const ticked = box.git(box.web, 'rev-parse', 'HEAD');
  await ok(box.web, 'fact', '1', 'note', `clause 1 [reasoning]: read web/item-1.js at ${ticked}: it exports complete`);
  mkdirSync(join(box.repo, mainFile, '..'), { recursive: true });
  writeFileSync(join(box.repo, mainFile), 'main moves\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: main moves');
  box.git(box.web, 'merge', '-q', '--no-edit', 'main');
  const submitted = box.git(box.web, 'rev-parse', 'HEAD');
  helpers.historicalCheckSubmission(box, submitted);
  const review = join(box.dir, 'merge-tick-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, submitted);
  assert.equal(joinFixtureSeat(box, review, 'api').code, 0);
  assert.equal(box.run(review, 'next', '--verify', '1', '--json').code, 0);
  return { box, review };
}

test('cli.io-verify.accept-reads-a-tick-across-a-merge-of-main: clause 3: verify accept on an item with no check, ticked at A and submitted at A plus a merge of main, is not refused CLAUSE_UNTICKED, and the same run with an item file changed by the merge still is [C7]', { timeout: 240_000 }, async t => {
  const same = await mergedHeadItem(t, 'main-moves.txt');
  const accepted = await same.box.runIn(same.review, 'verify', '1', 'accept', '--note', 'read web/item-1.js: it exports complete');
  assert.doesNotMatch(`${accepted.out}${accepted.err}`, /CLAUSE_UNTICKED/u, 'a merge of main that left the item files alone keeps the tick');
  const changed = await mergedHeadItem(t, 'web/shared.js');
  const refused = await changed.box.runIn(changed.review, 'verify', '1', 'accept', '--note', 'read web/item-1.js: it exports complete');
  assert.match(`${refused.out}${refused.err}`, /CLAUSE_UNTICKED/u, 'a merge that changed an item file leaves the tick at the earlier head');
});
