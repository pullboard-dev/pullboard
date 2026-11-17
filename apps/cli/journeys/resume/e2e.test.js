/**
 * End to end on real repos: the CLI runs as its own process, git runs the installed hooks, and
 * worktrees are real worktrees (B1–B3, B6, V3, V4, V7, L3, L4, C3, I1, I2, P2).
 */
import assert from 'node:assert/strict';
import {
  runFixtureChildAsync as spawnChild,
} from '../../tests/fixtures/child.js';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
} from 'node:path';
import {
  after,
  describe,
  it,
} from 'node:test';
import { claudeLoopRules } from '../../../../packages/config/index.js';

import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { settledGateJob } from '../../tests/fixtures/submit/settle.js';
import { settleSubmit } from '../../tests/fixtures/submit/settle.js';
import { fixtureAddRoute } from '../../tests/fixtures/testkit.js';
import { fixtureJoinRoute } from '../../tests/fixtures/testkit.js';
/** Cases are collected, then run concurrently: each owns its sandbox, repo and machine home, so they overlap their waits instead of adding them [C7]. */
const cases = [];
/** Register one case; it runs inside the concurrent suite at the end of this file. */
const test = (name, body) => cases.push([name, body]);

const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  BIN, sandbox, CONFIG, SPEC, commitFile, LIGHT_BRIEF,
} = e2e;

const { project } = e2e;

/** Assert and remove only the outer command's exact final text action; retain every body byte. */
function withoutAction(text, action = 'pullboard next') {
  const footer = `next: ${action}\n`;
  assert.ok(text.endsWith('\n' + footer), 'the intended final action is present');
  return text.slice(0, -footer.length);
}

