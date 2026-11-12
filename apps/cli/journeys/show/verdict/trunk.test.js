/** @pullboard-test-input apps/cli/src/io/run/tests.js */
/** A verdict survives a main move that touches nothing the review depends on (#928) [V4,C7]. */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../../tests/fixtures/testkit.js';

/**
 * A board whose web item's check runs test/page.test.js, which imports web/lib.js and web/shared.js; a second test
 * reads only api/other.js. Arming `landing` makes the next check run land one commit on main mid-review, changing
 * the named file, exactly as the merge train would while a reviewer's check runs.
 */
function reviewWithLanding(t, { setting, landing }) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  // This independent CLI launches a new test runner, not the outer worker's internal child context.
  delete box.env.NODE_TEST_CONTEXT;
  const armed = join(box.dir, 'landing-armed');
  const landed = join(box.dir, 'landing-done');
  for (const folder of ['test', 'web', 'api', 'bin', 'apps/cli/src/io/run']) mkdirSync(join(box.repo, folder), { recursive: true });
  writeFileSync(join(box.repo, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n');
  // This is the fixture project's real runner; the installed CLI remains outside the project.
  writeFileSync(join(box.repo, 'apps/cli/src/io/run/tests.js'), `import { spawnSync } from 'node:child_process';
const child = spawnSync(process.execPath, ['--test', ...process.argv.slice(2)], { stdio: 'inherit' });
if (child.error) throw child.error;
if (child.signal) process.kill(process.pid, child.signal);
else process.exitCode = child.status ?? 1;
`);

  writeFileSync(join(box.repo, 'web/shared.js'), 'export const shared = 1;\n');
  writeFileSync(join(box.repo, 'web/lib.js'), "export const page = 'draft';\n");
  writeFileSync(join(box.repo, 'api/other.js'), 'export const other = 1;\n');
  writeFileSync(join(box.repo, 'test/other.test.js'), "import { test } from 'node:test'; import { other } from '../api/other.js'; test('other', () => { if (!other) throw new Error('no'); });\n");
  writeFileSync(join(box.repo, 'test/page.test.js'), `import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { page } from '../web/lib.js';
import { shared } from '../web/shared.js';
test('page is built', () => {
  if (page !== 'built' || !shared) throw new Error('page is not built');
  if (existsSync(${JSON.stringify(armed)})) {
    rmSync(${JSON.stringify(armed)});
    const repo = ${JSON.stringify(box.repo)};
    writeFileSync(repo + '/' + ${JSON.stringify(landing)}, 'export const moved = ' + Date.now() + ';\\n');
    const git = (...args) => execFileSync('git', ['-c', 'user.name=Train', '-c', 'user.email=train@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, env: { PATH: process.env.PATH } });
    git('add', ${JSON.stringify(landing)});
    git('commit', '-q', '-m', 'feat(merge): an unrelated item lands');
    writeFileSync(${JSON.stringify(landed)}, 'landed');
  }
});
`);
  const config = JSON.parse(String(execGitShow(box)));
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...config, lanes: { ...config.lanes, web: { ...config.lanes.web, owns: [...config.lanes.web.owns, 'test/', 'apps/cli/src/io/run/'] } }, verify: { ...(config.verify ?? {}), ...(setting === undefined ? {} : { unrelatedTrunkMoves: setting }) } }, null, 2));
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: a page item with a recorded landing [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  /** Demand real command success and its versioned result. */
  const json = (result) => { assert.equal(result.code, 0, result.out + result.err); return JSON.parse(result.out); };
  json(fixtureAdd(box.run, box.repo, 'web', 'Build the page', '--criterion', 'the page is built', '--check', 'node apps/cli/src/io/run/tests.js test/page.test.js', '--json'));
  json(box.run(box.web, 'claim', '1', '--json'));
  writeFileSync(join(box.web, 'web/lib.js'), "export const page = 'built';\n");
  box.git(box.web, 'add', 'web/lib.js');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): build the page [G1]');
  json(box.run(box.web, 'submit', '1', '--json'));
  // A landing between submit and review changes the runner the check names, so the sealed submit proof is not reused and the frozen check runs here.
  appendFileSync(join(box.repo, 'apps/cli/src/io/run/tests.js'), '// an earlier landing\n');
  box.git(box.repo, 'add', 'apps/cli/src/io/run/tests.js');
  box.git(box.repo, 'commit', '-q', '-m', 'test: an earlier landing [G1]');
  const reviewer = join(box.dir, 'api-1');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, box.git(box.web, 'rev-parse', 'HEAD'));
  json(fixtureJoin(box.run, reviewer, 'api', '--json'));
  writeFileSync(armed, 'armed');
  const verdict = box.run(reviewer, 'verify', '1', 'accept', '--note', 'the page builds', '--json');
  assert.ok(existsSync(landed), 'main really moved while the review ran: ' + verdict.out + verdict.err);
  return { box, verdict, json };
}

/** The coordinator's committed pullboard.json at main. */
function execGitShow(box) {
  return box.git(box.repo, 'show', 'HEAD:pullboard.json');
}

test('an unrelated landing during a review keeps the verdict and names the commit it judged [V4,C7]', (t) => {
  const { box, verdict, json } = reviewWithLanding(t, { setting: true, landing: 'api/other.js' });
  assert.equal(verdict.code, 0, verdict.out + verdict.err);
  const item = json(box.run(box.repo, 'show', '1', '--json'));
  assert.equal(item.item_status, 'verified');
  const moved = box.git(box.repo, 'rev-parse', 'HEAD').slice(0, 12);
  assert.match(item.verdicts.at(-1).verdict_note, new RegExp(`main moved during this review through ${moved}.*its files are unchanged`, 'u'));
});

test('a landing that rewrites a file the review judged refuses acceptance and keeps the item submitted [V4,C7]', (t) => {
  const { box, verdict, json } = reviewWithLanding(t, { setting: true, landing: 'web/lib.js' });
  assert.notEqual(verdict.code, 0);
  const error = JSON.parse(verdict.out).error;
  assert.equal(error.code, 'MERGE_CONFLICT');
  assert.match(error.message, /web\/lib\.js/u);
  assert.equal(json(box.run(box.repo, 'show', '1', '--json')).item_status, 'submitted');
});

test('with the unrelated shortcut off a clean landing reruns once [V4,C7]', (t) => {
  const { verdict } = reviewWithLanding(t, { setting: undefined, landing: 'api/other.js' });
  assert.equal(verdict.code, 0, verdict.out + verdict.err);
  assert.equal(JSON.parse(verdict.out).decision, 'ACCEPT');
});
