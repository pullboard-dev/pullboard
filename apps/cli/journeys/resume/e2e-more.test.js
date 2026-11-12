/**
 * End to end on real repos, second half: the CLI runs as its own process, git runs the installed hooks, and
 * worktrees are real worktrees (B1–B3, B6, V3, V4, V7, L3, L4, C3, I1, I2, P2).
 */
import assert from 'node:assert/strict';
import {
  startFixtureChild as spawn,
  runFixtureChild as spawnSync,
} from '../../tests/fixtures/child.js';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';

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
  BIN, sandbox, CONFIG, SPEC, project, commitFile, startView, LIGHT_BRIEF,
} = e2e;

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

test('submit leaves a dependency fast-forwarded in out of the files it records [N21]', async () => {
  const box = project();
  await fixtureAdd(box.runLocal, box.repo, 'web', 'Dependency', '--specs', 'G1');
  await fixtureAdd(box.runLocal, box.repo, 'web', 'Page', '--specs', 'G1', '--after', '1');
  const second = (await box.runLocal(box.repo, 'worktree', 'web')).out.match(/^made (\S+) /)[1];
  (await box.runLocal(box.web, 'claim', '1'));
  commitFile(box, box.web, 'web/dep.html', 'dep', 'feat(web): the dependency [G1]');
  assert.equal((await box.runLocal(box.web, 'submit', '1')).code, 0);
  box.git(box.repo, 'switch', '-q', '--detach', 'web/one');
  assert.match((await box.runLocal(box.repo, 'verify', '1', 'accept', '--as', 'coordinator', '--note', 'removed dep.html; the page broke')).out, /verified #1/);
  box.git(box.repo, 'switch', '-q', 'main');
  (await box.runLocal(second, 'claim', '2'));
  box.git(second, 'merge', '-q', '--ff-only', 'web/one');
  commitFile(box, second, 'web/page.html', 'page', 'feat(web): the page [G1]');
  assert.equal((await box.runLocal(second, 'submit', '2')).code, 0);
  assert.equal(JSON.parse((await box.runLocal(box.repo, 'show', '2', '--json')).out).item_files, 'web/page.html');
});

test('verify and escalate take a note from a file, exactly as written [V12]', async () => {
  const box = project();
  await fixtureAdd(box.runLocal, box.repo, 'web', 'Page', '--specs', 'G1');
  (await box.runLocal(box.web, 'claim', '1'));
  commitFile(box, box.web, 'web/a.html', 'a', 'feat(web): page [G1]');
  (await box.runLocal(box.web, 'submit', '1'));
  const note = 'ran `npm test` with $HOME unset: "it failed"\nthen restored it';
  writeFileSync(join(box.dir, 'note.txt'), `${note}\n`);
  box.git(box.repo, 'switch', '-q', '--detach', 'web/one');
  assert.match((await box.runLocal(box.repo, 'verify', '1', 'reject', '--reason', 'TEST_FAILURE', '--note', 'x', '--note-file', join(box.dir, 'note.txt'), '--as', 'coordinator')).err, /USAGE\] give the note once/);
  assert.match((await box.runLocal(box.repo, 'verify', '1', 'reject', '--reason', 'TEST_FAILURE', '--note-file', join(box.dir, 'nope.txt'), '--as', 'coordinator')).err, /NO_FILE/);
  assert.match((await box.runLocal(box.repo, 'verify', '1', 'reject', '--reason', 'TEST_FAILURE', '--clause', 'The page renders.', '--note-file', join(box.dir, 'note.txt'), '--as', 'coordinator')).out, /rejected #1/);
  assert.equal(JSON.parse((await box.runLocal(box.repo, 'show', '1', '--json')).out).verdicts[0].verdict_note, note);
  box.git(box.repo, 'switch', '-q', 'main');
  await addDiagnosedLight(box, 'Light', '--route', 'mid', '--criterion', 'says hi', '--check', 'true', '--brief', LIGHT_BRIEF);
  const light = (await box.runLocal(box.repo, 'worktree', 'web', '--route', 'light')).out.match(/^made (\S+) /)[1];
  (await box.runLocal(light, 'claim', '2'));
  assert.match((await box.runLocal(light, 'escalate', '2', '--note-file', join(box.dir, 'note.txt'))).out, /#2 escalated light -> mid/);
  assert.match((await box.runLocal(box.repo, 'show', '2')).out, /ran `npm test` with \$HOME unset: "it failed"/);
  assert.match((await box.runLocal(box.repo, 'help', '--all')).out, /--note-file <file>/);
});

test('the help keeps every command description apart from its usage [N37]', async () => {
  const box = sandbox();
  const help = (await box.runLocal(box.dir, 'help', '--all')).out;
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
  // Process-level: a real child whose stdout closes early proves a broken pipe ends quietly.
  const child = spawn(process.execPath, [BIN, 'list', '--all'], { cwd: box.repo, env: box.env });
  const closed = once(child, 'close');
  closed.child = child;
  child.stdout.destroy();
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = awaitNestedRun(closed);
  assert.equal(stderr, '');
  assert.equal(code, 0);
});

test('pullboard suggests no timed wait: next steps end at work or end-your-turn [N25]', async () => {
  const box = project();
  box.env.PULLBOARD_VIEW_FOREGROUND = '1';
  const view = await e2e.startView(box, box.repo);
  await view.stop();
  await fixtureAdd(box.runLocal, box.repo, 'web', 'Page', '--specs', 'G1');
  await fixtureAdd(box.runLocal, box.repo, 'web', 'Second', '--specs', 'G1', '--after', '1');
  (await box.runLocal(box.web, 'claim', '1'));
  commitFile(box, box.web, 'web/a.html', 'a', 'feat(web): page [G1]');
  (await box.runLocal(box.web, 'submit', '1'));
  const idle = (await box.runLocal(box.web, 'next'));
  assert.match(idle.out, /nothing for this seat: end your turn/, JSON.stringify(idle));
  assert.doesNotMatch(idle.out + idle.err, /--wait/);
  assert.match((await box.runLocal(box.web, 'resume')).out, /next: pullboard next; take another eligible review or other offered work, or end your turn if none is offered/);
  (await box.runLocal(box.repo, 'hold', 'web', '--reason', 'G1 is changing'));
  assert.match((await box.runLocal(box.web, 'resume')).out, /next: pullboard next; take work in another lane, or end your turn if none is offered/);
  const agents = readFileSync(join(box.repo, 'AGENTS.md'), 'utf8');
  assert.match(agents, /If it prints "nothing for this seat: end your turn", end your turn/);
  assert.doesNotMatch(agents, /--wait 9/);
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
