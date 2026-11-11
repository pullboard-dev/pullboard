/** @pullboard-test-input source-tree */
/** A verdict survives main moving through files the review never read, and a move that reaches it names the files (#1861) [V4,C7]. */
import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../../tests/fixtures/testkit.js';

const PAD = Array.from({ length: 8 }, (_, i) => `export const pad${i} = ${i};`).join('\n');

/**
 * A web item whose check runs web/page.test.js (imports web/lib.js and web/shared.js); test/other.test.js reads only
 * api/other.js. While the frozen check runs it lands commits on main appending to `landing`, once or on every run.
 */
function reviewWithLandings(t, { landing, every, rewrite = false }) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  delete box.env.NODE_TEST_CONTEXT; // This independent CLI launches its own test runner.
  const armed = join(box.dir, 'landing-armed');
  for (const folder of ['test', 'web', 'api']) mkdirSync(join(box.repo, folder), { recursive: true });
  writeFileSync(join(box.repo, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n');
  writeFileSync(join(box.repo, 'web/run-tests.js'), `import { spawnSync } from 'node:child_process';
const child = spawnSync(process.execPath, ['--test', ...process.argv.slice(2)], { stdio: 'inherit' });
if (child.error) throw child.error;
if (child.signal) process.kill(process.pid, child.signal);
else process.exitCode = child.status ?? 1;
`);
  writeFileSync(join(box.repo, 'web/shared.js'), `export const shared = 1;\n${PAD}\n`);
  writeFileSync(join(box.repo, 'web/lib.js'), `export const page = 'draft';\n${PAD}\n`);
  writeFileSync(join(box.repo, 'api/other.js'), `export const other = 1;\n${PAD}\n`);
  writeFileSync(join(box.repo, 'test/other.test.js'), "import { test } from 'node:test'; import { other } from '../api/other.js'; test('other', () => { if (!other) throw new Error('no'); });\n");
  writeFileSync(join(box.repo, 'web/page.test.js'), `import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { page } from './lib.js';
import { shared } from './shared.js';
test('page is built', () => {
  if (page !== 'built' || !shared) throw new Error('page is not built');
  if (!existsSync(${JSON.stringify(armed)})) return;
  ${every ? '' : `rmSync(${JSON.stringify(armed)});`}
  const repo = ${JSON.stringify(box.repo)};
  ${rewrite
    ? `writeFileSync(repo + '/' + ${JSON.stringify(landing)}, readFileSync(repo + '/' + ${JSON.stringify(landing)}, 'utf8').replace("'draft'", "'moved'"));`
    : `appendFileSync(repo + '/' + ${JSON.stringify(landing)}, 'export const moved' + Date.now() + ' = 1;\\n');`}
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Train', '-c', 'user.email=train@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, env: { PATH: process.env.PATH } });
  git('add', ${JSON.stringify(landing)});
  git('commit', '-q', '-m', 'feat(merge): an item lands');
});
`);
  const config = JSON.parse(box.git(box.repo, 'show', 'HEAD:pullboard.json'));
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...config, verify: { policy: config.verify, unrelatedTrunkMoves: false } }, null, 2));
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: a page item with recorded landings [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const json = (result) => { assert.equal(result.code, 0, result.out + result.err); return JSON.parse(result.out); };
  json(fixtureAdd(box.run, box.repo, 'web', 'Build the page', '--criterion', 'the page is built', '--check', 'node web/run-tests.js web/page.test.js', '--json'));
  json(box.run(box.web, 'claim', '1', '--json'));
  writeFileSync(join(box.web, 'web/lib.js'), `export const page = 'built';\n${PAD}\n`);
  box.git(box.web, 'add', 'web/lib.js');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): build the page [G1]');
  json(box.run(box.web, 'submit', '1', '--json'));
  const reviewer = join(box.dir, 'api-1');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, box.git(box.web, 'rev-parse', 'HEAD'));
  json(fixtureJoin(box.run, reviewer, 'api', '--model', 'Fixture Reviewer', '--json'));
  // Main moving through a file the check names after the submit makes its proof unreusable, so the review runs the check itself.
  appendFileSync(join(box.repo, 'web/run-tests.js'), '// main moves after the submit\n');
  box.git(box.repo, 'add', 'web/run-tests.js');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: main moves after the submit');
  box.git(reviewer, 'commit', '--allow-empty', '-q', '-m', 'test: force the review check to run');
  writeFileSync(armed, 'armed');
  const verdict = box.run(reviewer, 'verify', '1', 'accept', '--note', 'the page builds', '--json');
  assert.equal(existsSync(armed), false, `the check really moved main during verification: ${verdict.out}${verdict.err}`);
  return { box, verdict, json };
}

test('a verdict after a landing that touches none of the item files is recorded against the new trunk, naming the range [V4,C7]', (t) => {
  const { box, verdict, json } = reviewWithLandings(t, { landing: 'api/other.js', every: false });
  assert.equal(verdict.code, 0, verdict.out + verdict.err);
  const item = json(box.run(box.repo, 'show', '1', '--json'));
  assert.equal(item.item_status, 'verified');
  const moved = box.git(box.repo, 'rev-parse', 'HEAD').slice(0, 12);
  assert.match(item.verdicts.at(-1).verdict_note, new RegExp(`main moved during this review through ${moved}.*its files are unchanged`, 'u'));
});

test('a landing touching another part of an item file accepts and names the composed file [V4,C7]', (t) => {
  const { box, verdict, json } = reviewWithLandings(t, { landing: 'web/lib.js', every: false });
  assert.equal(verdict.code, 0, verdict.out + verdict.err);
  const item = json(box.run(box.repo, 'show', '1', '--json'));
  assert.equal(item.item_status, 'verified');
  assert.match(item.verdicts.at(-1).verdict_note, /its patch on "web\/lib\.js" composes unchanged/u);
});

test('a landing rewriting the line an item changed refuses acceptance and names the file [V4,C7]', (t) => {
  const { box, verdict, json } = reviewWithLandings(t, { landing: 'web/lib.js', every: false, rewrite: true });
  assert.notEqual(verdict.code, 0, verdict.out + verdict.err);
  const error = JSON.parse(verdict.out).error;
  assert.ok(['MERGE_CONFLICT', 'VERDICT_TRUNK_MOVED'].includes(error.code), error.message);
  assert.match(error.message, /web\/lib\.js/u);
  assert.equal(json(box.run(box.repo, 'show', '1', '--json')).item_status, 'submitted');
});
