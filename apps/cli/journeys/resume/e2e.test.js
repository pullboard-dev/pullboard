/**
 * End to end on real repos: the CLI runs as its own process, git runs the installed hooks, and
 * worktrees are real worktrees (B1–B3, B6, V3, V4, V7, L3, L4, C3, I1, I2, P2).
 */
import assert from 'node:assert/strict';
import {
  runFixtureExecFile as execFileSync,
  startFixtureChild as spawn,
  runFixtureChild as spawnSync,
} from '../../tests/fixtures/child.js';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { connect } from 'node:net';
import {
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { parseSpec } from '../../../../packages/spec/index.js';
import { checkAtCommit } from '../../../runner/index.js';
import { claudeLoopRules } from '../../../../packages/config/index.js';
import * as store from '../../../../packages/store/index.js';

import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { awaitNestedRun } from '../../../../packages/gate/index.js';
import { once } from 'node:events';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureAddRoute } from '../../tests/fixtures/testkit.js';
import { fixtureJoinRoute } from '../../tests/fixtures/testkit.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  BIN, cockpitSource, sandboxes, sandbox, CONFIG, SPEC, project, holdingGate,
  launch, waitFor, gateEvents, commitFile, attackCommit, privateCheckSubmission,
  startView, LIGHT_BRIEF,
} = e2e;

/** Assert and remove only the outer command's exact final text action; retain every body byte. */
function withoutAction(text, action = 'pullboard next --wait 1') {
  const footer = `next: ${action}\n`;
  assert.ok(text.endsWith('\n' + footer), 'the intended final action is present');
  return text.slice(0, -footer.length);
}

/** Await real production CLI dispatch without repeating cold process startup for fixture state moves. */
function fixtureCommand(box, cwd, ...args) {
  return runCliInProcess(fixtureAddRoute(fixtureJoinRoute([...args], box.env.PULLBOARD_MODEL)), { cwd, env: box.env });
}

