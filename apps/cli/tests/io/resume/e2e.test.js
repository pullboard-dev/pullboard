/**
 * End to end on real repos: the CLI runs as its own process, git runs the installed hooks, and
 * worktrees are real worktrees (B1–B3, B6, V3, V4, V7, L3, L4, C3, I1, I2, P2).
 */
import assert from 'node:assert/strict';
import {
  runFixtureChildAsync as spawnChild,
} from '../../fixtures/child.js';
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
import { claudeLoopRules } from '../../../../../packages/config/index.js';

import { createE2eHelpers } from '../../fixtures/e2e.js';
import { runCliInProcess } from '../../fixtures/process.js';
import { fixtureAdd } from '../../fixtures/testkit.js';
/** Cases are collected, then run concurrently: each owns its sandbox, repo and machine home, so they overlap their waits instead of adding them [C7]. */
const cases = [];
/** Register one case; it runs inside the concurrent suite at the end of this file. */
const test = (name, body) => cases.push([name, body]);

const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  BIN, sandbox, SPEC,
} = e2e;

const { project } = e2e;

/** Assert and remove only the outer command's exact final text action; retain every body byte. */
function withoutAction(text, action = 'pullboard next') {
  const footer = `next: ${action}\n`;
  assert.ok(text.endsWith('\n' + footer), 'the intended final action is present');
  return text.slice(0, -footer.length);
}

test('cli.journeys-resume-e2e.init-adds-a-claude-code-session: init adds a Claude Code session hook that runs resume, and keeps every other setting [I6]', async () => {
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
  // nothing else in permissions changes. apps/cli/tests/io/init/permissions.test.js owns the exact rule list.
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

test('cli.journeys-resume-e2e.a-fresh-worktree-with-no-install: a fresh worktree with no install of its own runs pullboard from the main checkout, for git hooks and the session hook [I6]', async () => {
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

test('cli.journeys-resume-e2e.spec-check-at-an-older-commit: spec check at an older commit skips ids that items cite from a later commit; a never-committed id still fails [S10]', async () => {
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

test('cli.journeys-resume-e2e.check-runs-the-item-s-own: check runs the item\'s own check command, yours by default, and prints a digest [N23]', async () => {
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

describe('resume journeys [I6,S10,N23,C7]', { concurrency: true }, () => {
  for (const [name, body] of cases) it(name, body);
});
