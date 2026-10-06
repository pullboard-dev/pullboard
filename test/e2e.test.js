/**
 * End to end on real repos: the CLI runs as its own process, git runs the installed hooks, and
 * worktrees are real worktrees (B1–B3, B6, V3, V4, V7, L3, L4, C3, I1, I2, P2).
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const sandboxes = [];

after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/**
 * A scratch directory with a `pullboard` shim on the PATH, so the hooks git runs find the CLI, and
 * git isolated from the machine's own config.
 */
function sandbox() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-e2e-')));
  sandboxes.push(dir);
  const shims = join(dir, 'bin');
  mkdirSync(shims);
  writeFileSync(join(shims, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  chmodSync(join(shims, 'pullboard'), 0o755);
  const env = {
    ...process.env,
    PATH: `${shims}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent',
    GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent',
    GIT_COMMITTER_EMAIL: 'agent@example.com',
  };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  const tryGit = (cwd, ...args) => spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  const run = (cwd, ...args) => {
    const result = spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
    return { code: result.status, out: result.stdout, err: result.stderr };
  };
  return { dir, env, git, tryGit, run };
}

const CONFIG = {
  gate: 'test ! -f RED',
  spec: 'SPEC.md',
  verify: 'any',
  lease: '2h',
  lanes: { web: { owns: ['web/'], specs: ['G1'] }, api: { owns: ['api/'], specs: ['G2'] } },
  shared: ['docs/'],
};

const SPEC = `# Demo spec

## G · Goals
- G1 [approved, must] The page renders. | gate: web test
- G2 [approved, must] The API answers. | gate: api test
`;

/**
 * A repo set up with pullboard, two lanes and a spec, committed through its own hooks, plus a
 * worktree joined to the web lane.
 */
function project() {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  assert.equal(box.run(repo, 'init').code, 0);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify(CONFIG, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up pullboard');
  const web = join(box.dir, 'web-1');
  box.git(repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  assert.match(box.run(web, 'join', 'web').out, /joined as web-1/);
  return { ...box, repo, web };
}

/**
 * Write a file in a worktree and commit it, returning git's result so a refusal can be read.
 */
function commitFile(box, cwd, path, text, message) {
  mkdirSync(join(cwd, path, '..'), { recursive: true });
  writeFileSync(join(cwd, path), text);
  box.git(cwd, 'add', '-A');
  return box.tryGit(cwd, 'commit', '-q', '-m', message);
}

test('init writes config, spec, agent docs and hooks once, and never clobbers [I1, I2]', () => {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'AGENTS.md'), '# Mine\n\nkeep me\n');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const first = box.run(repo, 'init');
  assert.equal(first.code, 0);
  assert.match(first.out, /added the pullboard section to AGENTS.md/);
  assert.equal(JSON.parse(readFileSync(join(repo, 'pullboard.json'), 'utf8')).gate, 'npm test');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ ...CONFIG, gate: 'mine' }));
  const second = box.run(repo, 'init');
  assert.match(second.out, /kept pullboard.json/);
  assert.doesNotMatch(second.out, /no gate yet/, 'the config already names a gate');
  assert.equal(JSON.parse(readFileSync(join(repo, 'pullboard.json'), 'utf8')).gate, 'mine');
  const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
  assert.ok(agents.startsWith('# Mine\n\nkeep me\n'));
  assert.equal(agents.split('<!-- pullboard:start -->').length, 2);
  assert.equal(readFileSync(join(repo, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
  assert.equal(box.git(repo, 'config', '--get', 'core.hooksPath'), '.githooks');
  for (const hook of ['pre-commit', 'commit-msg', 'pre-push']) assert.ok(existsSync(join(repo, '.githooks', hook)));
  assert.ok(readFileSync(join(repo, 'PRACTICE.md'), 'utf8').startsWith('# Practice'));
  assert.ok(existsSync(join(repo, '.claude', 'skills', 'pullboard-decompose', 'SKILL.md')));
  assert.match(second.out, /kept PRACTICE.md/);
  assert.match(second.out, /kept the Claude Code skills/);
});

test('spec check lints both files; spec view writes one page into the git dir [S6, S7]', () => {
  const box = project();
  writeFileSync(join(box.repo, 'PRACTICE.md'), '# Practice\n\n## C · Code\n- C1 [approved, must] Functions under 60 lines.\n');
  const check = box.run(box.repo, 'spec', 'check');
  assert.equal(check.code, 1);
  assert.match(check.out, /PRACTICE.md:4 C1 error: an approved must-row names its gate/);
  assert.match(check.out, /SPEC.md: 2 rows, 0 errors/);
  const view = box.run(box.repo, 'spec', 'view');
  assert.equal(view.code, 0, view.err);
  const file = join(box.repo, '.git', 'pullboard', 'spec.html');
  assert.ok(readFileSync(file, 'utf8').includes('The page renders.'));
  assert.match(view.out, /open: file:\/\//);
});

test('the board lives in the git common dir; every worktree sees it; nothing is committed [B1, B3]', () => {
  const box = project();
  assert.equal(box.run(box.repo, 'add', 'web', 'Build', 'the', 'page', '--specs', 'G1').out.trim(), '#1');
  assert.match(box.run(box.web, 'list').out, /#1 {2}open {2}web {2}Build the page {2}\[G1\]/);
  assert.ok(existsSync(join(box.repo, '.git', 'pullboard', 'board.sqlite')));
  assert.equal(box.git(box.repo, 'status', '--porcelain'), '');
  assert.match(box.run(box.repo, 'whoami').out, /^coordinator/);
  assert.match(box.run(box.web, 'whoami').out, /^web-1 \(web lane\)/);
  assert.match(box.run(box.web, 'init').err, /NOT_MAIN/);
  assert.match(box.run(box.repo, 'join', 'web').err, /MAIN_IS_COORDINATOR/);
});

test('items cite spec ids that exist [B6]', () => {
  const box = project();
  const refused = box.run(box.repo, 'add', 'web', 'Ghost', '--specs', 'G9');
  assert.equal(refused.code, 1);
  assert.match(refused.err, /UNKNOWN_SPEC\] G9 is not in SPEC.md/);
});

test('a lane commits only inside its folders; an unjoined worktree cannot commit [L3, L4]', () => {
  const box = project();
  const loose = join(box.dir, 'loose');
  box.git(box.repo, 'worktree', 'add', '-q', loose, '-b', 'loose');
  const unjoined = commitFile(box, loose, 'web/a.html', 'a', 'feat(web): page [G1]');
  assert.notEqual(unjoined.status, 0);
  assert.match(unjoined.stderr, /has not joined a lane/);
  const foreign = commitFile(box, box.web, 'api/a.js', 'a', 'feat(web): page [G1]');
  assert.match(foreign.stderr, /outside the web lane: api\/a.js \(api's\)/);
  box.git(box.web, 'reset', '-q', '--hard');
  box.git(box.web, 'clean', '-fdq');
  assert.equal(commitFile(box, box.web, 'docs/web.md', 'shared', 'docs: web notes').status, 0);
  assert.equal(commitFile(box, box.web, 'web/a.html', 'a', 'feat(web): page [G1]').status, 0);
  mkdirSync(join(box.web, 'api'));
  box.git(box.web, 'mv', 'web/a.html', 'api/a.html');
  const moved = box.tryGit(box.web, 'commit', '-q', '-m', 'refactor(web): move the page');
  assert.match(moved.stderr, /outside the web lane: api\/a.html/);
});

test('submit needs a clean tree, nothing untracked, and the gate green at HEAD [V4]', () => {
  const box = project();
  box.run(box.repo, 'add', 'web', 'Page', '--specs', 'G1');
  assert.match(box.run(box.web, 'claim', '1').out, /claimed #1/);
  commitFile(box, box.web, 'web/a.html', 'a', 'feat(web): page [G1]');
  writeFileSync(join(box.web, 'web', 'a.html'), 'edited');
  assert.match(box.run(box.web, 'submit', '1').err, /DIRTY/);
  box.git(box.web, 'checkout', '--', 'web/a.html');
  writeFileSync(join(box.web, 'web', 'stray.txt'), 'x');
  assert.match(box.run(box.web, 'submit', '1').err, /UNTRACKED/);
  rmSync(join(box.web, 'web', 'stray.txt'));
  const submitted = box.run(box.web, 'submit', '1');
  assert.equal(submitted.code, 0, submitted.err);
  assert.match(submitted.out, /submitted #1 at [0-9a-f]{12}; gate green/);
  const head = box.git(box.web, 'rev-parse', 'HEAD');
  assert.equal(box.git(box.repo, 'rev-parse', `refs/pullboard/items/1/${head.slice(0, 12)}`), head, 'submit pins the commit');
});

test('pullboard worktree makes a joined worktree for a lane in one command [I4]', () => {
  const box = project();
  const made = box.run(box.repo, 'worktree', 'api');
  assert.equal(made.code, 0, made.err);
  const path = join(box.dir, 'repo-api-1');
  assert.match(made.out, /on branch api\/1, joined as api-1 in the api lane/);
  assert.match(made.out, new RegExp(`start every command with: cd ${path} &&\n {2}cd ${path} && pullboard inbox\n {2}cd ${path} && pullboard next`));
  assert.match(box.run(path, 'whoami').out, /^api-1 \(api lane\)/);
  assert.match(box.run(box.repo, 'worktree', 'api').out, /repo-api-2 on branch api\/2, joined as api-2/);
  assert.match(box.run(box.repo, 'worktree', 'nope').err, /NO_LANE/);
});

test('a red gate refuses submit', () => {
  const box = project();
  writeFileSync(join(box.repo, 'RED'), 'red');
  box.git(box.repo, 'add', 'RED');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: turn the gate red');
  box.run(box.repo, 'add', 'coordinator', 'Coordinator work');
  box.run(box.repo, 'claim', '1');
  const refused = box.run(box.repo, 'submit', '1');
  assert.equal(refused.code, 1);
  assert.match(refused.err, /GATE_RED/);
});

test('verify runs at the submitted commit, against the criterion frozen at claim [V3, V7]', () => {
  const box = project();
  box.run(box.repo, 'add', 'web', 'Page', '--specs', 'G1', '--criterion', 'renders a heading');
  box.run(box.web, 'claim', '1');
  commitFile(box, box.web, 'web/a.html', '<h1>Hi</h1>', 'feat(web): page [G1]');
  assert.equal(box.run(box.web, 'submit', '1').code, 0);
  assert.match(box.run(box.web, 'verify', '1', 'accept').err, /SELF_VERIFY/);
  const unsaid = box.run(box.repo, 'verify', '1', 'accept', '--note', 'ran it');
  assert.match(unsaid.err, /MAIN_IS_COORDINATOR\] this is the main checkout, so this verdict would be the coordinator's/);
  assert.match(unsaid.err, new RegExp(`Agent worktrees: web-1 at ${box.web}`));
  assert.match(box.run(box.web, 'verify', '1', 'accept', '--as', 'coordinator').err, /USAGE.*only in the main checkout/);
  assert.match(box.run(box.repo, 'verify', '1', 'accept', '--as', 'coordinator').err, /NOT_AT_COMMIT/);
  box.git(box.repo, 'merge', '-q', '--ff-only', 'web/one');
  writeFileSync(join(box.repo, 'SPEC.md'), SPEC.replace('The page renders.', 'The page renders a heading.'));
  box.git(box.repo, 'commit', '-qam', 'docs: tighten G1');
  assert.match(box.run(box.repo, 'verify', '1', 'accept', '--as', 'coordinator').err, /CRITERIA_CHANGED/);
  assert.match(box.run(box.repo, 'refreeze', '1').out, /refrozen/);
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  box.run(box.web, 'claim', '1');
  assert.equal(box.run(box.web, 'submit', '1').code, 0);
  assert.match(box.run(box.repo, 'verify', '1', 'accept', '--as', 'coordinator').err, /PROOF_REQUIRED/);
  assert.match(box.run(box.repo, 'verify', '1', 'accept', '--as', 'coordinator', '--note', 'removed the heading; the page test failed').out, /verified #1: CRITERION_MET/);
  const show = box.run(box.repo, 'show', '1').out;
  assert.match(show, /G1: The page renders a heading\./);
  assert.match(show, /ACCEPT CRITERION_MET by coordinator/);
  const ledger = box.run(box.repo, 'ledger').out;
  assert.match(ledger, /1 verified by a second agent/);
  assert.match(ledger, /\| 1 \| web \| Page \| G1 \| web-1 \| coordinator \|/);
});

test('pre-push runs the gate once per tree and pushes only the checked-out commit [C3]', () => {
  const box = project();
  const remote = join(box.dir, 'remote.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  const first = box.tryGit(box.repo, 'push', '-q', 'origin', 'main');
  assert.equal(first.status, 0, first.stderr);
  assert.ok(existsSync(join(box.repo, '.git', 'pullboard-gate-green')));
  assert.match(box.run(box.repo, 'gate').out, /this tree already passed/);
  const elsewhere = box.tryGit(box.repo, 'push', '-q', 'origin', 'web/one:web/one');
  assert.equal(elsewhere.status, 0, 'web/one is at the same commit as main, so it is what is checked out');
  commitFile(box, box.web, 'web/b.html', 'b', 'feat(web): second page [G1]');
  const notHere = box.tryGit(box.repo, 'push', '-q', 'origin', 'web/one');
  assert.notEqual(notHere.status, 0);
  assert.match(notHere.stderr, /is not checked out/);
});

/**
 * Run `pullboard claim` from two worktrees at once, so both race for the same lock.
 */
function race(box, first, second, id) {
  const one = (cwd) =>
    new Promise((done) => {
      const child = spawn(process.execPath, [BIN, 'claim', String(id)], { cwd, env: box.env });
      let err = '';
      child.stderr.on('data', (chunk) => {
        err += chunk;
      });
      child.on('close', (code) => done({ cwd, code, err }));
    });
  return Promise.all([one(first), one(second)]);
}

test('two agents racing for one item: exactly one wins, every time [B2]', async () => {
  const box = project();
  const second = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', second, '-b', 'web/two');
  assert.match(box.run(second, 'join', 'web').out, /joined as web-2/);
  for (let round = 1; round <= 6; round += 1) {
    box.run(box.repo, 'add', 'web', `Item ${round}`);
    const results = await race(box, box.web, second, round);
    const winners = results.filter((result) => result.code === 0);
    const losers = results.filter((result) => result.code !== 0);
    assert.equal(winners.length, 1, `round ${round}: ${JSON.stringify(results)}`);
    assert.match(losers[0].err, /HELD/);
    assert.equal(box.run(winners[0].cwd, 'release', String(round)).code, 0);
  }
});

test('next claims the next free item; --verify names the next to check [N2]', () => {
  const box = project();
  box.run(box.repo, 'add', 'web', 'Page', '--specs', 'G1');
  box.run(box.repo, 'add', 'web', 'Second page', '--specs', 'G1', '--after', '1');
  const first = box.run(box.web, 'next');
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /claimed #1: Page/);
  assert.match(first.out, /G1: The page renders\./);
  assert.match(first.out, new RegExp(`when it is built and committed: cd ${box.web} && pullboard submit 1`));
  assert.match(box.run(box.web, 'next').out, /you hold #1: Page/);
  commitFile(box, box.web, 'web/a.html', 'a', 'feat(web): page [G1]');
  box.run(box.web, 'submit', '1');
  const blocked = box.run(box.web, 'next');
  assert.equal(blocked.code, 1);
  assert.match(blocked.err, /NOTHING_FREE\] #2 waits on #1 \(submitted, web lane\)/);
  assert.match(box.run(box.repo, 'next', '--verify').err, /MAIN_IS_COORDINATOR/);
  const named = box.run(box.repo, 'next', '--verify', '--as', 'coordinator').out;
  assert.match(named, /next to verify: #1 Page, built by web-1/);
  assert.match(named, new RegExp(`check out exactly that commit, here: cd ${box.repo} && git switch --detach [0-9a-f]{40}`));
  assert.match(named, /pullboard verify 1 accept --as coordinator --note/);
  assert.match(box.run(box.web, 'next', '--verify').err, /NOTHING_FREE/);
});

test('a deleted spec row is refused at commit; spec check finds any id gone from history or cited [S8, S9]', () => {
  const box = project();
  const spec = join(box.repo, 'SPEC.md');
  writeFileSync(spec, SPEC.replace(/- G2 .*\n/, ''));
  box.git(box.repo, 'add', 'SPEC.md');
  const refused = box.tryGit(box.repo, 'commit', '-q', '-m', 'docs(spec): drop the api row');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /SPEC.md: G2 is gone; ids are permanent: keep the row and mark it wont/);
  box.git(box.repo, 'commit', '-q', '--no-verify', '-m', 'docs(spec): drop the api row');
  box.git(box.repo, 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'feat(web): ghost [G7]');
  writeFileSync(spec, `${SPEC.replace(/- G2 .*\n/, '')}- G3 [draft, must] Not committed yet.\n`);
  assert.equal(box.run(box.repo, 'add', 'web', 'Uses G3', '--specs', 'G3').code, 0);
  writeFileSync(spec, SPEC.replace(/- G2 .*\n/, ''));
  const check = box.run(box.repo, 'spec', 'check');
  assert.equal(check.code, 1);
  assert.match(check.out, /SPEC.md: G2 error: was committed in [0-9a-f]{12} and is gone/);
  assert.match(check.out, /SPEC.md: G7 error: commit [0-9a-f]{7,} cites it, but it was never committed/);
  assert.match(check.out, /SPEC.md: G3 error: item #1 cites it, but it was never committed/);
  writeFileSync(spec, `${SPEC.replace('- G2 [approved, must]', '- G2 [wont, must]')}- G3 [retired] Planned before the spec settled.\n- G7 [retired] Cited by mistake.\n`);
  const fixed = box.run(box.repo, 'spec', 'check');
  assert.equal(fixed.code, 0, fixed.out);
  box.git(box.repo, 'add', 'SPEC.md');
  assert.equal(box.tryGit(box.repo, 'commit', '-q', '-m', 'docs(spec): keep every id').status, 0);
  const cited = commitFile(box, box.repo, 'docs/api.md', 'x', 'feat(api): call the api [G2]');
  assert.notEqual(cited.status, 0);
  assert.match(cited.stderr, /G2 is marked won't build/);
});

const LIGHT_BRIEF = 'Files:\n- web/page.js\nChange:\n- copy the header from the api\nTest:\n- the page test asserts the header\nOut of scope: anything else\n';

test('an item carries a brief to whoever claims it; a light agent sees only its tier [B10, B13, B14]', () => {
  const box = project();
  writeFileSync(join(box.dir, 'brief.md'), LIGHT_BRIEF);
  assert.equal(box.run(box.repo, 'add', 'web', 'Design', 'the', 'page', '--specs', 'G1').code, 0);
  assert.match(box.run(box.repo, 'add', 'web', 'Copy', '--route', 'light', '--brief-file', join(box.dir, 'brief.md')).err, /NO_BRIEF.*--criterion.*--check/);
  assert.match(box.run(box.repo, 'add', 'web', 'Copy', '--brief', 'x', '--brief-file', 'y').err, /USAGE.*give the brief once/);
  const foreign = box.run(box.repo, 'add', 'web', 'Copy', '--route', 'light', '--criterion', 'c', '--check', 'true', '--brief', LIGHT_BRIEF.replace('web/page.js', 'api/server.js'));
  assert.match(foreign.err, /BRIEF_LANE.*api\/server.js \(api's\)/);
  const added = box.run(box.repo, 'add', 'web', 'Copy', 'the', 'header', '--route', 'light', '--criterion', 'the page shows the header', '--check', 'test -f web/page.js', '--brief-file', join(box.dir, 'brief.md'));
  assert.equal(added.out.trim(), '#2', added.err);
  assert.match(box.run(box.repo, 'list').out, /#2 {2}open {2}web {2}Copy the header {2}light/);
  assert.doesNotMatch(box.run(box.repo, 'list', '--route', 'light').out, /Design the page/);
  const made = box.run(box.repo, 'worktree', 'web', '--route', 'light');
  assert.match(made.out, /joined as web-2 in the web lane, on the light route/);
  const light = made.out.match(/^made (\S+) /)[1];
  assert.match(box.run(light, 'whoami').out, /^web-2 \(web lane, light route\)/);
  const next = box.run(light, 'next');
  assert.match(next.out, /claimed #2: Copy the header\ncriterion: the page shows the header\ncheck: test -f web\/page.js {3}\(run it before you submit\)\nbrief:\n {2}Files:\n {2}- web\/page.js/);
  assert.match(box.run(light, 'claim', '1').err, /ROUTE/);
  assert.match(box.run(box.web, 'next').out, /claimed #1: Design the page/);
  assert.equal(box.run(box.repo, 'edit', '1', '--brief', 'Start from the sketch in docs/page.md.').code, 0);
  assert.match(box.run(box.web, 'show', '1').out, /brief:\n {2}Start from the sketch in docs\/page.md./);
  assert.match(box.run(box.web, 'edit', '2', '--brief', 'mine').err, /NOT_YOURS/);
});

test('run builds routed items unattended: the failure feeds the next attempt; red work escalates, pinned [N14, B15]', () => {
  const box = project();
  const agent = join(box.dir, 'agent.sh');
  writeFileSync(agent, [
    '#!/bin/sh',
    'mkdir -p web api',
    'if [ "$PULLBOARD_ITEM" = "1" ]; then',
    '  if [ "$PULLBOARD_ATTEMPT" = "1" ]; then echo "export const title = \'Hello\';" > web/page.js; echo stray > api/stray.js;',
    '  elif grep -q "The check" "$PULLBOARD_PACK"; then echo "export const title = \'Hi\';" > web/page.js; fi',
    'else',
    '  echo "export const footer = \'nope\'; // $PULLBOARD_CHECK $PULLBOARD_TIER" | tr B b > web/footer.js',
    'fi',
    '',
  ].join('\n'));
  const brief = (file) => LIGHT_BRIEF.replace('web/page.js', file);
  const has = (file, text) => `grep -q ${text} ${file}`;
  assert.equal(box.run(box.repo, 'add', 'web', 'Greet', 'on', 'the', 'page', '--specs', 'G1', '--route', 'light', '--criterion', 'the page says Hi', '--check', has('web/page.js', 'Hi'), '--brief', brief('web/page.js')).code, 0);
  assert.equal(box.run(box.repo, 'add', 'web', 'Say', 'bye', '--route', 'light', '--criterion', 'the footer says Bye', '--check', has('web/footer.js', 'Bye'), '--brief', brief('web/footer.js')).code, 0);
  const made = box.run(box.repo, 'worktree', 'web', '--route', 'light');
  const light = made.out.match(/^made (\S+) /)[1];
  assert.match(box.run(box.repo, 'run', '--agent', `sh ${agent}`).err, /MAIN_IS_COORDINATOR/);
  assert.match(box.run(light, 'run', '--agent-mid', `sh ${agent}`).err, /ROUTE.*joined on the light route, so it cannot take mid items/);
  const ran = box.run(light, 'run', '--agent-light', `sh ${agent}`, '--attempts', '2', '--minutes', '2');
  assert.equal(ran.code, 0, ran.err);
  assert.match(ran.out, /#1 attempt 1: red[\s\S]*#1 attempt 2: green \(agent \d+s, check \d+s\)\nsubmitted #1/);
  assert.match(ran.out, /nothing left to run: no open light runnable items in the web lane/);
  assert.match(ran.out, /#2 attempt 2: red[\s\S]*#2 escalated light -> mid; the attempt is pinned at refs\/pullboard\/attempts\/2\//);
  assert.match(ran.out, /runner done: 1 submitted, 1 escalated/);
  const packs = join(box.dir, 'repo', '.git', 'worktrees', light.split('/').at(-1), 'pullboard', 'packs');
  const second = readFileSync(join(packs, '1-light-2.md'), 'utf8');
  assert.equal(existsSync(join(packs, '1-light-1.log')), true);
  assert.match(second, /reverted your changes outside the brief's files: api\/stray.js/);
  assert.match(second, /### web\/page.js\n```\nexport const title = 'Hello';/);
  assert.equal(existsSync(join(light, 'api', 'stray.js')), false);
  assert.equal(box.git(light, 'log', '-1', '--format=%s', 'refs/pullboard/items/1/' + box.git(light, 'rev-parse', '--short=12', 'HEAD')), 'feat(web): greet on the page [G1]');
  assert.equal(box.git(light, 'status', '--porcelain'), '');
  const pinned = box.git(light, 'for-each-ref', '--format=%(refname)', 'refs/pullboard/attempts/2/');
  assert.match(box.git(light, 'show', `${pinned}:web/footer.js`), /nope'; \/\/ grep -q bye web\/footer.js light/);
  const shown = box.run(box.repo, 'show', '2').out;
  assert.match(shown, /#2 {2}open {2}web {2}Say bye {2}mid/);
  assert.match(shown, /unattended attempts: red, red/);
  assert.match(shown, /escalated light -> mid by web-2, pinned at refs\/pullboard\/attempts\/2\/[0-9a-f]{12}: 2 attempts stayed red/);
  assert.match(box.run(box.repo, 'inbox').out, /web-2 -> coordinator: #2 escalated light -> mid after 2 red attempts/);
});

test('one runner climbs the tiers: an escalated item goes to the next command, with the earlier tries; it merges the verified work an item waits on [N16]', () => {
  const box = project();
  const script = (name, lines) => {
    writeFileSync(join(box.dir, name), ['#!/bin/sh', 'mkdir -p web api', ...lines, ''].join('\n'));
    return `sh ${join(box.dir, name)}`;
  };
  const good = script('web.sh', ["echo \"export const title = 'Hi';\" > web/page.js"]);
  const weak = script('weak.sh', ['echo nope > api/server.js']);
  const strong = script('strong.sh', ['grep -q "Earlier tries by a lighter model" "$PULLBOARD_PACK" && echo "export const served = true;" > api/server.js']);
  const brief = (file) => LIGHT_BRIEF.replace('web/page.js', file);
  box.run(box.repo, 'add', 'web', 'Greet', '--route', 'light', '--criterion', 'says Hi', '--check', 'grep -q Hi web/page.js', '--brief', brief('web/page.js'));
  box.run(box.repo, 'add', 'api', 'Serve', 'the', 'page', '--after', '1', '--route', 'light', '--criterion', 'serves it', '--check', 'test -f web/page.js && grep -q served api/server.js', '--brief', brief('api/server.js'));
  const webRunner = box.run(box.repo, 'worktree', 'web', '--route', 'light').out.match(/^made (\S+) /)[1];
  assert.match(box.run(webRunner, 'run', '--agent-light', good, '--attempts', '1').out, /submitted #1/);
  const commit = JSON.parse(box.run(box.repo, 'show', '1', '--json').out).item_commit;
  box.git(box.web, 'merge', '-q', '--ff-only', commit);
  assert.match(box.run(box.web, 'verify', '1', 'accept', '--note', 'ran the check, then emptied the file and saw it fail').out, /verified #1/);
  const apiRunner = box.run(box.repo, 'worktree', 'api', '--route', 'mid').out.match(/^made (\S+) /)[1];
  const ran = box.run(apiRunner, 'run', '--agent-light', weak, '--agent-mid', strong, '--attempts', '2', '--minutes', '2');
  assert.equal(ran.code, 0, ran.err);
  assert.match(ran.out, /#2 attempt 1\/2: running the light agent[\s\S]*#2 escalated light -> mid[\s\S]*#2 attempt 1\/2: running the mid agent\n#2 attempt 1: green[\s\S]*submitted #2/);
  assert.match(ran.out, /runner done: 1 submitted, 1 escalated/);
  assert.equal(box.tryGit(apiRunner, 'merge-base', '--is-ancestor', commit, 'HEAD').status, 0);
  const packs = join(box.dir, 'repo', '.git', 'worktrees', apiRunner.split('/').at(-1), 'pullboard', 'packs');
  assert.match(readFileSync(join(packs, '2-mid-1.md'), 'utf8'), /## Earlier tries by a lighter model\n- 2 attempts stayed red/);
  assert.equal(existsSync(join(packs, '2-light-1.md')), true);
});

test('sweep files one light item per flagged file, in its lane; a second sweep skips what is open [N15]', () => {
  const box = project();
  writeFileSync(join(box.dir, 'novar.mjs'), [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    'const walk = (p) => fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter((n) => !n.startsWith(".") && n !== "node_modules").flatMap((n) => walk(path.join(p, n))) : [p];',
    'let found = 0;',
    'for (const file of process.argv.slice(2).flatMap(walk).filter((f) => f.endsWith(".js"))) {',
    '  fs.readFileSync(file, "utf8").split("\\n").forEach((line, i) => { const col = line.indexOf("var "); if (col >= 0) { found += 1; console.log(`${file}:${i + 1}:${col + 1}: no-var Unexpected var, use let or const.`); } });',
    '}',
    'process.exit(found ? 1 : 0);',
    '',
  ].join('\n'));
  commitFile(box, box.repo, 'web/a.js', 'var a = 1;\nvar b = 2;\n', 'chore: two vars');
  commitFile(box, box.repo, 'api/b.js', 'var c = 3;\n', 'chore: one var');
  const sweep = ['sweep', '--run', `node ${join(box.dir, 'novar.mjs')} .`, '--check', `node ${join(box.dir, 'novar.mjs')} {file}`];
  assert.match(box.run(box.web, ...sweep).err, /COORDINATOR_ONLY/);
  assert.match(box.run(box.repo, ...sweep, '--dry-run').out, /would file: fix 2 problems in web\/a.js \(web lane, light\)/);
  const filed = box.run(box.repo, ...sweep);
  assert.equal(filed.code, 0, filed.err);
  assert.match(filed.out, /#1 fix 2 problems in web\/a.js \(web lane, light\)\n#2 fix 1 problem in api\/b.js \(api lane, light\)/);
  assert.match(filed.out, /3 problems in 2 files; filed 2/);
  const shown = box.run(box.repo, 'show', '1').out;
  assert.match(shown, new RegExp(`check: node ${join(box.dir, 'novar.mjs')} web/a.js`));
  assert.match(shown, /- line 2:1 no-var: Unexpected var, use let or const\./);
  assert.match(box.run(box.repo, ...sweep).out, /already open: web\/a.js, api\/b.js\n3 problems in 2 files; filed 0/);
  commitFile(box, box.repo, 'docs/c.js', 'var d = 4;\n', 'chore: one more var');
  const blind = box.run(box.repo, 'sweep', '--run', `node ${join(box.dir, 'novar.mjs')} .`, '--check', `node ${join(box.dir, 'novar.mjs')} {file} | tail -5`);
  assert.equal(blind.code, 1);
  assert.match(blind.err, /CHECK_CANNOT_FAIL\] the check passes on docs\/c.js although the checker flags problems there/);
  assert.match(blind.out, /filed 0/);
});

test('pre-commit runs the fixers on fully staged files and restages them; partly staged files are left alone [C5]', () => {
  const box = project();
  const fixer = join(box.dir, 'trim.mjs');
  writeFileSync(fixer, "import fs from 'node:fs';\nfor (const f of process.argv.slice(2)) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/[ \\t]+$/gm, ''));\n");
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...config, fix: [{ run: `node ${fixer}`, files: ['*.js'] }] }, null, 2));
  box.git(box.repo, 'commit', '-qam', 'chore: trim trailing spaces at commit');
  mkdirSync(join(box.repo, 'docs'), { recursive: true });
  writeFileSync(join(box.repo, 'docs', 'a.js'), 'const a = 1;   \n');
  writeFileSync(join(box.repo, 'docs', 'b.md'), 'text   \n');
  writeFileSync(join(box.repo, 'docs', 'c.js'), 'const c = 1;   \n');
  box.git(box.repo, 'add', 'docs');
  writeFileSync(join(box.repo, 'docs', 'c.js'), 'const c = 1;   \nconst d = 2;\n');
  const committed = box.tryGit(box.repo, 'commit', '-q', '-m', 'docs: three files');
  assert.equal(committed.status, 0, committed.stderr);
  const committedText = (path) => box.tryGit(box.repo, 'show', `HEAD:${path}`).stdout;
  assert.equal(committedText('docs/a.js'), 'const a = 1;\n');
  assert.equal(readFileSync(join(box.repo, 'docs', 'a.js'), 'utf8'), 'const a = 1;\n');
  assert.equal(committedText('docs/b.md'), 'text   \n');
  assert.equal(committedText('docs/c.js'), 'const c = 1;   \n');
  assert.match(committed.stderr, /not fixed, because they are partly staged: docs\/c.js/);
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...config, fix: [{ run: 'false', files: ['*.js'] }] }, null, 2));
  box.git(box.repo, 'commit', '-qam', 'chore: a fixer that fails');
  writeFileSync(join(box.repo, 'docs', 'e.js'), 'const e = 1;   \n');
  box.git(box.repo, 'add', 'docs/e.js');
  const failed = box.tryGit(box.repo, 'commit', '-q', '-m', 'docs: one more');
  assert.equal(failed.status, 0, failed.stderr);
  assert.match(failed.stderr, /fixer "false" failed \(1\); staged nothing from it/);
  assert.equal(committedText('docs/e.js'), 'const e = 1;   \n');
});

test('resume puts an agent back to work from the board: its claim, its branch, what came back, the next step [N19]', () => {
  const box = project();
  box.run(box.repo, 'add', 'web', 'Page', '--specs', 'G1', '--brief', 'Files: web/page.html');
  const fresh = box.run(box.web, 'resume');
  assert.equal(fresh.code, 0, fresh.err);
  assert.match(fresh.out, /^resume: web-1, web lane, at /);
  assert.match(fresh.out, /branch web\/one: 0 ahead of main, 0 behind/);
  assert.match(fresh.out, /next: pullboard next \(1 open in your lane\)/);
  box.run(box.web, 'next');
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web', 'page.html'), '<h1>Hi</h1>');
  box.run(box.repo, 'shout', 'web-1', 'the heading text is in G1');
  const building = box.run(box.web, 'resume').out;
  assert.match(building, /1 file uncommitted/);
  assert.match(building, /holding #1 Page, lease \d+[mh] left/);
  assert.match(building, /files: web\/page\.html/);
  assert.match(building, /1 unread shout; newest from coordinator: the heading text is in G1/);
  assert.match(building, /next: build #1, commit, then pullboard submit 1/);
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): page [G1]');
  assert.equal(box.run(box.web, 'submit', '1').code, 0);
  const coordinator = box.run(box.repo, 'resume').out;
  assert.match(coordinator, /^resume: coordinator, coordinator lane, the main checkout/);
  assert.match(coordinator, /to verify: #1 web \(\d+[mhd]\)/);
  assert.match(coordinator, /next: pullboard next --verify --as coordinator/);
  box.git(box.repo, 'switch', '-q', '--detach', 'web/one');
  box.run(box.repo, 'verify', '1', 'reject', '--reason', 'TEST_FAILURE', '--note', 'no test proves the heading\nthe rest is fine', '--as', 'coordinator');
  const back = box.run(box.web, 'resume').out;
  assert.match(back, /branch web\/one: main is detached for a verification/);
  box.git(box.repo, 'switch', '-q', 'main');
  assert.match(box.run(box.web, 'resume').out, /branch web\/one: 1 ahead of main, 0 behind/);
  assert.match(back, /sent back: #1 TEST_FAILURE by coordinator: no test proves the heading$/m);
  assert.match(back, /next: pullboard claim 1, fix what the verifier found, and submit again/);
});

test('next takes work near your recent files; submit records them; show names related verified work [N20, N21]', () => {
  const box = project();
  box.run(box.repo, 'add', 'web', 'Footer', '--specs', 'G1', '--brief', 'Files: web/footer.html');
  box.run(box.repo, 'add', 'web', 'Header', '--specs', 'G1', '--brief', 'Files: web/header.html');
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web', 'header.html'), '<header>');
  const next = box.run(box.web, 'next');
  assert.match(next.out, /claimed #2: Header/);
  assert.match(next.out, /it touches a file you worked in recently: web\/header\.html/);
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): header [G1]');
  commitFile(box, box.web, 'web/nav.html', '<nav>', 'feat(web): nav in the header [G1]');
  commitFile(box, box.repo, 'docs/notes.md', 'main moves on', 'docs: notes on main');
  box.git(box.web, 'merge', '-q', '--no-edit', 'main');
  assert.equal(box.run(box.web, 'submit', '2').code, 0);
  assert.equal(JSON.parse(box.run(box.web, 'show', '2', '--json').out).item_files, 'web/header.html\nweb/nav.html', 'only the item\'s own commits, not the merge');
  box.git(box.repo, 'switch', '-q', '--detach', 'web/one');
  box.run(box.repo, 'verify', '2', 'accept', '--note', 'emptied the header; the page lost it', '--as', 'coordinator');
  box.git(box.repo, 'switch', '-q', 'main');
  box.run(box.repo, 'add', 'web', 'Menu', '--specs', 'G1', '--brief', 'Files: web/nav.html, web/menu.html');
  assert.match(box.run(box.repo, 'show', '3').out, /related: #2 Header: web\/nav\.html \(git log -p -1 [0-9a-f]{12} -- web\/nav\.html\)/);
  const warm = box.run(box.web, 'next');
  assert.match(warm.out, /claimed #3: Menu/, 'a clean tree: the files of the items it built last are what is warm');
  assert.match(warm.out, /it touches a file you worked in recently: web\/nav\.html/);
});

test('hold pauses a lane: next names who held it and why; --off lets it go [N22]', () => {
  const box = project();
  box.run(box.repo, 'add', 'web', 'Page', '--specs', 'G1');
  assert.match(box.run(box.web, 'hold', 'web', '--reason', 'mine').err, /COORDINATOR_ONLY/);
  assert.match(box.run(box.repo, 'hold', 'nowhere', '--reason', 'x').err, /NO_LANE/);
  assert.match(box.run(box.repo, 'hold', 'web', '--reason', 'G1 is being rewritten').out, /holding the web lane: G1 is being rewritten/);
  const held = box.run(box.web, 'next');
  assert.equal(held.code, 1);
  assert.match(held.err, /coordinator holds the web lane: G1 is being rewritten/);
  assert.match(box.run(box.web, 'claim', '1').err, /LANE_HELD/);
  assert.match(box.run(box.web, 'resume').out, /the web lane is held by coordinator: G1 is being rewritten/);
  assert.match(box.run(box.repo, 'hold', 'web', '--off').out, /released the web lane/);
  assert.match(box.run(box.web, 'next').out, /claimed #1: Page/);
});

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
  const started = Date.now();
  const shown = spawnSync(process.execPath, [BIN, 'tour'], { cwd: box.dir, env: { ...box.env, TMPDIR: box.dir }, encoding: 'utf8' });
  assert.equal(shown.status, 0, `${shown.stdout}${shown.stderr}`);
  assert.ok(Date.now() - started < 30_000, 'thirty seconds');
  assert.match(shown.stdout, /review-1 \$ pullboard verify 1 reject --reason BEHAVIOR_MISMATCH/);
  assert.match(shown.stdout, /sent back: #1 BEHAVIOR_MISMATCH by review-1: greet\(''\) returns "Hello, !"/);
  assert.match(shown.stdout, /with the fix removed\n {7}# pass 1\n {7}# fail 1/);
  assert.match(shown.stdout, /verified #1: CRITERION_MET/);
  assert.match(shown.stdout, /\| 1 \| app \| Greeting \| G1 \| app-1 \| review-1 \|/);
  const repo = /Look around: cd (\S+) && pullboard log/.exec(shown.stdout)[1];
  assert.match(box.git(repo, 'log', '--format=%an %s', '-1'), /^app-1 fix\(app\): a blank name greets the world \[G1\]$/);
  const hooks = join(box.dir, 'ambient-hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\necho ambient hook ran >&2\nexit 1\n');
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  const ambient = { ...box.env, TMPDIR: box.dir, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooks, GIT_DIR: join(box.dir, 'elsewhere.git') };
  const isolated = spawnSync(process.execPath, [BIN, 'tour'], { cwd: box.dir, env: ambient, encoding: 'utf8' });
  assert.equal(isolated.status, 0, `git settings from the environment stay out: ${isolated.stdout}`);
  const empty = join(box.dir, 'empty');
  mkdirSync(empty);
  const stopped = spawnSync(process.execPath, [BIN, 'tour'], { cwd: box.dir, env: { ...box.env, TMPDIR: box.dir, PATH: empty }, encoding: 'utf8' });
  assert.equal(stopped.status, 1);
  assert.match(stopped.stdout, /The tour stopped: git init -q -b main exited null/);
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
  assert.match(resume().stdout, /^resume: web-1, web lane/);
});

test('the gate reaches the agent as a digest: one line when green, the failure when red; the whole output stays in the git dir [V10]', () => {
  const box = project();
  writeFileSync(join(box.repo, 'gate.cjs'), [
    "const red = require('node:fs').existsSync('RED');",
    "for (let i = 0; i < 400; i++) console.log(`ok ${i} ${'x'.repeat(red ? 10 : 3000)}`);",
    "if (red) { console.error('not ok 401 - the page renders a heading'); for (let i = 0; i < 100; i++) console.log(`# note ${i}`); process.exit(1); }",
    '',
  ].join('\n'));
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...CONFIG, gate: 'node gate.cjs # prints a lot' }));
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: a noisy gate');
  const log = join(box.repo, box.git(box.repo, 'rev-parse', '--git-path', 'pullboard-gate.log'));
  const green = box.run(box.repo, 'gate');
  assert.equal(green.code, 0, green.err);
  assert.match(green.out, /^gate green in \d+s\n$/);
  assert.ok(readFileSync(log, 'utf8').length > 1_200_000, 'more than the default 1 MB pipe buffer, read whole');
  writeFileSync(join(box.repo, 'RED'), 'red');
  box.git(box.repo, 'add', 'RED');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: turn the gate red');
  const red = box.run(box.repo, 'gate');
  assert.equal(red.code, 1);
  assert.match(red.out, /^gate red in \d+s:\n {2}not ok 401 - the page renders a heading\n/);
  assert.match(red.out, / {2}# note 99\nthe whole output is in /);
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
  box.git(box.repo, 'commit', '-qam', 'docs: tighten G1');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  commitFile(box, box.web, 'web/a.html', '<h1>Hi</h1>', 'feat(web): page [G1]');
  const refused = box.run(box.web, 'submit', '1');
  assert.equal(refused.code, 1);
  assert.match(refused.err, /CRITERIA_CHANGED\] the spec rows #1 cites changed after it was claimed.*shout the coordinator to run pullboard refreeze 1, then claim it and submit again/);
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
  const red = box.run(box.web, 'check');
  assert.equal(red.code, 1);
  assert.match(red.out, /^check red in \d+s: test -f web\/a.html/);
  assert.match(red.out, /\n {2}not ok 1 - web\/a.html is missing\n/);
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web', 'a.html'), '<h1>Hi</h1>');
  const green = box.run(box.web, 'check');
  assert.equal(green.code, 0, green.out);
  assert.match(green.out, /^check green in \d+s: test -f web\/a.html/);
  assert.equal(green.out.split('\n').filter(Boolean).length, 1);
  assert.equal(box.run(box.repo, 'check', '1').code, 1, 'named, from another checkout: there the file is missing');
  assert.match(box.run(box.web, 'check', '2').err, /NO_CHECK.*#2 has no check command/);
  assert.match(box.run(box.repo, 'help').out, /pullboard check \[id\]/);
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
  assert.match(box.run(box.repo, 'help').out, /--note-file <file>/);
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
