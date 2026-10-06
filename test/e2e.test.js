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
  assert.match(box.run(box.repo, 'verify', '1', 'accept').err, /NOT_AT_COMMIT/);
  box.git(box.repo, 'merge', '-q', '--ff-only', 'web/one');
  writeFileSync(join(box.repo, 'SPEC.md'), SPEC.replace('The page renders.', 'The page renders a heading.'));
  box.git(box.repo, 'commit', '-qam', 'docs: tighten G1');
  assert.match(box.run(box.repo, 'verify', '1', 'accept').err, /CRITERIA_CHANGED/);
  assert.match(box.run(box.repo, 'refreeze', '1').out, /refrozen/);
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  box.run(box.web, 'claim', '1');
  assert.equal(box.run(box.web, 'submit', '1').code, 0);
  assert.match(box.run(box.repo, 'verify', '1', 'accept').err, /PROOF_REQUIRED/);
  assert.match(box.run(box.repo, 'verify', '1', 'accept', '--note', 'removed the heading; the page test failed').out, /verified #1: CRITERION_MET/);
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
  assert.match(box.run(box.web, 'next').out, /you hold #1: Page/);
  commitFile(box, box.web, 'web/a.html', 'a', 'feat(web): page [G1]');
  box.run(box.web, 'submit', '1');
  const blocked = box.run(box.web, 'next');
  assert.equal(blocked.code, 1);
  assert.match(blocked.err, /NOTHING_FREE\] #2 waits on #1 \(submitted\)/);
  assert.match(box.run(box.repo, 'next', '--verify').out, /next to verify: #1 Page, built by web-1/);
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

test('an item carries a brief to whoever claims it; a light agent sees only light work [B10, B11]', () => {
  const box = project();
  writeFileSync(join(box.dir, 'brief.md'), 'Edit web/page.js only.\nCopy the header from api/server.js.\n');
  assert.equal(box.run(box.repo, 'add', 'web', 'Design', 'the', 'page', '--specs', 'G1').code, 0);
  assert.match(box.run(box.repo, 'add', 'web', 'Rename', '--route', 'light').err, /NO_BRIEF/);
  assert.match(box.run(box.repo, 'add', 'web', 'Rename', '--brief', 'x', '--brief-file', 'y').err, /USAGE.*give the brief once/);
  const added = box.run(box.repo, 'add', 'web', 'Copy', 'the', 'header', '--route', 'light', '--brief-file', join(box.dir, 'brief.md'));
  assert.equal(added.out.trim(), '#2', added.err);
  assert.match(box.run(box.repo, 'list').out, /#2 {2}open {2}web {2}Copy the header {2}light/);
  const made = box.run(box.repo, 'worktree', 'web', '--route', 'light');
  assert.match(made.out, /joined as web-2 in the web lane, on the light route/);
  const light = made.out.match(/^made (\S+) /)[1];
  assert.match(box.run(light, 'whoami').out, /^web-2 \(web lane, light route\)/);
  const next = box.run(light, 'next');
  assert.match(next.out, /claimed #2: Copy the header\nbrief:\n {2}Edit web\/page.js only.\n {2}Copy the header from api\/server.js./);
  assert.match(box.run(light, 'claim', '1').err, /ROUTE/);
  assert.match(box.run(box.web, 'next').out, /claimed #1: Design the page/);
  assert.equal(box.run(box.repo, 'edit', '1', '--brief', 'Start from the sketch in docs/page.md.').code, 0);
  assert.match(box.run(box.web, 'show', '1').out, /brief:\n {2}Start from the sketch in docs\/page.md./);
  assert.match(box.run(box.web, 'edit', '2', '--brief', 'mine').err, /NOT_YOURS/);
});