/** File light work at mid, then route it light through the coordinator's diagnosis, as the board now requires. */
async function addDiagnosedLight(box, title, ...flags) {
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', title, ...flags);
  assert.equal(added.code, 0, added.err || added.out);
  const id = added.out.match(/^#(\d+)/m)?.[1];
  assert.ok(id, added.out);
  const diagnosis = (await box.runLocal(box.repo, 'fact', id, 'diagnosis', LIGHT_BRIEF));
  assert.equal(diagnosis.code, 0, diagnosis.err || diagnosis.out);
  return added;
}

/** Await real production CLI dispatch without repeating cold process startup for fixture state moves. */
function fixtureCommand(box, cwd, ...args) {
  return runCliInProcess(fixtureAddRoute(fixtureJoinRoute([...args], box.env.PULLBOARD_MODEL)), { cwd, env: box.env });
}

test('init adds a Claude Code session hook that runs resume, and keeps every other setting [I6]', async () => {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(join(repo, '.claude'), { recursive: true });
  box.git(repo, 'init', '-q', '-b', 'main');
  const mine = { permissions: { allow: ['Bash(npm test)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } };
  writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify(mine));
  assert.match((await box.runLocal(repo, 'init', '--verbose')).out, /added a Claude Code session hook/);
  assert.match((await box.runLocal(repo, 'init', '--verbose')).out, /kept the Claude Code session hook/);
  const settings = JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8'));
  // Init also grants the loop's allow rules and machine-home write (#670): the person's own rule stays first and
  // nothing else in permissions changes. apps/cli/journeys/init/permissions.test.js owns the exact rule list.
  assert.deepEqual(settings.permissions, { allow: [...mine.permissions.allow, ...claudeLoopRules({ gate: '' })] });
  assert.deepEqual(settings.sandbox, { filesystem: { allowWrite: [box.env.PULLBOARD_MACHINE_HOME] } });
  assert.deepEqual(Object.keys(settings).sort(), ['hooks', 'permissions', 'sandbox'], 'init adds no other top-level setting');
  assert.deepEqual(Object.keys(settings.hooks).sort(), ['SessionEnd', 'SessionStart', 'Stop'], 'init installs the three supported Claude activity hook events');
  assert.deepEqual(settings.hooks.Stop.slice(0, mine.hooks.Stop.length), mine.hooks.Stop);
  assert.equal(settings.hooks.Stop.length, mine.hooks.Stop.length + 1, 'only the new nonblocking Stop nudge is appended');
  assert.equal(settings.hooks.SessionStart.length, 1);
  const { command } = settings.hooks.SessionStart[0].hooks[0];
  // The hook's 2 s worker budget is the product's; a loaded runner starting a fresh node for it times out, so the card runs in this process [I6].
  assert.match(command, /exec pullboard hook SessionStart$/);
  const card = await runCliInProcess(['hook', 'SessionStart'], { cwd: repo, env: box.env });
  assert.equal(card.status, 0, card.stderr);
  assert.match(JSON.parse(card.stdout).hookSpecificOutput.additionalContext, /^resume: coordinator/);
  const bare = await spawnChild('sh', ['-c', command], { cwd: repo, env: { ...box.env, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  assert.equal(bare.status, 0, 'without pullboard installed, the session still starts');
  assert.equal(bare.stdout, '');
});

test('the run pack names verified items that touched the same files, so a cold agent follows them [N21]', async () => {
  const box = project();
  const script = (name, lines) => {
    writeFileSync(join(box.dir, name), ['#!/bin/sh', 'mkdir -p web', ...lines, ''].join('\n'));
    return `sh ${join(box.dir, name)}`;
  };
  const greet = script('greet.sh', ["echo \"export const title = 'Hi';\" > web/page.js"]);
  const follow = script('follow.sh', ['grep -q "^- #1 Greet: web/page.js$" "$PULLBOARD_PACK" && echo "export const bye = \'Bye\';" >> web/page.js']);
  await addDiagnosedLight(box, 'Greet', '--route', 'mid', '--criterion', 'says Hi', '--check', 'grep -q Hi web/page.js', '--brief', LIGHT_BRIEF);
  const runner = (await box.runLocal(box.repo, 'worktree', 'web', '--route', 'light')).out.match(/^made (\S+) /)[1];
  assert.match((await box.runLocal(runner, 'run', '--agent-light', greet, '--attempts', '1')).out, /#1 is in the gate as job /);
  await settledGateJob(box, 1); // the pulled gate records the item commit only once its receipt is applied [C7]
  const firstCommit = JSON.parse((await box.runLocal(box.repo, 'show', '1', '--json')).out).item_commit;
  box.git(box.web, 'merge', '-q', '--ff-only', firstCommit);
  assert.match((await box.runLocal(box.web, 'verify', '1', 'accept', '--note', 'emptied the page; the check failed')).out, /verified #1/);
  // Accepted work still blocks colliding pulls until it actually lands (#1114).
  box.git(box.repo, 'merge', '-q', '--ff-only', firstCommit);
  const landed = (await box.runLocal(box.repo, 'merged', '1', firstCommit));
  assert.equal(landed.code, 0, landed.err);
  await addDiagnosedLight(box, 'Say bye', '--route', 'mid', '--criterion', 'says Bye', '--check', 'grep -q Bye web/page.js', '--brief', LIGHT_BRIEF);
  const ran = (await box.runLocal(runner, 'run', '--agent-light', follow, '--attempts', '1'));
  assert.match(ran.out, /#2 is in the gate as job /, ran.out);
  const packs = join(box.dir, 'repo', '.git', 'worktrees', runner.split('/').at(-1), 'pullboard', 'packs');
  assert.match(readFileSync(join(packs, '2-light-1.md'), 'utf8'), /## Finished items that touched the same files\n- #1 Greet: web\/page.js\nFollow the patterns/);
});

test('a fresh worktree with no install of its own runs pullboard from the main checkout, for git hooks and the session hook [I6]', async () => {
  const box = project();
  const bare = { ...box.env, PATH: '/usr/bin:/bin' };
  const commit = () => spawnChild('git', ['commit', '-q', '-m', 'feat(web): page [G1]'], { cwd: box.web, env: bare, encoding: 'utf8' });
  const { command } = JSON.parse(readFileSync(join(box.web, '.claude', 'settings.json'), 'utf8')).hooks.SessionStart[0].hooks[0];
  const resume = () => spawnChild('sh', ['-c', command], { cwd: box.web, env: bare, encoding: 'utf8' });
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web', 'page.html'), '<h1>Hi</h1>');
  box.git(box.web, 'add', '-A');
  const refused = await commit();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /pullboard is not installed/);
  const [quiet1, quiet2] = await Promise.all([resume(), resume()]);
  assert.deepEqual([quiet1.status, quiet2.stdout], [0, ''], 'no install anywhere: the session still starts, silently');
  const bin = join(box.repo, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  // The shell stub notes who the session hook reached; the card itself runs in this process, because the hook's 2 s worker budget is the product's and a loaded runner cannot start two fresh nodes inside it [I6].
  const reached = join(box.repo, 'session-hook-reached');
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nif [ "$1" = hook ] && [ "$2" = SessionStart ]; then echo "$0" > "${reached}"; exit 0; fi\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const committed = await commit();
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal((await resume()).status, 0);
  assert.equal(realpathSync(readFileSync(reached, 'utf8').trim()), realpathSync(join(bin, 'pullboard')), 'the session hook found the main checkout install');
  const card = await runCliInProcess(['hook', 'SessionStart'], { cwd: box.web, env: bare });
  assert.match(JSON.parse(card.stdout).hookSpecificOutput.additionalContext, /^resume: web-1 \(fixture-model\), web lane/);
});

const OK_LINES = 400, NOTE_LINES = 100;

test('the gate reaches the agent as a digest: one line when green, the failure when red; the whole output stays in the git dir [V10]', async t => {
  const box = project(undefined, sandbox(), { withWorktree: false });
  writeFileSync(join(box.repo, 'gate.cjs'), [
    "const red = require('node:fs').existsSync('RED');",
    "const { writeSync } = require('node:fs');",
    "for (let i = 0; i < " + OK_LINES + "; i++) writeSync(1, `ok ${i} ${'x'.repeat(red ? 10 : 3000)}\\n`);",
    "if (red) { writeSync(2, 'not ok " + (OK_LINES + 1) + " - the page renders a heading\\n'); for (let i = 0; i < " + NOTE_LINES + "; i++) writeSync(1, `# note ${i}\\n`); process.exitCode = 1; }",
    '',
  ].join('\n'));
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...CONFIG, gate: 'node gate.cjs # prints a lot' }));
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

test('submit refuses a bar that moved since the claim, before any verifier runs; a refreeze and a fresh claim recover [V11]', async () => {
  const box = project();
  await fixtureAdd(box.runLocal, box.repo, 'web', 'Page', '--specs', 'G1', '--criterion', 'renders');
  (await box.runLocal(box.web, 'claim', '1'));
  writeFileSync(join(box.repo, 'SPEC.md'), SPEC.replace('The page renders.', 'The page renders a heading.'));
  assert.equal((await box.runLocal(box.repo, 'spec', 'approve', 'G1')).code, 0);
  box.git(box.repo, 'commit', '-qam', 'docs: tighten G1');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  await commitFile(box, box.web, 'web/a.html', '<h1>Hi</h1>', 'feat(web): page [G1]');
  const refused = (await box.runLocal(box.web, 'submit', '1'));
  assert.equal(refused.code, 1);
  assert.match(refused.err, /CRITERIA_CHANGED\] the spec rows #1 cites changed after it was claimed, so no verifier could judge it; the coordinator runs pullboard refreeze 1, then you claim it and submit again/);
  assert.equal(JSON.parse((await box.runLocal(box.repo, 'show', '1', '--json')).out).item_status, 'claimed');
  assert.match((await box.runLocal(box.repo, 'refreeze', '1')).out, /refrozen/);
  (await box.runLocal(box.web, 'claim', '1'));
  assert.match((await box.runLocal(box.web, 'submit', '1')).out, /#1 is in the gate as job /);
});

test('spec check at an older commit skips ids that items cite from a later commit; a never-committed id still fails [S10]', async () => {
  const box = project();
  writeFileSync(join(box.repo, 'SPEC.md'), `${SPEC}- G3 [draft, must] The page has a footer.\n`);
  box.git(box.repo, 'commit', '-qam', 'docs(spec): a footer row');
  await fixtureAdd(box.runLocal, box.repo, 'web', 'Footer', '--specs', 'G3');
  const older = (await box.runLocal(box.web, 'spec', 'check'));
  assert.equal(older.code, 0, older.out);
  writeFileSync(join(box.repo, 'SPEC.md'), `${SPEC}- G3 [draft, must] The page has a footer.\n- G4 [draft, must] Not committed.\n`);
  await fixtureAdd(box.runLocal, box.repo, 'web', 'Ghost', '--specs', 'G4');
  const ghost = (await box.runLocal(box.web, 'spec', 'check'));
  assert.equal(ghost.code, 1);
  assert.match(ghost.out, /SPEC.md: G4 error: item #2 cites it, but it was never committed/);
  assert.doesNotMatch(ghost.out, /G3 error/);
});

test('check runs the item\'s own check command, yours by default, and prints a digest [N23]', async () => {
  const box = project();
  await fixtureAdd(box.runLocal, box.repo, 'web', 'Page', '--specs', 'G1', '--check', 'test -f web/a.html || { echo "not ok 1 - web/a.html is missing"; exit 1; }');
  await fixtureAdd(box.runLocal, box.repo, 'web', 'Loose', '--specs', 'G1');
  assert.match((await box.runLocal(box.web, 'check')).err, /NOT_HOLDING.*pullboard gate/);
  (await box.runLocal(box.web, 'claim', '1'));
  const red = (await box.runLocal(box.web, 'check', '--yes'));
  assert.equal(red.code, 1);
  assert.match(red.out, /^check red in \d+s: test -f web\/a.html/m);
  assert.match(red.out, /\n {2}not ok 1 - web\/a.html is missing\n/);
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web', 'a.html'), '<h1>Hi</h1>');
  const green = (await box.runLocal(box.web, 'check', '--yes'));
  assert.equal(green.code, 0, green.out);
  assert.match(green.out, /^check green in \d+s: test -f web\/a.html/m);
  assert.equal(withoutAction(green.out).split('\n').filter(Boolean).length, 2);
  assert.match(green.out, /timing \(test\): wall [0-9.]+s, slot wait [0-9.]+s; phases: wait [0-9.]+s, admission [0-9.]+s, setup [0-9.]+s, run [0-9.]+s, evidence [0-9.]+s; slot: .+?; per-test timing unavailable: output was not TAP or JUnit; timing profile: /);
  assert.match(green.out, /^check #1 set by coordinator \(unknown\):/);
  assert.equal((await box.runLocal(box.repo, 'check', '1')).code, 1, 'named, from another checkout: there the file is missing');
  assert.match((await box.runLocal(box.web, 'check', '2')).err, /NO_CHECK.*#2 has no check command/);
  assert.match((await box.runLocal(box.repo, 'help', '--all')).out, /pullboard check \[id\]/);
});

describe('resume journeys [I6,N21,V10,V11,S10,N23,C7]', { concurrency: true }, () => {
  for (const [name, body] of cases) it(name, body);
});
