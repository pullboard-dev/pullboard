/**
 * End to end on real repos: the gate reaches the agent as a digest, split from e2e.test.js so each file fits its budget [V10,C7].
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';

import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { settleSubmit } from '../../tests/fixtures/submit/settle.js';
import { fixtureAddRoute } from '../../tests/fixtures/testkit.js';
import { fixtureProjectPolicy } from '../../tests/fixtures/testkit.js';
import { fixtureJoinRoute } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, CONFIG, project, commitFile } = e2e;

/** Assert and remove only the outer command's exact final text action; retain every body byte. */
function withoutAction(text, action = 'pullboard next') {
  const footer = `next: ${action}\n`;
  assert.ok(text.endsWith('\n' + footer), 'the intended final action is present');
  return text.slice(0, -footer.length);
}

/** Await real production CLI dispatch without repeating cold process startup for fixture state moves. */
function fixtureCommand(box, cwd, ...args) {
  return runCliInProcess(fixtureAddRoute(fixtureJoinRoute([...args], box.env.PULLBOARD_MODEL)), { cwd, env: box.env });
}

const OK_LINES = 400, NOTE_LINES = 100;

test('cli.journeys-resume-e2e-digest.the-gate-reaches-the-agent-as: the gate reaches the agent as a digest: one line when green, the failure when red; the whole output stays in the git dir [V10]', async t => {
  const box = project(undefined, sandbox(), { withWorktree: false });
  writeFileSync(join(box.repo, 'gate.cjs'), [
    "const red = require('node:fs').existsSync('RED');",
    "const { writeSync } = require('node:fs');",
    "for (let i = 0; i < " + OK_LINES + "; i++) writeSync(1, `ok ${i} ${'x'.repeat(red ? 10 : 3000)}\\n`);",
    "if (red) { writeSync(2, 'not ok " + (OK_LINES + 1) + " - the page renders a heading\\n'); for (let i = 0; i < " + NOTE_LINES + "; i++) writeSync(1, `# note ${i}\\n`); process.exitCode = 1; }",
    '',
  ].join('\n'));
  fixtureProjectPolicy(box.repo, { config: { ...CONFIG, gate: 'node gate.cjs # prints a lot' } });
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: a noisy gate');
  const log = join(box.repo, box.git(box.repo, 'rev-parse', '--git-path', 'pullboard-gate.log'));
  const green = await fixtureCommand(box, box.repo, 'gate');
  assert.equal(green.code, 0, green.err);
  const greenBody = withoutAction(green.out);
  assert.match(greenBody, /^gate green in \d+s; timing \(node\): wall [0-9.]+s, slot wait [0-9.]+s; phases: wait [0-9.]+s, admission [0-9.]+s, setup [0-9.]+s, run [0-9.]+s, evidence [0-9.]+s; slot: .+?; per-test timing unavailable: output was not TAP or JUnit; timing profile: [^\n]+\n$/);
  assert.equal(greenBody.trimEnd().split('\n').length, 1, 'a green gate without file measurements remains one line');
  assert.ok(readFileSync(log, 'utf8').length > 1_200_000, 'more than the default 1 MB pipe buffer, read whole');
  writeFileSync(join(box.repo, 'RED'), 'red');
  box.git(box.repo, 'add', 'RED');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: turn the gate red');
  const red = await fixtureCommand(box, box.repo, 'gate');
  assert.equal(red.code, 1);
  assert.match(red.out, new RegExp(`^gate red in \\d+s:\\n {2}not ok ${OK_LINES + 1} - the page renders a heading\\n`));
  assert.match(red.out, new RegExp(` {2}# note ${NOTE_LINES - 1}\\n[\\s\\S]*the whole output is in `));
  assert.ok(red.out.length < 4000, `${red.out.length} characters`);
  const lines = readFileSync(log, 'utf8').split('\n');
  assert.equal(lines.length, OK_LINES + 1 + NOTE_LINES + 1, 'every ok line, the stderr line, every note and the final newline');
  assert.equal(lines[OK_LINES], `not ok ${OK_LINES + 1} - the page renders a heading`, 'stdout and stderr in one stream, in order');
  const web = join(box.dir, 'digest-builder');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'web/digest', web, 'main');
  const joined = await fixtureCommand(box, web, 'join', 'web');
  assert.equal(joined.code, 0, joined.err);
  const added = await fixtureCommand(box, box.repo, 'add', 'web', 'Noisy checked work', '--specs', 'G1',
    '--criterion', 'The noisy gate passes.', '--check', 'node gate.cjs', '--wait');
  assert.equal(added.code, 0, added.err);
  const claimed = await fixtureCommand(box, web, 'claim', '1');
  assert.equal(claimed.code, 0, claimed.err);
  const built = await commitFile(box, web, 'web/page.html', '<h1>Work</h1>', 'feat(web): noisy checked source [G1]');
  assert.equal(built.status, 0, built.stderr);
  // Under pull dispatch the submit returns queued; the red verdict arrives on the settled gate job's receipt [P7,C7].
  const queued = await fixtureCommand(box, web, 'submit', '1', '--no-next', '--json');
  assert.equal(queued.code, 0, queued.err + queued.out);
  const settled = await settleSubmit(t, box, JSON.parse(queued.out));
  const gate = settled.gate;
  assert.equal(gate?.green, false, `the pulled gate is red: ${JSON.stringify(gate)}`);
  // #1884 (b24440d3) intentionally replaced submit's raw TAP with a bounded failure summary and full run log.
  const report = JSON.stringify(gate);
  assert.match(report, /the page renders a heading/);
  assert.ok(report.length < 20_000, 'the receipt stays bounded instead of repeating the TAP stream');
});
