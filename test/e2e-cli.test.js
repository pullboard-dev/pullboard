/**
 * End to end on real repos: the CLI runs as its own process, git runs the installed hooks, and
 * worktrees are real worktrees (B1–B3, B6, V3, V4, V7, L3, L4, C3, I1, I2, P2).
 */
import assert from 'node:assert/strict';
import { runFixtureExecFile as execFileSync, startFixtureChild as spawn, runFixtureChild as spawnSync } from './fixture-child.js';
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
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { parseSpec } from '../src/spec.js';
import { checkAtCommit } from '../src/trusted-policy.js';
import * as store from '../src/board.js';

import { createE2eHelpers } from './e2e-helpers.js';
import { fetchFresh } from './http-fixture.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  BIN, cockpitSource, sandboxes, sandbox, CONFIG, SPEC, project, holdingGate,
  launch, waitFor, gateEvents, commitFile, attackCommit, privateCheckSubmission,
  startView, LIGHT_BRIEF,
} = e2e;

test('init adds a Claude Code session hook that runs resume, and keeps every other setting [I6]', () => {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(join(repo, '.claude'), { recursive: true });
  box.git(repo, 'init', '-q', '-b', 'main');
  const mine = { permissions: { allow: ['Bash(npm test)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } };
  writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify(mine));
  assert.match(box.run(repo, 'init').out, /added a Claude Code session hook/);
  assert.match(box.run(repo, 'init').out, /kept the Claude Code session hook/);
  const settings = JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(settings.permissions, mine.permissions);
  assert.deepEqual(settings.hooks.Stop, mine.hooks.Stop);
  assert.equal(settings.hooks.SessionStart.length, 1);
  const { command } = settings.hooks.SessionStart[0].hooks[0];
  const card = spawnSync('sh', ['-c', command], { cwd: repo, env: box.env, encoding: 'utf8' });
  assert.equal(card.status, 0, card.stderr);
  assert.match(card.stdout, /^resume: coordinator/);
  const bare = spawnSync('sh', ['-c', command], { cwd: repo, env: { ...box.env, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  assert.equal(bare.status, 0, 'without pullboard installed, the session still starts');
  assert.equal(bare.stdout, '');
});

test('the tour runs a reject and its rework on a throwaway repo, in under thirty seconds [N10]', () => {
  const box = sandbox();
  const plainEnv = { ...box.env, TMPDIR: box.dir };
  delete plainEnv.NO_COLOR;
  delete plainEnv.FORCE_COLOR;
  const started = Date.now();
  const shown = spawnSync(process.execPath, [BIN, 'tour'], { cwd: box.dir, env: plainEnv, encoding: 'utf8' });
  assert.equal(shown.status, 0, `${shown.stdout}${shown.stderr}`);
  assert.ok(Date.now() - started < 30_000, 'thirty seconds');
  assert.doesNotMatch(shown.stdout, /\u001b\[/, 'piped output stays plain');
  assert.match(shown.stdout, /review-1 \(Scripted\) \$ pullboard verify 1 reject --reason BEHAVIOR_MISMATCH/);
  assert.match(shown.stdout, /sent back: #1 BEHAVIOR_MISMATCH by review-1 \(Scripted\): greet\(''\) returns "Hello, !"/);
  assert.match(shown.stdout, /with the fix removed\n {7}# pass 1\n {7}# fail 1/);
  assert.match(shown.stdout, /verified #1: CRITERION_MET/);
  assert.match(shown.stdout, /\| 1 \| app \| Greeting \| G1 \| app-1 \(Scripted\) \| review-1 \(Scripted\) \|/);

  const forced = spawnSync(process.execPath, [BIN, 'tour'], { cwd: box.dir, env: { ...plainEnv, FORCE_COLOR: '1' }, encoding: 'utf8' });
  assert.equal(forced.status, 0, `${forced.stdout}${forced.stderr}`);
  assert.match(forced.stdout, /\u001b\[1m1  The person approved one spec row\. The coordinator files it as work\.\u001b\[0m/);
  assert.match(forced.stdout, /\u001b\[36mcoordinator \(unknown\)\u001b\[0m \$/);
  assert.match(forced.stdout, /\u001b\[33mapp-1 \(Scripted\)\u001b\[0m \$/);
  assert.match(forced.stdout, /\u001b\[35mreview-1 \(Scripted\)\u001b\[0m \$/);
  assert.match(forced.stdout, /\u001b\[31m[^\n]*rejected #1/);
  assert.match(forced.stdout, /\u001b\[31m[^\n]*# fail 1/);
  assert.match(forced.stdout, /\u001b\[32m[^\n]*verified #1: CRITERION_MET/);
  assert.match(forced.stdout, /\u001b\[32m[^\n]*# pass 2/);

  const noColor = spawnSync(process.execPath, [BIN, 'tour'], { cwd: box.dir, env: { ...plainEnv, FORCE_COLOR: '1', NO_COLOR: '1' }, encoding: 'utf8' });
  assert.equal(noColor.status, 0, `${noColor.stdout}${noColor.stderr}`);
  assert.doesNotMatch(noColor.stdout, /\u001b\[/, 'NO_COLOR wins even if the environment could otherwise force color');
  const normalizeTourRoot = (text) => text
    .replace(/Look around: cd .* && pullboard log/, 'Look around: cd <tour> && pullboard log')
    .replace(/\b[0-9a-f]{12}\b/g, '<sha>')
    .replace(/claimed #1 until \S+ criterion frozen/g, 'claimed #1 until <time> criterion frozen')
    // A gate's rounded wall time is not output NO_COLOR could change, so a slower gate must still compare equal.
    .replace(/gate (green|red) in \d+s/g, 'gate $1 in <n>s')
    .replace(/\b(wall|slot wait) [0-9.]+s/g, '$1 <n>s');
  assert.equal(normalizeTourRoot(noColor.stdout), normalizeTourRoot(shown.stdout), 'NO_COLOR preserves the plain tour output');

  const repo = /Look around: cd (\S+) && pullboard log/.exec(shown.stdout)[1];
  assert.match(box.git(repo, 'log', '--format=%an %s', '-1'), /^app-1 fix\(app\): a blank name greets the world \[G1\]$/);
  const hooks = join(box.dir, 'ambient-hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\necho ambient hook ran >&2\nexit 1\n');
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  const ambient = { ...plainEnv, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooks, GIT_DIR: join(box.dir, 'elsewhere.git') };
  const isolated = spawnSync(process.execPath, [BIN, 'tour'], { cwd: box.dir, env: ambient, encoding: 'utf8' });
  assert.equal(isolated.status, 0, `git settings from the environment stay out: ${isolated.stdout}`);
  const empty = join(box.dir, 'empty');
  mkdirSync(empty);
  const stopped = spawnSync(process.execPath, [BIN, 'tour'], { cwd: box.dir, env: { ...plainEnv, PATH: empty }, encoding: 'utf8' });
  assert.equal(stopped.status, 1);
  assert.match(stopped.stdout, /The tour stopped: git init -q -b main exited null/);
});

test('the tour registers a labelled demo that view lists and forget removes [N10, N26]', async () => {
  const box = project();
  const tourEnv = { ...box.env, TMPDIR: box.dir, HOME: box.dir };
  delete tourEnv.PULLBOARD_MODEL;
  const result = spawnSync(process.execPath, [BIN, 'tour'], {
    cwd: box.dir,
    env: tourEnv,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.stdout.trimEnd().split('\n').at(-1), 'see it: pullboard view');
  const demoRoot = /Look around: cd (\S+) && pullboard log/.exec(result.stdout)?.[1];
  assert.ok(demoRoot, 'the retained demo path is printed');
  const registered = JSON.parse(readFileSync(join(box.env.PULLBOARD_HOME, 'projects.json'), 'utf8')).projects;
  assert.deepEqual(registered.map(({ root, name }) => [root, name]), [[box.repo, 'repo'], [demoRoot, 'demo']]);

  const view = await startView(box, box.repo);
  try {
    const listing = await fetchFresh(`${view.base}/api/v1/boards`, { headers: { 'x-pullboard-key': view.key } });
    assert.equal(listing.status, 200);
    assert.deepEqual((await listing.json()).boards.map(({ root, name }) => [root, name]), [[box.repo, 'repo'], [demoRoot, 'demo']]);
    const forgotten = box.run(box.dir, 'forget', demoRoot);
    assert.equal(forgotten.code, 0, forgotten.err);
    assert.match(forgotten.out, /forgot/);
    const after = await fetchFresh(`${view.base}/api/v1/boards`, { headers: { 'x-pullboard-key': view.key } });
    assert.deepEqual((await after.json()).boards.map(({ root, name }) => [root, name]), [[box.repo, 'repo']]);
  } finally {
    await view.stop();
  }
});

test('the run pack names verified items that touched the same files, so a cold agent follows them [N21]', () => {
  const box = project();
  const script = (name, lines) => {
    writeFileSync(join(box.dir, name), ['#!/bin/sh', 'mkdir -p web', ...lines, ''].join('\n'));
    return `sh ${join(box.dir, name)}`;
  };
  const greet = script('greet.sh', ["echo \"export const title = 'Hi';\" > web/page.js"]);
  const follow = script('follow.sh', ['grep -q "^- #1 Greet: web/page.js$" "$PULLBOARD_PACK" && echo "export const bye = \'Bye\';" >> web/page.js']);
  box.run(box.repo, 'add', 'web', 'Greet', '--route', 'light', '--criterion', 'says Hi', '--check', 'grep -q Hi web/page.js', '--brief', LIGHT_BRIEF);
  const runner = box.run(box.repo, 'worktree', 'web', '--route', 'light').out.match(/^made (\S+) /)[1];
  assert.match(box.run(runner, 'run', '--agent-light', greet, '--attempts', '1').out, /submitted #1/);
  box.git(box.web, 'merge', '-q', '--ff-only', JSON.parse(box.run(box.repo, 'show', '1', '--json').out).item_commit);
  assert.match(box.run(box.web, 'verify', '1', 'accept', '--note', 'emptied the page; the check failed').out, /verified #1/);
  box.run(box.repo, 'add', 'web', 'Say', 'bye', '--route', 'light', '--criterion', 'says Bye', '--check', 'grep -q Bye web/page.js', '--brief', LIGHT_BRIEF);
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
  assert.match(resume().stdout, /^resume: web-1 \(Test Model\), web lane/);
});

test('the gate reaches the agent as a digest: one line when green, the failure when red; the whole output stays in the git dir [V10]', () => {
  const box = project();
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
  const green = box.run(box.repo, 'gate');
  assert.equal(green.code, 0, green.err);
  assert.match(green.out, /^gate green in \d+s; timing \(node\): wall [0-9.]+s, slot wait [0-9.]+s; per-test timing unavailable: output was not TAP or JUnit; timing profile: [^\n]+\n$/);
  assert.equal(green.out.trimEnd().split('\n').length, 1, 'a green gate without file measurements remains one line');
  assert.ok(readFileSync(log, 'utf8').length > 1_200_000, 'more than the default 1 MB pipe buffer, read whole');
  writeFileSync(join(box.repo, 'RED'), 'red');
  box.git(box.repo, 'add', 'RED');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: turn the gate red');
  const red = box.run(box.repo, 'gate');
  assert.equal(red.code, 1);
  assert.match(red.out, /^gate red in \d+s:\n {2}not ok 401 - the page renders a heading\n/);
  assert.match(red.out, / {2}# note 99\n[\s\S]*the whole output is in /);
  assert.ok(red.out.length < 4000, `${red.out.length} characters`);
  const lines = readFileSync(log, 'utf8').split('\n');
  assert.equal(lines.length, 502);
  assert.equal(lines[400], 'not ok 401 - the page renders a heading', 'stdout and stderr in one stream, in order');
  box.run(box.repo, 'add', 'coordinator', 'Coordinator work');
  box.run(box.repo, 'claim', '1');
  assert.match(box.run(box.repo, 'submit', '1').err, /GATE_RED[\s\S]*not ok 401 - the page renders a heading/);
});

test('submit refuses a bar that moved since the claim, before any verifier runs; a refreeze and a fresh claim recover [V11]', () => {
  const box = project();
  box.run(box.repo, 'add', 'web', 'Page', '--specs', 'G1', '--criterion', 'renders');
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
  box.run(box.repo, 'add', 'web', 'Footer', '--specs', 'G3');
  const older = box.run(box.web, 'spec', 'check');
  assert.equal(older.code, 0, older.out);
  writeFileSync(join(box.repo, 'SPEC.md'), `${SPEC}- G3 [draft, must] The page has a footer.\n- G4 [draft, must] Not committed.\n`);
  box.run(box.repo, 'add', 'web', 'Ghost', '--specs', 'G4');
  const ghost = box.run(box.web, 'spec', 'check');
  assert.equal(ghost.code, 1);
  assert.match(ghost.out, /SPEC.md: G4 error: item #2 cites it, but it was never committed/);
  assert.doesNotMatch(ghost.out, /G3 error/);
});

test('check runs the item\'s own check command, yours by default, and prints a digest [N23]', () => {
  const box = project();
  box.run(box.repo, 'add', 'web', 'Page', '--specs', 'G1', '--check', 'test -f web/a.html || { echo "not ok 1 - web/a.html is missing"; exit 1; }');
  box.run(box.repo, 'add', 'web', 'Loose', '--specs', 'G1');
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
  assert.equal(green.out.split('\n').filter(Boolean).length, 2);
  assert.match(green.out, /timing \(test\): wall [0-9.]+s, slot wait [0-9.]+s; per-test timing unavailable: output was not TAP or JUnit; timing profile: /);
  assert.match(green.out, /^check #1 set by coordinator \(unknown\):/);
  assert.equal(box.run(box.repo, 'check', '1').code, 1, 'named, from another checkout: there the file is missing');
  assert.match(box.run(box.web, 'check', '2').err, /NO_CHECK.*#2 has no check command/);
  assert.match(box.run(box.repo, 'help', '--all').out, /pullboard check \[id\]/);
});

test('submit leaves a dependency fast-forwarded in out of the files it records [N21]', () => {
  const box = project();
  box.run(box.repo, 'add', 'web', 'Dependency', '--specs', 'G1');
  box.run(box.repo, 'add', 'web', 'Page', '--specs', 'G1', '--after', '1');
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
  box.run(box.repo, 'add', 'web', 'Page', '--specs', 'G1');
  box.run(box.web, 'claim', '1');
  commitFile(box, box.web, 'web/a.html', 'a', 'feat(web): page [G1]');
  box.run(box.web, 'submit', '1');
  const note = 'ran `npm test` with $HOME unset: "it failed"\nthen restored it';
  writeFileSync(join(box.dir, 'note.txt'), `${note}\n`);
  box.git(box.repo, 'switch', '-q', '--detach', 'web/one');
  assert.match(box.run(box.repo, 'verify', '1', 'reject', '--reason', 'TEST_FAILURE', '--note', 'x', '--note-file', join(box.dir, 'note.txt'), '--as', 'coordinator').err, /USAGE\] give the note once/);
  assert.match(box.run(box.repo, 'verify', '1', 'reject', '--reason', 'TEST_FAILURE', '--note-file', join(box.dir, 'nope.txt'), '--as', 'coordinator').err, /NO_FILE/);
  assert.match(box.run(box.repo, 'verify', '1', 'reject', '--reason', 'TEST_FAILURE', '--note-file', join(box.dir, 'note.txt'), '--as', 'coordinator').out, /rejected #1/);
  assert.equal(JSON.parse(box.run(box.repo, 'show', '1', '--json').out).verdicts[0].verdict_note, note);
  box.git(box.repo, 'switch', '-q', 'main');
  box.run(box.repo, 'add', 'web', 'Light', '--route', 'light', '--criterion', 'says hi', '--check', 'true', '--brief', LIGHT_BRIEF);
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
  const box = project();
  for (let n = 0; n < 40; n++) box.run(box.repo, 'add', 'web', `Item ${n}`, '--specs', 'G1');
  const child = spawn(process.execPath, [BIN, 'list', '--all'], { cwd: box.repo, env: box.env });
  child.stdout.destroy();
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((done) => child.on('close', done));
  assert.equal(stderr, '');
  assert.equal(code, 0);
});

test('every wait pullboard suggests names its unit and fits one ten-minute tool call [N25]', () => {
  const box = project();
  box.run(box.repo, 'add', 'web', 'Page', '--specs', 'G1');
  box.run(box.repo, 'add', 'web', 'Second', '--specs', 'G1', '--after', '1');
  box.run(box.web, 'claim', '1');
  commitFile(box, box.web, 'web/a.html', 'a', 'feat(web): page [G1]');
  box.run(box.web, 'submit', '1');
  assert.match(box.run(box.web, 'next').err, /To keep looking: pullboard next --wait 9 \(minutes; give the command a ten-minute timeout\)/);
  assert.match(box.run(box.web, 'resume').out, /next: pullboard next --wait 9 \(minutes\); 1 in your lane waits on other work/);
  box.run(box.repo, 'hold', 'web', '--reason', 'G1 is changing');
  assert.match(box.run(box.web, 'resume').out, /next: wait for the hold to lift: pullboard next --wait 9 \(minutes\)/);
  const agents = readFileSync(join(box.repo, 'AGENTS.md'), 'utf8');
  assert.match(agents, /`pullboard next --wait 9` keeps looking for up to 9 minutes, which fits one tool call with a ten-minute timeout/);
  assert.doesNotMatch(agents, /--wait 30/);
});

test('submit names the item and the way out when a cited row was retired after the claim [V11]', () => {
  const box = project();
  box.run(box.repo, 'add', 'web', 'Page', '--specs', 'G1');
  box.run(box.web, 'claim', '1');
  writeFileSync(join(box.repo, 'SPEC.md'), SPEC.replace('- G1 [approved, must] The page renders. | gate: web test', '- G1 [retired] The page renders.'));
  box.git(box.repo, 'commit', '-qam', 'docs(spec): retire G1');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  commitFile(box, box.web, 'web/a.html', 'a', 'feat(web): page');
  const refused = box.run(box.web, 'submit', '1');
  assert.equal(refused.code, 1);
  assert.match(refused.err, /CRITERIA_CHANGED\] the spec rows #1 cites changed after it was claimed \(G1 is retired\), so no verifier could judge it; the coordinator either restores the row and runs pullboard refreeze 1, or withdraws #1/);
  assert.equal(JSON.parse(box.run(box.repo, 'show', '1', '--json').out).item_status, 'claimed');
});

test('worktree prints the opening lines of a subagent\'s prompt, with its folder and identity [I7]', () => {
  const box = sandbox();
  const repo = join(box.dir, "my app's $PULLBOARD_PATH_PROBE");
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  box.run(repo, 'init');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify(CONFIG, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up pullboard');
  const made = box.run(repo, 'worktree', 'web').out;
  const folder = join(box.dir, "my app's $PULLBOARD_PATH_PROBE-web-1");
  const quoted = `'${folder.replaceAll("'", "'\\''")}'`;
  assert.match(made, /For a subagent working here, begin its prompt with:\n/);
  assert.ok(made.includes(`  You are web-1 (Test Model), in the web lane. Work only in ${quoted}, and start every command with cd ${quoted} &&\n`), made);
  assert.ok(made.includes(`  Read '${folder.replaceAll("'", "'\\''")}/AGENTS.md' first. Its rules govern this work, over any other repo's instructions you were given.\n`), made);
  // Pasted into a shell as printed, the line enters the real folder: nothing in the path expands.
  const cdLine = /start every command with (cd .+ &&)\n/.exec(made)[1];
  const entered = spawnSync('sh', ['-c', `${cdLine} pwd`], { env: { ...box.env, PULLBOARD_PATH_PROBE: 'elsewhere' }, encoding: 'utf8' });
  assert.equal(entered.stdout.trim(), folder);
});

/**
 * Start `pullboard view` in a folder and read the link it prints; stop() ends it.
 */