test('init adds a Claude Code session hook that runs resume, and keeps every other setting [I6]', () => {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(join(repo, '.claude'), { recursive: true });
  box.git(repo, 'init', '-q', '-b', 'main');
  const mine = { permissions: { allow: ['Bash(npm test)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } };
  writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify(mine));
  assert.match(box.run(repo, 'init', '--verbose').out, /added a Claude Code session hook/);
  assert.match(box.run(repo, 'init', '--verbose').out, /kept the Claude Code session hook/);
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
  const card = spawnSync('sh', ['-c', command], { cwd: repo, env: box.env, encoding: 'utf8' });
  assert.equal(card.status, 0, card.stderr);
  assert.match(JSON.parse(card.stdout).hookSpecificOutput.additionalContext, /^resume: coordinator/);
  const bare = spawnSync('sh', ['-c', command], { cwd: repo, env: { ...box.env, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  assert.equal(bare.status, 0, 'without pullboard installed, the session still starts');
  assert.equal(bare.stdout, '');
});

test('the run pack names verified items that touched the same files, so a cold agent follows them [N21]', () => {
  const box = project();
  const script = (name, lines) => {
    writeFileSync(join(box.dir, name), ['#!/bin/sh', 'mkdir -p web', ...lines, ''].join('\n'));
    return `sh ${join(box.dir, name)}`;
  };
  const greet = script('greet.sh', ["echo \"export const title = 'Hi';\" > web/page.js"]);
  const follow = script('follow.sh', ['grep -q "^- #1 Greet: web/page.js$" "$PULLBOARD_PACK" && echo "export const bye = \'Bye\';" >> web/page.js']);
  fixtureAdd(box.run, box.repo, 'web', 'Greet', '--route', 'light', '--criterion', 'says Hi', '--check', 'grep -q Hi web/page.js', '--brief', LIGHT_BRIEF);
  const runner = box.run(box.repo, 'worktree', 'web', '--route', 'light').out.match(/^made (\S+) /)[1];
  assert.match(box.run(runner, 'run', '--agent-light', greet, '--attempts', '1').out, /submitted #1/);
  const firstCommit = JSON.parse(box.run(box.repo, 'show', '1', '--json').out).item_commit;
  box.git(box.web, 'merge', '-q', '--ff-only', firstCommit);
  assert.match(box.run(box.web, 'verify', '1', 'accept', '--note', 'emptied the page; the check failed').out, /verified #1/);
  // Accepted work still blocks colliding pulls until it actually lands (#1114).
  box.git(box.repo, 'merge', '-q', '--ff-only', firstCommit);
  const landed = box.run(box.repo, 'merged', '1', firstCommit);
  assert.equal(landed.code, 0, landed.err);
  fixtureAdd(box.run, box.repo, 'web', 'Say', 'bye', '--route', 'light', '--criterion', 'says Bye', '--check', 'grep -q Bye web/page.js', '--brief', LIGHT_BRIEF);
  const ran = box.run(runner, 'run', '--agent-light', follow, '--attempts', '1');
  assert.match(ran.out, /submitted #2/, ran.out);
  const packs = join(box.dir, 'repo', '.git', 'worktrees', runner.split('/').at(-1), 'pullboard', 'packs');
  assert.match(readFileSync(join(packs, '2-light-1.md'), 'utf8'), /## Finished items that touched the same files\n- #1 Greet: web\/page.js\nFollow the patterns/);
});

test('a fresh worktree with no install of its own runs pullboard from the main checkout, for git hooks and the session hook [I6]', () => {
  const box = project();
  const bare = { ...box.env, PATH: '/usr/bin:/bin' };
  const commit = () => spawnSync('git', ['commit', '-q', '-m', 'feat(web): page [G1]'], { cwd: box.web, env: bare, encoding: 'utf8' });
  const { command } = JSON.parse(readFileSync(join(box.web, '.claude', 'settings.json'), 'utf8')).hooks.SessionStart[0].hooks[0];
  const resume = () => spawnSync('sh', ['-c', command], { cwd: box.web, env: bare, encoding: 'utf8' });
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web', 'page.html'), '<h1>Hi</h1>');
  box.git(box.web, 'add', '-A');
  const refused = commit();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /pullboard is not installed/);
  assert.deepEqual([resume().status, resume().stdout], [0, ''], 'no install anywhere: the session still starts, silently');
  const bin = join(box.repo, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const committed = commit();
  assert.equal(committed.status, 0, committed.stderr);
  assert.match(JSON.parse(resume().stdout).hookSpecificOutput.additionalContext, /^resume: web-1 \(fixture-model\), web lane/);
});

test('the gate reaches the agent as a digest: one line when green, the failure when red; the whole output stays in the git dir [V10]', async () => {
  const box = project(undefined, sandbox(), { withWorktree: false });
  writeFileSync(join(box.repo, 'gate.cjs'), [
    "const red = require('node:fs').existsSync('RED');",
    "const { writeSync } = require('node:fs');",
    "for (let i = 0; i < 400; i++) writeSync(1, `ok ${i} ${'x'.repeat(red ? 10 : 3000)}\\n`);",
    "if (red) { writeSync(2, 'not ok 401 - the page renders a heading\\n'); for (let i = 0; i < 100; i++) writeSync(1, `# note ${i}\\n`); process.exitCode = 1; }",
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
  assert.match(red.out, /^gate red in \d+s:\n {2}not ok 401 - the page renders a heading\n/);
  assert.match(red.out, / {2}# note 99\n[\s\S]*the whole output is in /);
  assert.ok(red.out.length < 4000, `${red.out.length} characters`);
  const lines = readFileSync(log, 'utf8').split('\n');
  assert.equal(lines.length, 502);
  assert.equal(lines[400], 'not ok 401 - the page renders a heading', 'stdout and stderr in one stream, in order');
  const web = join(box.dir, 'digest-builder');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'web/digest', web, 'main');
  const joined = await fixtureCommand(box, web, 'join', 'web');
  assert.equal(joined.code, 0, joined.err);
  const added = await fixtureCommand(box, box.repo, 'add', 'web', 'Noisy checked work', '--specs', 'G1',
    '--criterion', 'The noisy gate passes.', '--check', 'node gate.cjs', '--wait');
  assert.equal(added.code, 0, added.err);
  const claimed = await fixtureCommand(box, web, 'claim', '1');
  assert.equal(claimed.code, 0, claimed.err);
  const built = commitFile(box, web, 'web/page.html', '<h1>Work</h1>', 'feat(web): noisy checked source [G1]');
  assert.equal(built.status, 0, built.stderr);
  const refused = await fixtureCommand(box, web, 'submit', '1', '--wait', '--no-next');
  // #1884 (b24440d3) intentionally replaced submit's raw TAP with a bounded failure summary and full run log.
  assert.equal(refused.code, 1, refused.err);
  assert.match(refused.err, /GATE_RED[\s\S]*the page renders a heading/);
  assert.ok(refused.err.trimEnd().split('\n').length < 40, 'the refusal stays bounded instead of repeating the TAP stream');
  const retained = /full log: ([^\n]+)/u.exec(refused.err);
  assert.ok(retained, 'the refusal points to its complete run log');
  const submissionLog = readFileSync(retained[1], 'utf8');
  assert.match(submissionLog, /^not ok 401 - the page renders a heading$/mu);
  assert.match(submissionLog, /^# note 99$/mu, 'the bounded refusal retains the complete noisy output');
});

test('submit refuses a bar that moved since the claim, before any verifier runs; a refreeze and a fresh claim recover [V11]', () => {
  const box = project();
  fixtureAdd(box.run, box.repo, 'web', 'Page', '--specs', 'G1', '--criterion', 'renders');
  box.run(box.web, 'claim', '1');
  writeFileSync(join(box.repo, 'SPEC.md'), SPEC.replace('The page renders.', 'The page renders a heading.'));
  assert.equal(box.run(box.repo, 'spec', 'approve', 'G1').code, 0);
  box.git(box.repo, 'commit', '-qam', 'docs: tighten G1');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  commitFile(box, box.web, 'web/a.html', '<h1>Hi</h1>', 'feat(web): page [G1]');
  const refused = box.run(box.web, 'submit', '1');
  assert.equal(refused.code, 1);
  assert.match(refused.err, /CRITERIA_CHANGED\] the spec rows #1 cites changed after it was claimed, so no verifier could judge it; the coordinator runs pullboard refreeze 1, then you claim it and submit again/);
  assert.equal(JSON.parse(box.run(box.repo, 'show', '1', '--json').out).item_status, 'claimed');
  assert.match(box.run(box.repo, 'refreeze', '1').out, /refrozen/);
  box.run(box.web, 'claim', '1');
  assert.match(box.run(box.web, 'submit', '1').out, /submitted #1/);
});

test('spec check at an older commit skips ids that items cite from a later commit; a never-committed id still fails [S10]', () => {
  const box = project();
  writeFileSync(join(box.repo, 'SPEC.md'), `${SPEC}- G3 [draft, must] The page has a footer.\n`);
  box.git(box.repo, 'commit', '-qam', 'docs(spec): a footer row');
  fixtureAdd(box.run, box.repo, 'web', 'Footer', '--specs', 'G3');
  const older = box.run(box.web, 'spec', 'check');
  assert.equal(older.code, 0, older.out);
  writeFileSync(join(box.repo, 'SPEC.md'), `${SPEC}- G3 [draft, must] The page has a footer.\n- G4 [draft, must] Not committed.\n`);
  fixtureAdd(box.run, box.repo, 'web', 'Ghost', '--specs', 'G4');
  const ghost = box.run(box.web, 'spec', 'check');
  assert.equal(ghost.code, 1);
  assert.match(ghost.out, /SPEC.md: G4 error: item #2 cites it, but it was never committed/);
  assert.doesNotMatch(ghost.out, /G3 error/);
});

test('check runs the item\'s own check command, yours by default, and prints a digest [N23]', () => {
  const box = project();
  fixtureAdd(box.run, box.repo, 'web', 'Page', '--specs', 'G1', '--check', 'test -f web/a.html || { echo "not ok 1 - web/a.html is missing"; exit 1; }');
  fixtureAdd(box.run, box.repo, 'web', 'Loose', '--specs', 'G1');
  assert.match(box.run(box.web, 'check').err, /NOT_HOLDING.*pullboard gate/);
  box.run(box.web, 'claim', '1');
  const red = box.run(box.web, 'check', '--yes');
  assert.equal(red.code, 1);
  assert.match(red.out, /^check red in \d+s: test -f web\/a.html/m);
  assert.match(red.out, /\n {2}not ok 1 - web\/a.html is missing\n/);
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web', 'a.html'), '<h1>Hi</h1>');
  const green = box.run(box.web, 'check', '--yes');
  assert.equal(green.code, 0, green.out);
  assert.match(green.out, /^check green in \d+s: test -f web\/a.html/m);
  assert.equal(withoutAction(green.out).split('\n').filter(Boolean).length, 2);
  assert.match(green.out, /timing \(test\): wall [0-9.]+s, slot wait [0-9.]+s; phases: wait [0-9.]+s, admission [0-9.]+s, setup [0-9.]+s, run [0-9.]+s, evidence [0-9.]+s; slot: .+?; per-test timing unavailable: output was not TAP or JUnit; timing profile: /);
  assert.match(green.out, /^check #1 set by coordinator \(unknown\):/);
  assert.equal(box.run(box.repo, 'check', '1').code, 1, 'named, from another checkout: there the file is missing');
  assert.match(box.run(box.web, 'check', '2').err, /NO_CHECK.*#2 has no check command/);
  assert.match(box.run(box.repo, 'help', '--all').out, /pullboard check \[id\]/);
});

test('submit leaves a dependency fast-forwarded in out of the files it records [N21]', () => {
  const box = project();
  fixtureAdd(box.run, box.repo, 'web', 'Dependency', '--specs', 'G1');
  fixtureAdd(box.run, box.repo, 'web', 'Page', '--specs', 'G1', '--after', '1');
  const second = box.run(box.repo, 'worktree', 'web').out.match(/^made (\S+) /)[1];
  box.run(box.web, 'claim', '1');
  commitFile(box, box.web, 'web/dep.html', 'dep', 'feat(web): the dependency [G1]');
  assert.equal(box.run(box.web, 'submit', '1').code, 0);
  box.git(box.repo, 'switch', '-q', '--detach', 'web/one');
  assert.match(box.run(box.repo, 'verify', '1', 'accept', '--as', 'coordinator', '--note', 'removed dep.html; the page broke').out, /verified #1/);
  box.git(box.repo, 'switch', '-q', 'main');
  box.run(second, 'claim', '2');
  box.git(second, 'merge', '-q', '--ff-only', 'web/one');
  commitFile(box, second, 'web/page.html', 'page', 'feat(web): the page [G1]');
  assert.equal(box.run(second, 'submit', '2').code, 0);
  assert.equal(JSON.parse(box.run(box.repo, 'show', '2', '--json').out).item_files, 'web/page.html');
});

test('verify and escalate take a note from a file, exactly as written [V12]', () => {
  const box = project();
  fixtureAdd(box.run, box.repo, 'web', 'Page', '--specs', 'G1');
  box.run(box.web, 'claim', '1');
  commitFile(box, box.web, 'web/a.html', 'a', 'feat(web): page [G1]');
  box.run(box.web, 'submit', '1');
  const note = 'ran `npm test` with $HOME unset: "it failed"\nthen restored it';
  writeFileSync(join(box.dir, 'note.txt'), `${note}\n`);
  box.git(box.repo, 'switch', '-q', '--detach', 'web/one');
  assert.match(box.run(box.repo, 'verify', '1', 'reject', '--reason', 'TEST_FAILURE', '--note', 'x', '--note-file', join(box.dir, 'note.txt'), '--as', 'coordinator').err, /USAGE\] give the note once/);
  assert.match(box.run(box.repo, 'verify', '1', 'reject', '--reason', 'TEST_FAILURE', '--note-file', join(box.dir, 'nope.txt'), '--as', 'coordinator').err, /NO_FILE/);
  assert.match(box.run(box.repo, 'verify', '1', 'reject', '--reason', 'TEST_FAILURE', '--clause', 'The page renders.', '--note-file', join(box.dir, 'note.txt'), '--as', 'coordinator').out, /rejected #1/);
  assert.equal(JSON.parse(box.run(box.repo, 'show', '1', '--json').out).verdicts[0].verdict_note, note);
  box.git(box.repo, 'switch', '-q', 'main');
  fixtureAdd(box.run, box.repo, 'web', 'Light', '--route', 'light', '--criterion', 'says hi', '--check', 'true', '--brief', LIGHT_BRIEF);
  const light = box.run(box.repo, 'worktree', 'web', '--route', 'light').out.match(/^made (\S+) /)[1];
  box.run(light, 'claim', '2');
  assert.match(box.run(light, 'escalate', '2', '--note-file', join(box.dir, 'note.txt')).out, /#2 escalated light -> mid/);
  assert.match(box.run(box.repo, 'show', '2').out, /ran `npm test` with \$HOME unset: "it failed"/);
  assert.match(box.run(box.repo, 'help', '--all').out, /--note-file <file>/);
});

test('the help keeps every command description apart from its usage [N37]', () => {
  const box = sandbox();
  const help = box.run(box.dir, 'help', '--all').out;
  const commandLines = help.split('\n').filter((line) => line.startsWith('  pullboard '));
  for (const line of commandLines) {
    const hasDescriptionGap = / {2,}\S/.test(line.slice('  pullboard '.length));
    const usageOnly = /(?:<[^<>]+>|\[[^\[\]]+\]|"[^"]*")$/.test(line);
    assert.ok(hasDescriptionGap || usageOnly, `command usage runs into its description: ${line}`);
  }
  const lines = help.split('\n');
  const answerLine = lines.findIndex((line) => line.startsWith('  pullboard answer '));
  const answerDescription = lines[answerLine + 1];
  assert.ok(
    answerLine >= 0 && answerDescription?.startsWith(`${' '.repeat(40)}answer your decision;`),
    'the answer description follows its usage at the description column',
  );
});

test('output into a reader that stops early ends quietly [N24]', async () => {
  const box = project(undefined, sandbox(), { withWorktree: false });
  for (let n = 0; n < 40; n++) {
    const added = await fixtureCommand(box, box.repo, 'add', 'web', `Item ${n}`, '--specs', 'G1', '--wait');
    assert.equal(added.code, 0, added.err);
  }
  const child = spawn(process.execPath, [BIN, 'list', '--all'], { cwd: box.repo, env: box.env });
  const closed = once(child, 'close');
  closed.child = child;
  child.stdout.destroy();
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await awaitNestedRun(closed);
  assert.equal(stderr, '');
  assert.equal(code, 0);
});

test('every wait pullboard suggests names its unit and fits one ten-minute tool call [N25]', async () => {
  const box = project();
  box.env.PULLBOARD_VIEW_FOREGROUND = '1';
  const view = await e2e.startView(box, box.repo);
  await view.stop();
  fixtureAdd(box.run, box.repo, 'web', 'Page', '--specs', 'G1');
  fixtureAdd(box.run, box.repo, 'web', 'Second', '--specs', 'G1', '--after', '1');
  box.run(box.web, 'claim', '1');
  commitFile(box, box.web, 'web/a.html', 'a', 'feat(web): page [G1]');
  box.run(box.web, 'submit', '1');
  assert.match(box.run(box.web, 'next').err, /To keep looking: pullboard next --wait 9 \(minutes; give the command a ten-minute timeout\)/);
  assert.match(box.run(box.web, 'resume').out, /next: pullboard next --wait 9 \(minutes\); 1 in your lane waits on other work/);
  box.run(box.repo, 'hold', 'web', '--reason', 'G1 is changing');
  assert.match(box.run(box.web, 'resume').out, /next: pullboard next --wait 9 \(minutes\); the lane hold must lift/);
  const agents = readFileSync(join(box.repo, 'AGENTS.md'), 'utf8');
  assert.match(agents, /`pullboard next --wait 9` keeps looking for up to 9 minutes, which fits one tool call with a ten-minute timeout/);
  assert.doesNotMatch(agents, /--wait 30/);
});

test('submit names the item and the way out when a cited row was retired after the claim [V11]', async () => {
  const box = project(undefined, sandbox(), { withWorktree: false });
  box.web = join(box.dir, 'web-1');
  box.git(box.repo, 'worktree', 'add', '-q', box.web, '-b', 'web/one');
  const joined = await fixtureCommand(box, box.web, 'join', 'web');
  assert.equal(joined.code, 0, joined.err);
  assert.match(joined.out, /joined as web-1/);
  const added = await fixtureCommand(box, box.repo, 'add', 'web', 'Page', '--specs', 'G1', '--wait');
  assert.equal(added.code, 0, added.err);
  const claimed = await fixtureCommand(box, box.web, 'claim', '1');
  assert.equal(claimed.code, 0, claimed.err);
  const built = commitFile(box, box.web, 'web/a.html', 'a', 'feat(web): page [G1]');
  assert.equal(built.status, 0, built.stderr);
  writeFileSync(join(box.repo, 'SPEC.md'), SPEC.replace('- G1 [approved, must] The page renders. | gate: web test', '- G1 [retired] The page renders.'));
  box.git(box.repo, 'commit', '-qam', 'docs(spec): retire G1');
  box.git(box.web, 'merge', '-q', '--no-edit', 'main');
  const refused = await fixtureCommand(box, box.web, 'submit', '1', '--wait', '--no-next');
  assert.equal(refused.code, 1);
  assert.match(refused.err, /CRITERIA_CHANGED\] the spec rows #1 cites changed after it was claimed \(G1 is retired\), so no verifier could judge it; the coordinator either restores the row and runs pullboard refreeze 1, or withdraws #1/);
  assert.equal(JSON.parse((await fixtureCommand(box, box.repo, 'show', '1', '--json')).out).item_status, 'claimed');
});

test('worktree prints the opening lines of a subagent\'s prompt, with its folder and identity [I7]', async () => {
  const box = sandbox();
  const repo = join(box.dir, "my app's $PULLBOARD_PATH_PROBE");
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  const initialized = await fixtureCommand(box, repo, 'init');
  assert.equal(initialized.code, 0, initialized.err);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify(CONFIG, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up pullboard');
  const created = await fixtureCommand(box, repo, 'worktree', 'web');
  assert.equal(created.code, 0, created.err);
  const made = created.out;
  const folder = join(box.dir, "my app's $PULLBOARD_PATH_PROBE-web-1");
  const quoted = `'${folder.replaceAll("'", "'\\''")}'`;
  assert.match(made, /For a subagent working here, begin its prompt with:\n/);
  assert.ok(made.includes(`  You are web-1 (fixture-model), in the web lane. Work only in ${quoted}, and start every command with cd ${quoted} &&\n`), made);
  assert.ok(made.includes(`  Read '${folder.replaceAll("'", "'\\''")}/AGENTS.md' first. Its rules govern this work, over any other repo's instructions you were given.\n`), made);
  // Pasted into a shell as printed, the line enters the real folder: nothing in the path expands.
  const cdLine = /start every command with (cd .+ &&)\n/.exec(made)[1];
  const entered = spawnSync('sh', ['-c', `${cdLine} pwd`], { env: { ...box.env, PULLBOARD_PATH_PROBE: 'elsewhere' }, encoding: 'utf8' });
  assert.equal(entered.stdout.trim(), folder);
});

/**
 * Start `pullboard view` in a folder and read the link it prints; stop() ends it.
 */
