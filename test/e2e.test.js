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
import { request } from 'node:http';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { parseSpec } from '../src/spec.js';
import { checkAtCommit } from '../src/trusted-policy.js';
import * as store from '../src/board.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const cockpitSource = () => readFileSync(resolve(import.meta.dirname, '../src/cockpit.js'), 'utf8');
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
    PULLBOARD_HOME: join(dir, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
  };
  delete env.PULLBOARD_RELAY_TOKEN;
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
function project(gate = CONFIG.gate, box = sandbox()) {
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  assert.equal(box.run(repo, 'init').code, 0);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ ...CONFIG, gate }, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up pullboard');
  const web = join(box.dir, 'web-1');
  box.git(repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  assert.match(box.run(web, 'join', 'web').out, /joined as web-1/);
  return { ...box, repo, web };
}

/** Create a private gate that waits only after the test arms it. */
function holdingGate(box) {
  const script = join(box.dir, 'holding-gate.cjs');
  const mode = join(box.dir, 'hold-gate');
  const release = join(box.dir, 'release-gate');
  const events = join(box.dir, 'gate-events.log');
  writeFileSync(script, [
    "const fs = require('node:fs');",
    'const [armed, release, events] = process.argv.slice(2);',
    'if (!fs.existsSync(armed)) process.exit(0);',
    "fs.appendFileSync(events, 'start\\n');",
    'const deadline = Date.now() + 15000;',
    'while (!fs.existsSync(release) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);',
    'if (!fs.existsSync(release)) process.exit(23);',
    "fs.appendFileSync(events, 'end\\n');",
  ].join('\n'));
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  return { command: `node ${quote(script)} ${quote(mode)} ${quote(release)} ${quote(events)}`, mode, release, events };
}

/** Launch a CLI or Git process while preserving its output for the gate-lock assertion. */
function launch(box, cwd, command, args) {
  const child = spawn(command, args, { cwd, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { child.stdoutText += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { child.stderrText += chunk; });
  child.closed = new Promise((resolveClose) => child.once('close', (code, signal) => resolveClose({ code, signal })));
  return child;
}

/** Wait for a private fixture observation with a bounded failure time. */
async function waitFor(predicate, description, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`timed out waiting for ${description}`);
}

/** Read the private gate event sequence without exposing arbitrary gate output. */
function gateEvents(gate) {
  return existsSync(gate.events) ? readFileSync(gate.events, 'utf8').trim().split(/\r?\n/u).filter(Boolean) : [];
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
  const practice = readFileSync(join(repo, 'DOCTRINE.md'), 'utf8');
  assert.ok(practice.startsWith('# Doctrine'));
  assert.deepEqual(parseSpec(practice).rows, [], 'fresh init copies no standard rules [D4]');
  assert.equal(parseSpec(practice).sections.length, 6);
  assert.equal(practice.split('Inherits Pullboard standard doctrine version 1.').length, 2);
  assert.match(agents, /PB1 \(standard 1\)/, 'fresh guidance shows inherited rules [D3]');
  assert.ok(existsSync(join(repo, '.claude', 'skills', 'pullboard-decompose', 'SKILL.md')));
  assert.match(second.out, /kept DOCTRINE.md/);
  assert.match(second.out, /kept the Claude Code skills/);
});

test("init's spec has its sections and no rows, and the README's example fits under them as written [I1, S8]", () => {
  const box = sandbox();
  const repo = join(box.dir, 'fresh');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  assert.equal(box.run(repo, 'init').code, 0);
  const spec = readFileSync(join(repo, 'SPEC.md'), 'utf8');
  assert.deepEqual(parseSpec(spec).rows, [], 'no placeholder row, so no placeholder id is ever committed and made permanent');
  assert.deepEqual(parseSpec(spec).sections.map((section) => section.name), ['G · Goals: what the client asked for', 'K · Constraints']);
  const readme = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8');
  const section = /^## (?:Quick start|By hand)\s*$/mu.exec(readme);
  const markdownExamples = [...readme.matchAll(/```markdown\n([\s\S]*?)```/gu)];
  /** Match the spec example rather than unrelated markdown examples.
   * @param {RegExpMatchArray} block
   * @returns {boolean}
   */
  const isGoalsExample = (block) => /^## G · Goals[^\n]*$/mu.test(block[1]);
  const exampleBlock = markdownExamples.find((block) => isGoalsExample(block) && (!section || block.index > section.index))
    ?? markdownExamples.find(isGoalsExample);
  assert.ok(exampleBlock, "the README has a markdown block with its G rows under Quick start, By hand, or on its own");
  const example = exampleBlock[1];
  const [heading, ...rows] = example.trim().split('\n');
  assert.ok(rows.length > 0 && spec.includes(`${heading}\n`), `the README's example heading is one init writes: ${heading}`);
  writeFileSync(join(repo, 'SPEC.md'), spec.replace(`${heading}\n`, `${heading}\n${rows.join('\n')}\n`));
  const check = box.run(repo, 'spec', 'check');
  assert.equal(check.code, 0, check.out);
  assert.match(check.out, new RegExp(`SPEC.md: ${rows.length} rows, 0 errors`));
});

test("the coordinator's resume names its next step from the spec and the board, stage by stage [N32, I9]", () => {
  const next = (box, cwd) => /^next: (.*)$/m.exec(box.run(cwd, 'resume').out)?.[1] ?? '';
  const fresh = sandbox();
  const repo = join(fresh.dir, 'fresh');
  mkdirSync(repo);
  fresh.git(repo, 'init', '-q', '-b', 'main');
  const initialized = fresh.run(repo, 'init');
  assert.match(initialized.out, /with an agent: start a new Claude Code session here, which loads the pullboard skills, then tell it what to build/, 'init tells an agent to start a new session [I9]');
  assert.match(next(fresh, repo), /^turn what the person wants into spec rows with them: the pullboard-decompose skill/);
  assert.equal(fresh.run(repo, 'add', 'coordinator', 'Tidy the readme').code, 0);
  assert.equal(fresh.run(repo, 'claim', '1').code, 0);
  assert.match(next(fresh, repo), /^turn what the person wants into spec rows with them/, "the coordinator's own claim does not jump the spec");
  writeFileSync(join(repo, 'SPEC.md'), '# Fresh\n\n## G · Goals\n- G1 [draft, must] It works. | gate: test\n');
  assert.match(next(fresh, repo), /^the person approves rows in SPEC.md; then plan them/, 'nor the approval');
  writeFileSync(join(repo, 'SPEC.md'), '# Fresh\n\n## G · Goals\n- G1 [approved, must] It works. | gate: test\n');
  assert.match(next(fresh, repo), /^build #1, commit, then pullboard submit 1/, 'then it comes first');

  const box = project();
  assert.match(next(box, box.repo), /^plan the approved rows no item cites \(G1, G2\): the pullboard-plan skill/);
  box.run(box.repo, 'add', 'web', 'Page', '--specs', 'G1');
  assert.match(next(box, box.repo), /^start a builder for each lane with open items \(web\): pullboard worktree <lane>/);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  assert.equal(commitFile(box, box.web, 'web/index.html', '<h1>hi</h1>', 'feat(web): page [G1]').status, 0);
  assert.equal(box.run(box.web, 'submit', '1').code, 0);
  assert.match(next(box, box.repo), /^pullboard next --verify --as coordinator, or a verifier that built nothing: pullboard worktree review/);
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  box.git(box.repo, 'switch', '-q', '--detach', commit);
  assert.equal(box.run(box.repo, 'verify', '1', 'accept', '--note', 'the page renders hi', '--as', 'coordinator').code, 0);
  box.git(box.repo, 'switch', '-q', 'main');
  assert.match(next(box, box.repo), new RegExp(`^merge #1: git merge --no-edit ${commit.slice(0, 12)}, run the gate, then pullboard merged 1 <merge commit>`));
  box.git(box.repo, 'merge', '-q', '--no-edit', commit);
  assert.equal(box.run(box.repo, 'merged', '1', box.git(box.repo, 'rev-parse', 'HEAD')).code, 0);
  assert.match(next(box, box.repo), /^plan the approved rows no item cites \(G2\)/);
});

test('spec check lints both files; spec view writes one page into the git dir [S6, S7]', () => {
  const box = project();
  writeFileSync(join(box.repo, 'DOCTRINE.md'), '# Doctrine\n\n## C · Code\n- C1 [approved, must] Functions under 60 lines.\n');
  const check = box.run(box.repo, 'spec', 'check');
  assert.equal(check.code, 1);
  assert.match(check.out, /DOCTRINE.md:4 C1 error: an approved must-row names its gate/);
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
  const second = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', second, '-b', 'web/two');
  assert.match(box.run(second, 'join', 'web').out, /joined as web-2/);
  assert.match(box.run(second, 'whoami').out, /^web-2 \(web lane\)/, 'a second worktree in the same lane is its own agent');
  assert.match(box.run(box.web, 'whoami').out, /^web-1 \(web lane\)/, 'and the first stays itself');
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
  assert.match(foreign.stderr, /Fix what each line names/, 'a blocked hook says what to do (C4)');
  box.git(box.web, 'reset', '-q', '--hard');
  box.git(box.web, 'clean', '-fdq');
  assert.equal(commitFile(box, box.web, 'docs/web.md', 'shared', 'docs: web notes').status, 0);
  assert.equal(commitFile(box, box.web, 'web/a.html', 'a', 'feat(web): page [G1]').status, 0);
  mkdirSync(join(box.web, 'api'));
  box.git(box.web, 'mv', 'web/a.html', 'api/a.html');
  const moved = box.tryGit(box.web, 'commit', '-q', '-m', 'refactor(web): move the page');
  assert.match(moved.stderr, /outside the web lane: api\/a.html/);
  assert.equal(commitFile(box, box.repo, 'api/b.js', 'b', 'feat(api): an api file [G2]').status, 0);
  const second = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', second, '-b', 'web/two');
  assert.match(box.run(second, 'join', 'web').out, /joined as web-2/);
  mkdirSync(join(second, 'web'), { recursive: true });
  box.git(second, 'mv', 'api/b.js', 'web/b.js');
  const taken = box.tryGit(second, 'commit', '-q', '-m', 'refactor(web): take the api file');
  assert.match(taken.stderr, /outside the web lane: api\/b.js/, 'a move counts where it left, not only where it lands');
});

test("a lane merges main's foreign changes but still refuses its own and non-main foreign changes [L3]", () => {
  const mainChange = project();
  assert.equal(commitFile(mainChange, mainChange.repo, 'api/main.js', 'from main', 'feat(api): main change [G2]').status, 0);
  const preparedMerge = mainChange.tryGit(mainChange.web, 'merge', '--no-commit', '--no-ff', 'main');
  assert.equal(preparedMerge.status, 0, preparedMerge.stderr);
  const merged = mainChange.tryGit(mainChange.web, 'commit', '-q', '-m', 'Merge main');
  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(mainChange.git(mainChange.web, 'show', 'HEAD:api/main.js'), 'from main');

  const editedDuringMerge = project();
  assert.equal(commitFile(editedDuringMerge, editedDuringMerge.repo, 'api/main.js', 'from main', 'feat(api): main change [G2]').status, 0);
  const preparedMain = editedDuringMerge.tryGit(editedDuringMerge.web, 'merge', '--no-commit', '--no-ff', 'main');
  assert.equal(preparedMain.status, 0, preparedMain.stderr);
  writeFileSync(join(editedDuringMerge.web, 'api/main.js'), 'changed in the lane merge');
  editedDuringMerge.git(editedDuringMerge.web, 'add', 'api/main.js');
  const changedForeign = editedDuringMerge.tryGit(editedDuringMerge.web, 'commit', '-q', '-m', 'Merge main');
  assert.notEqual(changedForeign.status, 0);
  assert.match(changedForeign.stderr, /outside the web lane: api\/main.js/);

  const sideBranch = project();
  sideBranch.git(sideBranch.repo, 'switch', '-q', '-c', 'side');
  assert.equal(commitFile(sideBranch, sideBranch.repo, 'api/side.js', 'from side', 'feat(api): side change [G2]').status, 0);
  sideBranch.git(sideBranch.repo, 'switch', '-q', 'main');
  const preparedSide = sideBranch.tryGit(sideBranch.web, 'merge', '--no-commit', '--no-ff', 'side');
  assert.equal(preparedSide.status, 0, preparedSide.stderr);
  const changedSide = sideBranch.tryGit(sideBranch.web, 'commit', '-q', '-m', 'Merge side');
  assert.notEqual(changedSide.status, 0);
  assert.match(changedSide.stderr, /outside the web lane: api\/side.js/);
});

test('submit needs a clean tree, nothing untracked, and the gate green at HEAD [V4, B9]', () => {
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

test('submit keeps its machine gate slot until the submitted check finishes [V4,Q4]', async () => {
  const box = sandbox();
  const gate = holdingGate(box);
  const projectBox = project(gate.command, box);
  assert.equal(projectBox.run(projectBox.repo, 'settings', 'gateSlots', '1').code, 0);
  projectBox.run(projectBox.repo, 'add', 'web', 'Page', '--specs', 'G1');
  assert.match(projectBox.run(projectBox.web, 'claim', '1').out, /claimed #1/);
  assert.equal(commitFile(projectBox, projectBox.web, 'web/page.html', 'page', 'feat(web): page [G1]').status, 0);
  writeFileSync(gate.mode, 'armed');
  const children = [];
  try {
    const submitted = launch(projectBox, projectBox.web, process.execPath, [BIN, 'submit', '1']);
    children.push(submitted);
    await waitFor(() => gateEvents(gate).includes('start'), 'submit gate to start and hold its resource');
    const competitor = launch(projectBox, projectBox.repo, process.execPath, [BIN, 'gate']);
    children.push(competitor);
    await waitFor(() => competitor.stdoutText.includes('place 1'), 'another gate to wait behind submit');
    assert.deepEqual(gateEvents(gate), ['start']);
    writeFileSync(gate.release, 'released');
    const [submitResult, competitorResult] = await Promise.all([submitted.closed, competitor.closed]);
    assert.equal(submitResult.code, 0, submitted.stderrText);
    assert.match(submitted.stdoutText, /submitted #1/);
    assert.equal(competitorResult.code, 0, competitor.stderrText);
    assert.deepEqual(gateEvents(gate), ['start', 'end', 'start', 'end']);
  } finally {
    writeFileSync(gate.release, 'released');
    await Promise.all(children.map((child) => child.closed));
  }
});

test('pre-push keeps its machine gate slot until the hook check finishes [C3,Q4]', async () => {
  const box = sandbox();
  const gate = holdingGate(box);
  const projectBox = project(gate.command, box);
  const remote = join(box.dir, 'remote.git');
  projectBox.git(box.dir, 'init', '-q', '--bare', remote);
  projectBox.git(projectBox.repo, 'remote', 'add', 'origin', remote);
  assert.equal(projectBox.run(projectBox.repo, 'settings', 'gateSlots', '1').code, 0);
  writeFileSync(gate.mode, 'armed');
  const children = [];
  try {
    const pushed = launch(projectBox, projectBox.repo, 'git', ['push', '-q', 'origin', 'main']);
    children.push(pushed);
    await waitFor(() => gateEvents(gate).includes('start'), 'pre-push gate to start and hold its resource');
    const competitor = launch(projectBox, projectBox.web, process.execPath, [BIN, 'gate']);
    children.push(competitor);
    await waitFor(() => competitor.stdoutText.includes('place 1'), 'another gate to wait behind pre-push');
    assert.deepEqual(gateEvents(gate), ['start']);
    writeFileSync(gate.release, 'released');
    const [pushResult, competitorResult] = await Promise.all([pushed.closed, competitor.closed]);
    assert.equal(pushResult.code, 0, pushed.stderrText);
    assert.equal(competitorResult.code, 0, competitor.stderrText);
    assert.deepEqual(gateEvents(gate), ['start', 'end', 'start', 'end']);
  } finally {
    writeFileSync(gate.release, 'released');
    await Promise.all(children.map((child) => child.closed));
  }
});

test('decisions are asked, listed and answered, and evidence attached, from the command line [B21, B22, B26]', () => {
  const box = project();
  box.run(box.repo, 'add', 'web', 'Page', '--specs', 'G1');
  const asked = box.run(box.web, 'shout', 'coordinator', 'ship', 'today?', '--decision');
  assert.equal(asked.code, 0, asked.err);
  const id = /as #(\d+)/.exec(asked.out)?.[1];
  assert.ok(id, asked.out);
  assert.match(box.run(box.repo, 'decisions').out, new RegExp(`#${id} {2}web-1 -> coordinator, \\d+m ago: ship today\\?`));
  assert.match(box.run(box.repo, 'inbox').out, new RegExp(`web-1 -> coordinator: asks for a decision \\(#${id}; pullboard answer ${id}`));
  const wrongActor = box.run(box.repo, 'answer', id, 'yes, today', '--as', 'person');
  assert.notEqual(wrongActor.code, 0);
  assert.match(wrongActor.err, /B26_PERSON_ANSWER.*person mode answers only/);
  assert.match(box.run(box.repo, 'answer', id, 'yes, today').out, new RegExp(`answered #${id} to web-1 as #\\d+`));
  assert.match(box.run(box.repo, 'decisions').out, /no open decisions/);
  assert.match(box.run(box.web, 'inbox').out, new RegExp(`coordinator -> web-1: answers #${id}: yes, today`));
  const head = box.git(box.web, 'rev-parse', 'HEAD');
  const proved = box.run(box.web, 'shout', 'coordinator', 'FINISH', 'the page', '--evidence', 'receipt', '--outcome', 'measured', '--item', '1', '--commit', 'HEAD');
  assert.equal(proved.code, 0, proved.err);
  assert.match(box.run(box.repo, 'inbox').out, new RegExp(`web-1 -> coordinator: FINISH the page\\n {2}receipt: measured, #1 at ${head.slice(0, 12)}`));
  assert.match(box.run(box.web, 'shout', 'coordinator', 'x', '--evidence', 'receipt', '--outcome', 'measured', '--item', '1', '--commit', 'nope').err, /BAD_EVIDENCE.*"nope"/);
});

test('decisions default up the chain, pass to the person, and return to the original asker [B25, B26, B27]', () => {
  const box = project();
  const asked = box.run(box.web, 'shout', 'Ship the patch?', '--decision');
  assert.equal(asked.code, 0, asked.err);
  const id = /as #(\d+)/.exec(asked.out)?.[1];
  assert.ok(id, asked.out);
  assert.match(box.run(box.repo, 'decisions').out, new RegExp(`#${id} {2}web-1 -> coordinator`));
  const passed = box.run(box.repo, 'pass', id, 'the checks are green');
  assert.equal(passed.code, 0, passed.err);
  const personId = /as #(\d+)/.exec(passed.out)?.[1];
  assert.ok(personId, passed.out);
  assert.match(box.run(box.repo, 'decisions', '--as', 'person').out, new RegExp(`#${personId} {2}coordinator -> person`));
  const personModeFromAgent = box.run(box.web, 'decisions', '--as', 'person');
  assert.notEqual(personModeFromAgent.code, 0);
  assert.match(personModeFromAgent.err, /B26_PERSON_ANSWER.*main checkout/);
  const agentPersonAnswer = box.run(box.web, 'answer', personId, 'Ship it.', '--as', 'person');
  assert.notEqual(agentPersonAnswer.code, 0);
  assert.match(agentPersonAnswer.err, /B26_PERSON_ANSWER.*main checkout/);
  const agentAnswer = box.run(box.web, 'answer', personId, 'Ship it.');
  assert.notEqual(agentAnswer.code, 0);
  assert.match(agentAnswer.err, /NOT_YOUR_DECISION/);
  const coordinatorAnswer = box.run(box.repo, 'answer', personId, 'Ship it.', '--json');
  assert.notEqual(coordinatorAnswer.code, 0);
  const answerRefusal = JSON.parse(coordinatorAnswer.out);
  assert.equal(answerRefusal.error.code, 'B26_PERSON_ANSWER');
  assert.match(answerRefusal.error.next, new RegExp(`pullboard answer ${personId} "<answer>" --as person`));
  assert.match(box.run(box.repo, 'answer', personId, 'Ship it.', '--as', 'person').out, new RegExp(`person answered #${personId}; notified web-1`));
  assert.match(box.run(box.web, 'resume').out, new RegExp(`newest from person: Person answered #${personId}: Ship it\\.`));
  assert.match(box.run(box.web, 'inbox').out, new RegExp(`person -> web-1: answers #${id}: Person answered #${personId}: Ship it\\.`));
  assert.match(box.run(box.repo, 'decisions').out, /no open decisions/);
  const refused = box.run(box.web, 'shout', 'person', 'Ship?', '--decision', '--json');
  assert.notEqual(refused.code, 0);
  const refusal = JSON.parse(refused.out);
  assert.equal(refusal.error.code, 'B26_PERSON_DECISION');
  assert.match(refusal.error.next, /ask your coordinator: pullboard shout coordinator/);
  const coordinatorAsk = box.run(box.repo, 'shout', 'Should we publish?', '--decision');
  assert.equal(coordinatorAsk.code, 0, coordinatorAsk.err);
  assert.match(coordinatorAsk.out, /asked person for a decision/);
  const personDecision = /as #(\d+)/.exec(coordinatorAsk.out)?.[1];
  assert.ok(personDecision, coordinatorAsk.out);
  const defaultPersonAnswer = box.run(box.repo, 'answer', personDecision, 'Yes.');
  assert.notEqual(defaultPersonAnswer.code, 0);
  assert.match(defaultPersonAnswer.err, /B26_PERSON_ANSWER.*--as person/);
  assert.equal(box.run(box.repo, 'answer', personDecision, 'Yes.', '--as', 'person').code, 0);
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

test("a worktree starts only from a commit that holds pullboard's files as the main checkout has them [I4, C4]", () => {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  assert.equal(box.run(repo, 'init').code, 0);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify(CONFIG, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  writeFileSync(join(repo, 'notes.txt'), 'mine\n');
  const nothingMade = () => {
    assert.ok(!existsSync(join(box.dir, 'repo-web-1')), 'no folder');
    assert.notEqual(box.tryGit(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/web/1').status, 0, 'no branch');
  };
  /** Refused, with the files it names; returns the command it gives. */
  const refused = (pattern, named) => {
    const said = box.run(repo, 'worktree', 'web');
    assert.equal(said.code, 1, said.out);
    assert.match(said.err, pattern);
    for (const file of named) assert.ok(said.err.includes(file), `names ${file}: ${said.err}`);
    assert.ok(!said.err.includes('notes.txt'), 'leaves the person\'s own files out');
    nothingMade();
    const [, command] = said.err.match(/Commit them first: (.*)\n/);
    assert.ok(command.startsWith(`cd ${repo} && git add -- `), command);
    return command;
  };
  const sh = (command) => execFileSync('sh', ['-c', command], { env: box.env, encoding: 'utf8', stdio: 'pipe' });

  const first = refused(/\[NOT_COMMITTED\] this repo has no commit yet, and a new worktree starts from one; not committed: /, [
    '.githooks/pre-commit',
    'AGENTS.md',
    'DOCTRINE.md',
    'SPEC.md',
    'pullboard.json',
  ]);
  sh(first);
  for (const file of ['.githooks/pre-commit', 'AGENTS.md', 'DOCTRINE.md', 'SPEC.md', 'pullboard.json']) {
    assert.equal(box.git(repo, 'ls-tree', '--name-only', 'HEAD', '--', file), file, `${file} is committed`);
  }
  assert.equal(box.git(repo, 'ls-tree', '--name-only', 'HEAD', '--', 'notes.txt'), '', 'the command commits only those files');

  writeFileSync(join(repo, 'SPEC.md'), `${SPEC}- G3 [draft, aim] A third goal. | gate: test\n`);
  writeFileSync(join(repo, '.githooks', 'post-checkout'), '#!/bin/sh\n');
  rmSync(join(repo, 'DOCTRINE.md'));
  box.git(repo, 'add', 'notes.txt');
  refused(/\[NOT_COMMITTED\] a new worktree starts from the last commit, and these differ from it here: /, [
    '.githooks/post-checkout (not committed)',
    'DOCTRINE.md (deleted)',
    'SPEC.md (changed)',
  ]);
  box.git(repo, 'checkout', '--', 'DOCTRINE.md');
  sh(refused(/these differ from it here: \.githooks\/post-checkout \(not committed\), SPEC\.md \(changed\)\. /, []));
  assert.equal(box.git(repo, 'diff', '--cached', '--name-only'), 'notes.txt', "the person's staged file stays staged, and out of the commit");

  const made = box.run(repo, 'worktree', 'web');
  assert.equal(made.code, 0, made.err);
  assert.match(made.out, /repo-web-1 on branch web\/1, joined as web-1 in the web lane/, 'the refusals made nothing and joined no one');
  const web = join(box.dir, 'repo-web-1');
  assert.ok(readFileSync(join(web, 'SPEC.md'), 'utf8').includes('- G3 [draft'), 'it starts with the spec as committed');
  const foreign = commitFile(box, web, 'api/a.js', 'a', 'feat(web): page [G1]');
  assert.match(foreign.stderr, /outside the web lane: api\/a.js/, 'its hooks run');
});

test('a hook git ignores is committed by force before a worktree; a deleted config is restored, never re-initialized [I4, C4]', () => {
  const box = project();
  const sh = (command) => execFileSync('sh', ['-c', command], { env: box.env, encoding: 'utf8', stdio: 'pipe' });
  writeFileSync(join(box.repo, '.gitignore'), '.githooks/post-checkout\n');
  box.git(box.repo, 'add', '.gitignore');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: ignore a local hook');
  writeFileSync(join(box.repo, '.githooks', 'post-checkout'), '#!/bin/sh\n');
  const ignored = box.run(box.repo, 'worktree', 'web');
  assert.equal(ignored.code, 1, ignored.out);
  assert.match(ignored.err, /\[NOT_COMMITTED\] a new worktree starts from the last commit, and these differ from it here: \.githooks\/post-checkout \(not committed; git ignores it\)\. /);
  assert.ok(!existsSync(join(box.dir, 'repo-web-1')), 'no folder');
  const [, command] = ignored.err.match(/Commit them first: (.*)\n/);
  assert.ok(command.includes(' && git add -f -- .githooks/post-checkout && git commit '), command);
  sh(command);
  assert.equal(box.git(box.repo, 'ls-tree', '--name-only', 'HEAD', '--', '.githooks/post-checkout'), '.githooks/post-checkout', 'the ignored hook is committed');
  const made = box.run(box.repo, 'worktree', 'web');
  assert.equal(made.code, 0, made.err);
  assert.ok(existsSync(join(box.dir, 'repo-web-1', '.githooks', 'post-checkout')), 'the worktree has the hook the main checkout runs');

  box.git(box.repo, 'rm', '-q', 'pullboard.json');
  const restore = `cd ${box.repo} && git checkout HEAD -- pullboard.json`;
  for (const args of [['worktree', 'web'], ['status'], ['next']]) {
    const said = box.run(box.repo, ...args);
    assert.equal(said.code, 1, said.out);
    assert.ok(said.err.includes(`[NO_CONFIG] pullboard.json is deleted here, though this checkout's last commit has it: restore it: ${restore}\n`), said.err);
    assert.ok(!said.err.includes('pullboard init'), `${args[0]} never says to run init`);
  }
  assert.ok(!existsSync(join(box.dir, 'repo-web-2')), 'the refused worktree made nothing');
  sh(restore);
  assert.equal(box.run(box.repo, 'status').code, 0, 'restored, the board works again');
  rmSync(join(box.web, 'pullboard.json'));
  assert.ok(box.run(box.web, 'next').err.includes(`restore it: cd ${box.web} && git checkout HEAD -- pullboard.json`), 'a linked worktree restores its own');
});

test('a worktree whose commit has no pullboard.json is sent to the main checkout, never told to run init [C4]', () => {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# app\n');
  box.git(repo, 'add', 'README.md');
  box.git(repo, 'commit', '-q', '-m', 'docs: readme');
  assert.equal(box.run(repo, 'init').code, 0);
  const old = join(box.dir, 'old');
  box.git(repo, 'worktree', 'add', '-q', '--detach', old, 'HEAD');
  for (const command of [['next'], ['status'], ['join', 'web']]) {
    const said = box.run(old, ...command);
    assert.equal(said.code, 1, said.out);
    assert.match(said.err, /\[NO_CONFIG\] this worktree's commit has no pullboard\.json, though the main checkout has one: /);
    assert.ok(said.err.includes(`which says what to commit first: cd ${repo} && pullboard worktree <lane>`), said.err);
    assert.ok(!said.err.includes('pullboard init'), `${command[0]} never says to run init`);
  }
  const plain = join(box.dir, 'plain');
  mkdirSync(plain);
  box.git(plain, 'init', '-q');
  assert.match(box.run(plain, 'next').err, /\[NO_CONFIG\] no pullboard\.json in .*; run: pullboard init/, 'a repo with no pullboard is still told to init');
});

test('a red gate refuses submit [V4]', () => {
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

test('verify runs at the submitted commit, against the criterion frozen at claim [V3, V7, V9]', () => {
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
  assert.equal(box.run(box.repo, 'spec', 'approve', 'G1').code, 0);
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

test('unsupported spec grammar keeps claim, refreeze, submit and verify refusals typed [A5,A1,M1]', () => {
  const marker = '<!-- pullboard-grammar 2 -->\n';
  const setup = () => {
    const box = project();
    assert.equal(box.run(box.repo, 'add', 'web', 'Page', '--specs', 'G1', '--criterion', 'renders').code, 0);
    return box;
  };
  const claimBox = setup();
  writeFileSync(join(claimBox.web, 'SPEC.md'), marker + SPEC);
  for (const args of [['claim', '1'], ['next']]) {
    const refused = claimBox.run(claimBox.web, ...args);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /A5_GRAMMAR_VERSION.*grammar 2.*grammar 1/);
  }
  const claimJson = claimBox.run(claimBox.web, 'claim', '1', '--json');
  assert.equal(claimJson.code, 1);
  assert.equal(JSON.parse(claimJson.out).error.code, 'A5_GRAMMAR_VERSION');
  writeFileSync(join(claimBox.repo, 'SPEC.md'), marker + SPEC);
  const refreeze = claimBox.run(claimBox.repo, 'refreeze', '1');
  assert.equal(refreeze.code, 1);
  assert.match(refreeze.err, /A5_GRAMMAR_VERSION/);
  const refreezeJson = claimBox.run(claimBox.repo, 'refreeze', '1', '--json');
  assert.equal(refreezeJson.code, 1);
  assert.equal(JSON.parse(refreezeJson.out).error.code, 'A5_GRAMMAR_VERSION');

  const submitBox = setup();
  assert.equal(submitBox.run(submitBox.web, 'claim', '1').code, 0);
  commitFile(submitBox, submitBox.web, 'web/page.html', '<h1>Page</h1>', 'feat(web): add page [G1]');
  writeFileSync(join(submitBox.web, 'SPEC.md'), marker + SPEC);
  const submit = submitBox.run(submitBox.web, 'submit', '1');
  assert.equal(submit.code, 1);
  assert.match(submit.err, /A5_GRAMMAR_VERSION/);
  const submitJson = submitBox.run(submitBox.web, 'submit', '1', '--json');
  assert.equal(submitJson.code, 1);
  assert.equal(JSON.parse(submitJson.out).error.code, 'A5_GRAMMAR_VERSION');

  const verifyBox = setup();
  assert.equal(verifyBox.run(verifyBox.web, 'claim', '1').code, 0);
  commitFile(verifyBox, verifyBox.web, 'web/page.html', '<h1>Page</h1>', 'feat(web): add page [G1]');
  assert.equal(verifyBox.run(verifyBox.web, 'submit', '1').code, 0);
  verifyBox.git(verifyBox.repo, 'switch', '--detach', 'web/one');
  writeFileSync(join(verifyBox.repo, 'SPEC.md'), marker + SPEC);
  const verify = verifyBox.run(verifyBox.repo, 'verify', '1', 'accept', '--as', 'coordinator', '--note', 'checked');
  assert.equal(verify.code, 1);
  assert.match(verify.err, /A5_GRAMMAR_VERSION/);
  const verifyJson = verifyBox.run(verifyBox.repo, 'verify', '1', 'accept', '--as', 'coordinator', '--note', 'checked', '--json');
  assert.equal(verifyJson.code, 1);
  assert.equal(JSON.parse(verifyJson.out).error.code, 'A5_GRAMMAR_VERSION');
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
  assert.match(`${elsewhere.stdout}${elsewhere.stderr}`, /the gate passed on this exact tree; not running it twice/, 'the second push of a passed tree skips the gate');
  commitFile(box, box.web, 'web/b.html', 'b', 'feat(web): second page [G1]');
  const notHere = box.tryGit(box.repo, 'push', '-q', 'origin', 'web/one');
  assert.notEqual(notHere.status, 0);
  assert.match(notHere.stderr, /is not checked out/);
});

/**
 * A gate/fixer that runs Git in two other folders. Even a failed ordinary-repo probe ends by
 * initializing the bare probe, so removing isolation visibly corrupts only this private fixture.
 */
function foreignGitScript(box, name, { fixer = false } = {}) {
  const file = join(box.dir, `${name}.cjs`);
  const ordinary = join(box.dir, `${name}-repo`);
  const bare = join(box.dir, `${name}-bare.git`);
  writeFileSync(file, [
    "const fs = require('node:fs'); const cp = require('node:child_process');",
    `const ordinary = ${JSON.stringify(ordinary)}; const bare = ${JSON.stringify(bare)};`,
    "fs.mkdirSync(ordinary); fs.mkdirSync(bare);",
    "let failed = false;",
    "const run = (cwd, args) => { const r = cp.spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10000 }); if (r.status !== 0) { failed = true; console.error(r.stderr); } };",
    "run(ordinary, ['init', '-q', '-b', 'main']);",
    "fs.writeFileSync(ordinary + '/probe.txt', 'its own repository\\n');",
    "run(ordinary, ['add', 'probe.txt']); run(ordinary, ['commit', '-q', '-m', 'chore: foreign probe']);",
    "run(bare, ['init', '-q', '--bare']);",
    ...(fixer ? ["if (!failed) for (const file of process.argv.slice(2)) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').trimEnd() + '\\n');"] : []),
    "process.exitCode = failed ? 1 : 0;",
  ].join('\n'));
  return { file, ordinary, bare };
}

test('a linked-worktree push isolates the gate from Git hook variables and leaves both repos intact [C3]', () => {
  const box = project();
  const probe = foreignGitScript(box, 'gate');
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...CONFIG, gate: `node ${JSON.stringify(probe.file)}` }));
  box.git(box.repo, 'commit', '-qam', 'chore: a gate with foreign git commands');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const remote = join(box.dir, 'remote.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  const head = box.git(box.web, 'rev-parse', 'HEAD');
  const pushed = box.tryGit(box.web, 'push', '-q', 'origin', 'web/one');
  assert.equal(box.git(box.repo, 'config', '--get', 'core.bare'), 'false', 'the real hook repo stays non-bare; without isolation this is true');
  assert.equal(pushed.status, 0, `${pushed.stdout}${pushed.stderr}`);
  assert.equal(box.git(remote, 'rev-parse', 'refs/heads/web/one'), head, 'the checked-out commit reached the private local remote');
  assert.equal(box.git(probe.bare, 'rev-parse', '--is-bare-repository'), 'true');
  assert.equal(box.git(probe.ordinary, 'log', '-1', '--format=%s'), 'chore: foreign probe');
  assert.equal(readFileSync(join(probe.ordinary, 'probe.txt'), 'utf8'), 'its own repository\n');
  assert.equal(box.git(box.web, 'status', '--porcelain'), '');
});

test('a linked-worktree commit isolates fixers while its own staged index still works [C5]', () => {
  const box = project();
  const probe = foreignGitScript(box, 'fixer', { fixer: true });
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...CONFIG, fix: [{ run: `node ${JSON.stringify(probe.file)}`, files: ['*.js'] }] }));
  box.git(box.repo, 'commit', '-qam', 'chore: a fixer with foreign git commands');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web', 'probe.js'), 'const value = 1;   \n');
  box.git(box.web, 'add', 'web/probe.js');
  const committed = box.tryGit(box.web, 'commit', '-q', '-m', 'feat(web): a formatted probe [G1]');
  assert.equal(box.git(box.repo, 'config', '--get', 'core.bare'), 'false');
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(box.git(probe.bare, 'rev-parse', '--is-bare-repository'), 'true');
  assert.equal(box.git(probe.ordinary, 'log', '-1', '--format=%s'), 'chore: foreign probe');
  assert.equal(box.git(box.web, 'show', 'HEAD:web/probe.js'), 'const value = 1;', 'the parent hook restaged the formatted file through its own index');
  assert.equal(box.git(box.web, 'status', '--porcelain'), '');
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

test('next --verify can reserve a named submitted review and default to the lowest free one [V15]', () => {
  const box = project();
  const reviewers = ['api-1', 'api-2'].map((name) => {
    const path = join(box.dir, name);
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', path);
    const joined = box.run(path, 'join', 'api');
    assert.equal(joined.code, 0, joined.err);
    return path;
  });
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  let first;
  let second;
  try {
    const commit = box.git(box.repo, 'rev-parse', 'HEAD');
    const tree = box.git(box.repo, 'rev-parse', 'HEAD^{tree}');
    /** Create and submit an item through the real SQLite board state. */
    const submit = (title) => {
      const id = store.addItem(board, { by: 'coordinator', lane: 'web', title });
      store.claim(board, id, {
        agentId: 'web-1', lane: 'web', leaseMs: 60 * 60_000,
        freeze: (item) => ({ text: item.item_title, digest: `digest:${item.item_title}` }),
      });
      store.submit(board, id, { agentId: 'web-1', commit, tree });
      return id;
    };
    first = submit('First review');
    second = submit('Second review');
  } finally {
    store.closeBoard(board);
  }

  const named = box.run(reviewers[0], 'next', '--verify', String(second));
  assert.equal(named.code, 0, named.err);
  assert.match(named.out, new RegExp(`next to verify: #${second} Second review, built by web-1`));
  assert.match(named.out, new RegExp(`check out exactly that commit, here: cd ${reviewers[0]} && git switch --detach [0-9a-f]{40}`));
  const namedJson = box.run(reviewers[0], 'next', '--verify', String(second), '--json');
  assert.equal(namedJson.code, 0, namedJson.err);
  const result = JSON.parse(namedJson.out);
  assert.equal(result.version, 1);
  assert.equal(result.item.item_id, second);
  assert.equal(result.review, true);
  assert.equal(result.held, false);
  assert.deepEqual(result.shared, []);
  const reserved = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    assert.equal(store.getItem(reserved, second).item_review_by, 'api-1', 'the named item is reserved for the caller');
  } finally {
    store.closeBoard(reserved);
  }

  const held = box.run(reviewers[1], 'next', '--verify', String(second));
  assert.equal(held.code, 1, held.out);
  assert.match(held.err, /REVIEW_HELD/);
  const builder = box.run(box.web, 'next', '--verify', String(first));
  assert.equal(builder.code, 1, builder.out);
  assert.match(builder.err, /SELF_VERIFY/);

  const lowest = box.run(reviewers[1], 'next', '--verify');
  assert.equal(lowest.code, 0, lowest.err);
  assert.match(lowest.out, new RegExp(`next to verify: #${first} First review, built by web-1`));
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
  assert.equal(added.code, 0, added.err);
  assert.equal(added.out.trim(), `#2\ncheck baseline red at main ${box.git(box.repo, 'rev-parse', 'main')}: test -f web/page.js`);
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
  assert.match(fresh.out, /next: pullboard next \(1 ready in your lane\)/);
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
  const plainEnv = { ...box.env, TMPDIR: box.dir };
  delete plainEnv.NO_COLOR;
  delete plainEnv.FORCE_COLOR;
  const started = Date.now();
  const shown = spawnSync(process.execPath, [BIN, 'tour'], { cwd: box.dir, env: plainEnv, encoding: 'utf8' });
  assert.equal(shown.status, 0, `${shown.stdout}${shown.stderr}`);
  assert.ok(Date.now() - started < 30_000, 'thirty seconds');
  assert.doesNotMatch(shown.stdout, /\u001b\[/, 'piped output stays plain');
  assert.match(shown.stdout, /review-1 \$ pullboard verify 1 reject --reason BEHAVIOR_MISMATCH/);
  assert.match(shown.stdout, /sent back: #1 BEHAVIOR_MISMATCH by review-1: greet\(''\) returns "Hello, !"/);
  assert.match(shown.stdout, /with the fix removed\n {7}# pass 1\n {7}# fail 1/);
  assert.match(shown.stdout, /verified #1: CRITERION_MET/);
  assert.match(shown.stdout, /\| 1 \| app \| Greeting \| G1 \| app-1 \| review-1 \|/);

  const forced = spawnSync(process.execPath, [BIN, 'tour'], { cwd: box.dir, env: { ...plainEnv, FORCE_COLOR: '1' }, encoding: 'utf8' });
  assert.equal(forced.status, 0, `${forced.stdout}${forced.stderr}`);
  assert.match(forced.stdout, /\u001b\[1m1  The person approved one spec row\. The coordinator files it as work\.\u001b\[0m/);
  assert.match(forced.stdout, /\u001b\[36mcoordinator\u001b\[0m \$/);
  assert.match(forced.stdout, /\u001b\[33mapp-1\u001b\[0m \$/);
  assert.match(forced.stdout, /\u001b\[35mreview-1\u001b\[0m \$/);
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
    .replace(/claimed #1 until \S+ criterion frozen/g, 'claimed #1 until <time> criterion frozen');
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
  assert.match(green.out, /^check #1 set by coordinator:/);
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
  assert.ok(made.includes(`  You are web-1, in the web lane. Work only in ${quoted}, and start every command with cd ${quoted} &&\n`), made);
  assert.ok(made.includes(`  Read '${folder.replaceAll("'", "'\\''")}/AGENTS.md' first. Its rules govern this work, over any other repo's instructions you were given.\n`), made);
  // Pasted into a shell as printed, the line enters the real folder: nothing in the path expands.
  const cdLine = /start every command with (cd .+ &&)\n/.exec(made)[1];
  const entered = spawnSync('sh', ['-c', `${cdLine} pwd`], { env: { ...box.env, PULLBOARD_PATH_PROBE: 'elsewhere' }, encoding: 'utf8' });
  assert.equal(entered.stdout.trim(), folder);
});

/**
 * Start `pullboard view` in a folder and read the link it prints; stop() ends it.
 */
async function startView(box, cwd) {
  const child = spawn(process.execPath, [BIN, 'view', '--no-open'], { cwd, env: box.env });
  const link = await new Promise((found, fail) => {
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const match = /Pullboard view: (http:\/\/127\.0\.0\.1:\d+\/\?k=\S+)/.exec(out);
      if (match) found(new URL(match[1]));
    });
    child.on('exit', (code) => fail(new Error(`view exited ${code}: ${out}`)));
  });
  const key = link.searchParams.get('k');
  const base = `http://127.0.0.1:${link.port}`;
  const headers = { 'x-pullboard-key': key };
  /**
   * Fetch the page through either the accepted printed-key response or the cookie exchange.
   * Keeping these paths in one fixture lets the API assertions stay independent of page auth.
   */
  const page = async () => {
    const response = await fetch(link, { redirect: 'manual' });
    if (response.status === 200) return response;
    assert.equal(response.status, 303, 'the printed link either serves the legacy page or exchanges its key');

    const rawLocation = response.headers.get('location');
    assert.ok(rawLocation, 'the cookie exchange has a redirect target');
    const location = new URL(rawLocation, base);
    assert.equal(location.origin, new URL(base).origin, 'the cookie exchange stays on this view origin');
    assert.equal(location.pathname, '/', 'the cookie exchange returns to the clean page path');
    assert.equal(location.search, '', 'the redirect does not keep credentials in the address');
    assert.equal(location.hash, '', 'the redirect has no credential-bearing fragment');

    const cookies = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie')].filter(Boolean);
    assert.equal(cookies.length, 1, 'the exchange sets one session cookie');
    const [pair, ...attributes] = cookies[0].split(';').map((part) => part.trim());
    assert.match(pair, /^[A-Za-z0-9_-]+=[A-Za-z0-9._~-]+$/u, 'the session cookie has a valid nonempty name and value');
    assert.ok(attributes.some((attribute) => /^httponly$/iu.test(attribute)), 'the session cookie is HttpOnly');
    assert.ok(attributes.some((attribute) => /^samesite=strict$/iu.test(attribute)), 'the session cookie is SameSite=Strict');
    assert.ok(attributes.some((attribute) => /^path=\/$/iu.test(attribute)), 'the session cookie is scoped to the view');

    const pageResponse = await fetch(location, { headers: { cookie: pair }, redirect: 'manual' });
    assert.equal(pageResponse.status, 200, 'the cookie jar fetches the page after the exchange');
    return pageResponse;
  };
  /** Read the public listing through the view's real authenticated API. */
  const boards = async () => {
    const response = await fetch(`${base}/api/v1/boards`, { headers });
    return { status: response.status, document: await response.json() };
  };
  /** Resolve a registered board id and read its public state. */
  const state = async (root) => {
    const listing = await boards();
    if (listing.status !== 200) return listing;
    const board = listing.document.boards.find((entry) => entry.root === root);
    if (!board) return { ...listing.document, project: null };
    const response = await fetch(`${base}/api/v1/boards/${encodeURIComponent(board.id)}/state`, { headers });
    return { ...listing.document, project: (await response.json()).state };
  };
  /** Send a public move to the registered board or a deliberately unknown id. */
  const act = async (root, body) => {
    const listing = await boards();
    const board = listing.document.boards?.find((entry) => entry.root === root);
    const id = board?.id ?? '0'.repeat(32);
    const response = await fetch(`${base}/api/v1/boards/${encodeURIComponent(id)}/moves`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, document: await response.json() };
  };
  const stop = () => new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    child.once('exit', done);
    child.kill('SIGTERM');
  });
  return { link, key, base, page, state, act, stop };
}

test('view serves every project on this machine, on loopback, behind its secret and its own Host [N26, I8]', async () => {
  const box = project();
  box.run(box.repo, 'add', 'web', 'Page', '--specs', 'G1', '--criterion', 'renders');
  box.run(box.repo, 'shout', 'web-1', 'the heading is in G1');
  const registry = JSON.parse(readFileSync(join(box.env.PULLBOARD_HOME, 'projects.json'), 'utf8'));
  assert.deepEqual(registry.projects.map((entry) => entry.root), [box.repo]);
  const view = await startView(box, box.repo);
  try {
    assert.equal((await fetch(`${view.base}/`)).status, 403, 'no secret');
    const badSecret = await fetch(`${view.base}/api/v1/boards`, { headers: { 'x-pullboard-key': 'guess' } });
    assert.equal(badSecret.status, 401, 'a wrong secret');
    assert.equal((await badSecret.json()).error.code, 'AUTH_REQUIRED');
    const page = await view.page();
    assert.match(await page.text(), /<title>Pullboard<\/title>/);
    const { boards, warnings, project: shown } = await view.state(box.repo);
    assert.deepEqual(boards.map((entry) => [entry.root, entry.name]), [[box.repo, 'repo']]);
    assert.deepEqual(warnings, []);
    assert.equal(shown.items.filter((item) => item.status === 'open').length, 1);
    assert.deepEqual(shown.items.map((item) => [item.id, item.title, item.status, item.specs]), [[1, 'Page', 'open', ['G1']]]);
    assert.equal(shown.shouts[0].shout_text, 'the heading is in G1');
    assert.deepEqual(shown.spec.map((row) => [row.id, row.status]), [['G1', 'approved'], ['G2', 'approved']]);
    assert.ok(shown.agents.some((agent) => agent.agent_id === 'web-1'));
    const rebound = await new Promise((done) => {
      request({ host: '127.0.0.1', port: view.link.port, path: '/api/v1/boards', headers: { host: `evil.example:${view.link.port}`, 'x-pullboard-key': view.key } }, (res) => done(res.statusCode)).end();
    });
    assert.equal(rebound, 401, 'the right secret from another Host, as DNS rebinding would send it');
  } finally {
    await view.stop();
  }
});

test('from the view the person adds items, shouts and holds lanes, through the CLI and its refusals [N27]', async () => {
  const box = project();
  const view = await startView(box, box.repo);
  try {
    const added = await view.act(box.repo, { verb: 'add', args: { lane: 'web', title: 'From the view', specs: 'G1' } });
    assert.equal(added.status, 200, JSON.stringify(added.document));
    assert.equal(added.document.event.event_kind, 'add');
    assert.equal(added.document.result.item.item_title, 'From the view');
    assert.equal(JSON.parse(box.run(box.repo, 'show', '1', '--json').out).item_title, 'From the view');
    const refused = await view.act(box.repo, { verb: 'add', args: { lane: 'web', title: 'Ghost', specs: 'Z9' } });
    assert.equal(refused.status, 409);
    assert.equal(refused.document.error.code, 'UNKNOWN_SPEC');
    const shouted = await view.act(box.repo, { verb: 'shout', args: { to: 'web', text: 'from the person' } });
    assert.equal(shouted.status, 200);
    assert.equal(shouted.document.event.event_kind, 'shout');
    assert.match(box.run(box.web, 'inbox').out, /coordinator -> web: from the person/);
    const held = await view.act(box.repo, { verb: 'hold', args: { lane: 'web', reason: 'G1 is changing' } });
    assert.equal(held.status, 200);
    assert.equal(held.document.event.event_kind, 'hold');
    assert.match(box.run(box.web, 'next').err, /coordinator holds the web lane: G1 is changing/);
    const released = await view.act(box.repo, { verb: 'hold', args: { lane: 'web', off: true } });
    assert.equal(released.status, 200);
    assert.equal(released.document.event.event_kind, 'unhold');
    const unknown = await view.act(box.dir, { verb: 'shout', args: { to: 'all', text: 'x' } });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.document.error.code, 'NO_BOARD');
    const before = await view.state(box.repo);
    const target = before.boards.find((entry) => entry.root === box.repo);
    const stranger = await fetch(`${view.base}/api/v1/boards/${encodeURIComponent(target.id)}/moves`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verb: 'shout', args: { to: 'all', text: 'unauthorized move' } }),
    });
    assert.equal(stranger.status, 401);
    assert.equal((await stranger.json()).error.code, 'AUTH_REQUIRED');
    assert.deepEqual((await view.state(box.repo)).project.shouts, before.project.shouts, 'an unauthenticated move cannot write a shout');
  } finally {
    await view.stop();
  }
});

test('the view answers a request line no URL parser accepts with 403, and keeps serving [N26]', async () => {
  const box = project();
  const view = await startView(box, box.repo);
  try {
    const reply = await new Promise((done) => {
      const socket = connect(Number(view.link.port), '127.0.0.1', () => socket.write(`GET http://[ HTTP/1.1\r\nHost: 127.0.0.1:${view.link.port}\r\nConnection: close\r\n\r\n`));
      let text = '';
      socket.on('data', (chunk) => { text += chunk; });
      socket.on('close', () => done(text));
    });
    assert.match(reply, /^HTTP\/1\.1 403/);
    assert.equal((await view.page()).status, 200, 'still serving');
  } finally {
    await view.stop();
  }
});

test('nothing a person types on the view sits inside what the refresh rewrites [N27]', () => {
  const page = cockpitSource();
  const rewritten = [...page.matchAll(/\$\('([a-z-]+)'\)\.innerHTML = /g)].map((match) => match[1]);
  assert.ok(['lanes', 'chain', 'detail', 'needs'].every((id) => rewritten.includes(id)), 'the refresh rewrites these');
  for (const id of rewritten) {
    const opening = new RegExp(`id="${id}"[^>]*>([^]*?)</`).exec(page);
    assert.doesNotMatch(opening ? opening[1] : '', /<(input|textarea|form)/, `#${id} starts with no form`);
  }
  assert.doesNotMatch(page.slice(page.indexOf('<script>')), /<input|<textarea|createElement\('(form|input|textarea)'\)/, 'the script never builds a field a refresh could erase');
});

test('the view keeps the board layout people know: switcher, tabs, a list and its detail, every verdict and the history [N26, N27]', async () => {
  const box = project();
  box.run(box.repo, 'add', 'web', 'Page', '--specs', 'G1', '--criterion', 'renders a heading');
  box.run(box.web, 'claim', '1');
  commitFile(box, box.web, 'web/a.html', 'a', 'feat(web): page [G1]');
  box.run(box.web, 'submit', '1');
  box.git(box.repo, 'switch', '-q', '--detach', 'web/one');
  box.run(box.repo, 'verify', '1', 'reject', '--reason', 'TEST_FAILURE', '--note', 'no heading', '--as', 'coordinator');
  box.git(box.repo, 'switch', '-q', 'main');
  const view = await startView(box, box.repo);
  try {
    const page = await (await view.page()).text();
    for (const region of ['id="proj-switch"', 'data-tab="items"', 'data-tab="shouts"', 'data-tab="spec"', 'data-tab="doctrine"', 'data-tab="activity"', 'id="chain"', 'id="detail"', 'id="add-form"', 'id="hold-form"']) {
      assert.ok(page.includes(region), region);
    }
    assert.match(
      page,
      /const filing = \[\.\.\.working\.filter\(\(l\) => p\.owning\.includes\(l\)\), 'coordinator', \.\.\.working\.filter\(\(l\) => !p\.owning\.includes\(l\)\)\]/,
      'new items default to a lane that owns folders, then the coordinator, verifier lanes last',
    );
    const item = (await view.state(box.repo)).project.items[0];
    assert.deepEqual(item.verdicts.map((verdict) => [verdict.decision, verdict.reason, verdict.note]), [['REJECT', 'TEST_FAILURE', 'no heading']]);
    assert.deepEqual(item.history.map((event) => event.kind), ['add', 'claim', 'submit', 'reject']);
    assert.equal(item.criterion, 'renders a heading');
  } finally {
    await view.stop();
  }
});

test('the view rebuilds the page only when the board changed, so a refresh cannot swallow a click [N26]', () => {
  const page = cockpitSource();
  assert.match(page, /if \(text !== seen\) \{\s*seen = text;\s*data = next;\s*render\(\);\s*\}/);
});

test('doctrine init preserves legacy rules and outside guidance, refreshes labels and refuses empty declines [D1,D2,D3,D4,S8]', () => {
  const box = sandbox();
  const repo = join(box.dir, 'doctrine');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  const legacy = '# Legacy practice\n\n## Local\n- L1 [fact] Keep the existing local rule.\n';
  const ways = '# Our ways\n\n## Rules\n- PB2 [fact] Delete only after team review.\n- PB8 [wont] This fixture stores only generated data.\n- R1 [fact] Keep the configured legacy rule.\n';
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ ...CONFIG, gate: 'true', practice: 'ways.md' }));
  writeFileSync(join(repo, 'PRACTICE.md'), legacy);
  writeFileSync(join(repo, 'ways.md'), ways);
  writeFileSync(join(repo, 'AGENTS.md'), '# Owner guidance\n\nKeep this prefix.\n');
  const first = box.run(repo, 'init');
  assert.equal(first.code, 0, first.err);
  assert.equal(readFileSync(join(repo, 'PRACTICE.md'), 'utf8'), legacy);
  assert.equal(readFileSync(join(repo, 'ways.md'), 'utf8'), ways);
  let agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
  assert.match(agents, /PB1 \(standard 1\)/);
  assert.match(agents, /PB2 \(repo\) \[fact\] Delete only after team review/);
  assert.match(agents, /PB8 \(repo\) \[wont\] This fixture stores only generated data/);
  assert.doesNotMatch(agents, /PB2 \(standard 1\)/);
  const shown = box.run(repo, 'spec', '--json');
  assert.equal(shown.code, 0, shown.out);
  const document = JSON.parse(shown.out);
  assert.equal(document.version, 1);
  assert.equal(document.rows.length, 13);
  const inherited = document.rows.filter(row => row.origin === 'standard');
  assert.equal(inherited.length, 10);
  assert.ok(inherited.every(row => row.version === 1 && row.reason === ''));
  assert.deepEqual(document.rows.filter(row => row.origin === 'repo').map(row => [row.id, row.version, row.reason, row.file]), [
    ['PB2', null, '', 'ways.md'], ['PB8', null, 'This fixture stores only generated data.', 'ways.md'], ['R1', null, '', 'ways.md'],
  ]);
  writeFileSync(join(repo, 'AGENTS.md'), agents + '\nKeep this footer.\n');
  const updatedWays = ways.replace('Delete only after team review.', 'Delete only after pair review.');
  writeFileSync(join(repo, 'ways.md'), updatedWays);
  const refreshed = box.run(repo, 'init');
  assert.equal(refreshed.code, 0, refreshed.err);
  assert.match(refreshed.out, /updated the pullboard section/);
  agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
  assert.ok(agents.startsWith('# Owner guidance\n\nKeep this prefix.\n'));
  assert.ok(agents.endsWith('\nKeep this footer.\n'));
  assert.match(agents, /PB2 \(repo\).*Delete only after pair review/);
  assert.equal(agents.split('<!-- pullboard:start -->').length, 2);
  assert.equal(box.run(repo, 'init').code, 0);
  assert.equal(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), agents, 'managed guidance refresh is idempotent');
  writeFileSync(join(repo, 'ways.md'), '# Our ways\n\n## Rules\n- PB2 [wont]    \n');
  const bad = box.run(repo, 'spec', '--json');
  assert.equal(bad.code, 1);
  assert.match(JSON.parse(bad.out).error.message, /declining a standard rule needs a reason in its text/);
  writeFileSync(join(repo, 'ways.md'), '# Our ways\n\n## Rules\n- PB2 [wont] Declined. | reason: outside syntax\n');
  assert.match(box.run(repo, 'spec', 'check').out, /unknown field/);
  writeFileSync(join(repo, 'ways.md'), updatedWays);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: retain local doctrine');
  writeFileSync(join(repo, 'ways.md'), updatedWays.replace('- PB2 [fact] Delete only after pair review.\n', ''));
  const removed = box.run(repo, 'spec', 'check');
  assert.equal(removed.code, 1);
  assert.match(removed.out, /ways.md: PB2 error:.*ids are permanent/, 'inherited PB2 cannot hide removal of a committed repo override');
});

/** Build an adversarial Git object directly; submit must be safe even when no commit hook ran. */
function attackCommit(box, cwd) {
  box.git(cwd, 'add', '-A');
  const tree = box.git(cwd, 'write-tree');
  const commit = box.git(cwd, 'commit-tree', tree, '-p', 'HEAD', '-m', 'feat(web): adversarial fixture [G1]');
  box.git(cwd, 'update-ref', 'HEAD', commit);
  return commit;
}

/** Submit a fixture whose private check reads an ignored dependency folder. */
function privateCheckSubmission({ install = '', timeout = '5m', check }) {
  const box = project('true');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.check = { install, timeout };
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure private check fixture');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  assert.equal(box.run(box.repo, 'add', 'web', 'Private check', '--specs', 'G1', '--criterion', 'the installed check passes', '--check', check).code, 0);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/.gitignore'), '.deps/\n');
  writeFileSync(join(box.web, 'web/index.html'), 'fixture');
  const commit = attackCommit(box, box.web);
  assert.equal(box.run(box.web, 'submit', '1').code, 0);
  const review = join(box.dir, 'private-check-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, commit);
  assert.equal(box.run(review, 'join', 'api').code, 0);
  return { ...box, review, commit };
}

test('accept installs ignored dependencies from frozen policy and doctor audits the same private check [V18,V2]', () => {
  const box = privateCheckSubmission({
    install: 'echo frozen-install-ran; mkdir -p web/.deps; printf installed > web/.deps/ready',
    check: 'test -f web/.deps/ready',
  });
  const accepted = box.run(box.review, 'verify', '1', 'accept', '--note', 'the private install created the ignored dependency folder', '--json');
  assert.equal(accepted.code, 0, accepted.err);
  const doctor = box.run(box.repo, 'doctor', '--json');
  assert.equal(doctor.code, 0, doctor.out);

  const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  let item;
  try { item = store.getItem(board, 1); }
  finally { store.closeBoard(board); }
  writeFileSync(join(box.web, 'pullboard.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(box.web, 'pullboard.json'), 'utf8')), check: { install: 'echo malicious-install-ran; exit 7', timeout: '1ms' } }));
  const changed = attackCommit(box, box.web);
  const proof = checkAtCommit(box.repo, { ...item, item_commit: changed });
  assert.equal(proof.state, 'pass');
  assert.match(proof.output, /frozen-install-ran/);
  assert.doesNotMatch(proof.output, /malicious-install-ran/);
});

test('accept without check.install keeps CHECK_RED and names the missing setting [V18,V2]', () => {
  const box = privateCheckSubmission({ check: 'echo check-failed; test -f web/.deps/ready' });
  const refused = box.run(box.review, 'verify', '1', 'accept', '--note', 'checking missing private dependency', '--json');
  assert.equal(refused.code, 1);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'CHECK_RED');
  assert.match(error.message, /check\.install/);
  assert.match(error.message, /output digest/);
  assert.match(error.message, /check-failed/);
  assert.match(error.next, /^reject with the failing behavior or ask the builder to fix and resubmit/);
});

test('accept reports failed install as CHECK_UNVERIFIED with an output digest [V18,V2]', () => {
  const box = privateCheckSubmission({ install: 'echo install-failed; exit 9', check: 'true' });
  const refused = box.run(box.review, 'verify', '1', 'accept', '--note', 'install must complete before verification', '--json');
  assert.equal(refused.code, 1);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'CHECK_UNVERIFIED');
  assert.match(error.message, /install failed/);
  assert.match(error.message, /output digest/);
  assert.match(error.message, /install-failed/);
  assert.match(error.next, /^restore the install or check environment, then retry verification/);
});

test('private check digest keeps install and noisy check output in separate sections [V18,V2]', () => {
  const box = privateCheckSubmission({
    install: 'echo install-marker',
    check: 'i=0; while [ "$i" -lt 200 ]; do echo noisy-check-output-$i; i=$((i + 1)); done; echo check-failed; exit 1',
  });
  const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  let item;
  try { item = store.getItem(board, 1); }
  finally { store.closeBoard(board); }
  const proof = checkAtCommit(box.repo, item);
  assert.equal(proof.state, 'red');
  assert.match(proof.report, /install output:\ninstall-marker/);
  assert.match(proof.report, /check output:[\s\S]*check-failed/);
});

test('accept runs a successful frozen check that writes a file larger than the log cap [V18,V2]', () => {
  const box = privateCheckSubmission({ check: 'mkdir -p web/.deps; node -e \'require("node:fs").writeFileSync("web/.deps/check.bin", Buffer.alloc(20 * 1024 * 1024)); console.log("large-check-file-written")\'' });
  const accepted = box.run(box.review, 'verify', '1', 'accept', '--note', 'the check wrote its real 20 MiB artifact', '--json');
  assert.equal(accepted.code, 0, accepted.out);
  assert.equal(JSON.parse(accepted.out).decision, 'ACCEPT');
});

test('accept installs a real dependency file larger than the log cap before checking [V18,V2]', () => {
  const box = privateCheckSubmission({
    install: 'mkdir -p web/.deps; node -e \'require("node:fs").writeFileSync("web/.deps/dependency.bin", Buffer.alloc(20 * 1024 * 1024)); console.log("large-install-file-written")\'',
    check: 'node -e \'if (require("node:fs").statSync("web/.deps/dependency.bin").size !== 20 * 1024 * 1024) process.exit(1)\'',
  });
  const accepted = box.run(box.review, 'verify', '1', 'accept', '--note', 'the private install produced the complete 20 MiB dependency', '--json');
  assert.equal(accepted.code, 0, accepted.out);
  assert.equal(JSON.parse(accepted.out).decision, 'ACCEPT');
  const doctor = box.run(box.repo, 'doctor', '--json');
  assert.equal(doctor.code, 0, doctor.out);
});

test('a successful noisy check drains beyond the log cap and keeps bounded head and tail output [V18,V2]', () => {
  const box = privateCheckSubmission({ check: 'node -e \'process.stdout.write("BEGIN-MARKER\\n"); process.stdout.write(Buffer.alloc(20 * 1024 * 1024, 120)); process.stdout.write("\\nEND-MARKER\\n")\'' });
  const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  let item;
  try { item = store.getItem(board, 1); } finally { store.closeBoard(board); }
  const proof = checkAtCommit(box.repo, item);
  assert.equal(proof.state, 'pass', proof.report);
  assert.ok(proof.output.length < 8 * 1024 * 1024 + 256, 'only a bounded capture reaches the caller');
  assert.match(proof.output, /BEGIN-MARKER/);
  assert.match(proof.output, /END-MARKER/);
  assert.match(proof.output, /output capped at 8 MiB; middle omitted/);
  const accepted = box.run(box.review, 'verify', '1', 'accept', '--note', 'a noisy successful check passes with bounded output', '--json');
  assert.equal(accepted.code, 0, accepted.out);
});

test('accept reports a frozen check timeout as CHECK_UNVERIFIED [V18,V2]', () => {
  const box = privateCheckSubmission({ timeout: '100ms', check: 'case "$PULLBOARD_HOME" in */pullboard-criterion-*/home/.pullboard) while :; do :; done;; *) exit 1;; esac' });
  const refused = box.run(box.review, 'verify', '1', 'accept', '--note', 'the frozen check exceeded its configured timeout', '--json');
  assert.equal(refused.code, 1);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'CHECK_UNVERIFIED');
  assert.match(error.message, /check timed out/);
  assert.match(error.message, /output digest/);
  assert.match(error.next, /^restore the install or check environment, then retry verification/);
});

test('accept reports a frozen install timeout before running the check [V18,V2]', () => {
  const box = privateCheckSubmission({ timeout: '100ms', install: 'echo install-started; while :; do :; done', check: 'echo forbidden-check-ran' });
  const refused = box.run(box.review, 'verify', '1', 'accept', '--note', 'the install must finish within its frozen deadline', '--json');
  assert.equal(refused.code, 1);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'CHECK_UNVERIFIED');
  assert.match(error.message, /install timed out/);
  assert.match(error.message, /install-started/);
  assert.doesNotMatch(error.message, /forbidden-check-ran/);
  assert.match(error.next, /^restore the install or check environment, then retry verification/);
});

test('private check timeout kills a TERM-resistant shell and its tracked child [V18,V2]', () => {
  const box = project('true');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.check = { install: '', timeout: '100ms' };
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure bounded check fixture');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  assert.equal(box.run(box.repo, 'add', 'web', 'Bounded check', '--specs', 'G1', '--criterion', 'the check stops within its timeout', '--check', 'true').code, 0);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/index.html'), 'fixture');
  const commit = attackCommit(box, box.web);
  const pidFile = join(box.dir, 'private-check-child.pid');
  const check = `sleep 30 & echo $! > '${pidFile}'; trap 'while :; do :; done' TERM; while :; do :; done`;
  const item = { item_frozen: JSON.stringify({ check }), item_claim_head: commit, item_commit: commit };
  const modulePath = resolve(import.meta.dirname, '../src/trusted-policy.js');
  const source = `import { checkAtCommit } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(checkAtCommit(process.argv[1], JSON.parse(process.argv[2]))));`;
  const shellPidFile = join(box.dir, 'private-check-shell.pid');
  const trackedCheck = `echo $$ > '${shellPidFile}'; ${check}`;
  const trackedItem = { ...item, item_frozen: JSON.stringify({ check: trackedCheck }) };
  let outer;
  try {
    outer = spawnSync(process.execPath, ['--input-type=module', '-e', source, box.repo, JSON.stringify(trackedItem)], {
      cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 3000, detached: true,
    });
    assert.equal(outer.error, undefined, outer.error?.message);
    assert.equal(outer.status, 0, outer.stderr);
    assert.equal(JSON.parse(outer.stdout).stage, 'check timed out');
    const childPid = Number(readFileSync(pidFile, 'utf8').trim());
    let childAlive = true;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { process.kill(childPid, 0); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
      catch { childAlive = false; break; }
    }
    assert.equal(childAlive, false, 'the tracked grandchild exits after its timeout');
  } finally {
    const fixturePids = [pidFile, shellPidFile].flatMap(path => {
      try { return [Number(readFileSync(path, 'utf8').trim())]; }
      catch { return []; }
    }).filter(pid => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
    if (outer?.error?.code === 'ETIMEDOUT' && outer.pid) fixturePids.push(outer.pid);
    for (const pid of new Set(fixturePids)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* This fixture process has already exited. */ }
    }
  }
});

test('the blind gate-bypass repro refuses submit and accept, and doctor audits pre-merge policy [V4,V16,L3,M3]', () => {
  const box = project('true');
  assert.equal(box.run(box.repo, 'add', 'web', 'Append notes', '--specs', 'G1', '--criterion', 'append one note', '--check', 'test ! -f web/RED_CHECK').code, 0);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  const original = JSON.parse(box.run(box.web, 'show', '1', '--json').out);
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/RED_CHECK'), 'red');
  const config = JSON.parse(readFileSync(join(box.web, 'pullboard.json'), 'utf8'));
  config.gate = 'true';
  config.lanes.web.owns.push('pullboard.json');
  writeFileSync(join(box.web, 'pullboard.json'), JSON.stringify(config));
  const commit = attackCommit(box, box.web);
  const submitted = box.run(box.web, 'submit', '1', '--json');
  assert.equal(submitted.code, 1);
  assert.equal(JSON.parse(submitted.out).error.code, 'OUTSIDE_LANE');
  assert.equal(JSON.parse(submitted.out).error.message.includes('pullboard.json'), true);
  assert.equal(box.run(box.web, 'check', '1').code, 1, 'the original item check stays red');

  // Model a historical unchecked receipt using the low-level engine in this private fixture.
  const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try { store.submit(board, 1, { agentId: 'web-1', commit, tree: box.git(box.web, 'rev-parse', 'HEAD^{tree}'), policyCommit: original.item_claim_head }); }
  finally { store.closeBoard(board); }
  box.git(box.repo, 'update-ref', 'refs/pullboard/items/1/' + commit.slice(0, 12), commit);
  const review = join(box.dir, 'review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, commit);
  assert.equal(box.run(review, 'join', 'api').code, 0);
  const accepted = box.run(review, 'verify', '1', 'accept', '--note', 'private repro', '--json');
  assert.equal(accepted.code, 1);
  assert.equal(JSON.parse(accepted.out).error.code, 'CHECK_RED');
  assert.equal(JSON.parse(box.run(review, 'show', '1', '--json').out).item_status, 'submitted');

  const history = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try { store.verify(history, 1, { agentId: 'api-1', decision: 'ACCEPT', note: 'synthetic historical unchecked verdict', head: commit, digest: original.item_frozen_digest, policy: 'any' }); }
  finally { store.closeBoard(history); }
  box.git(box.repo, 'merge', '--ff-only', '-q', 'web/one');
  assert.equal(box.run(box.repo, 'merged', '1', commit).code, 0);
  const file = join(box.repo, '.git/pullboard/board.sqlite');
  const before = readFileSync(file);
  const doctor = box.run(box.repo, 'doctor', '--json');
  assert.equal(doctor.code, 1);
  const problems = JSON.parse(doctor.out).problems;
  assert.equal(problems.some(problem => problem.code === 'OUTSIDE_LANE' && problem.message.includes('pullboard.json')), true,
    'post-merge HEAD cannot retrospectively authorize the malicious policy edit');
  assert.equal(problems.some(problem => problem.code === 'CHECK_RED'), true);
  assert.deepEqual(readFileSync(file), before, 'doctor keeps the historical evidence unchanged');
});

test('a shared config edit cannot replace the gate frozen from the coordinator [V4,V16]', () => {
  const box = project('test ! -f web/RED');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.shared.push('pullboard.json');
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: share fixture config');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  assert.equal(box.run(box.repo, 'add', 'web', 'Frozen gate', '--specs', 'G1', '--criterion', 'original gate passes').code, 0);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/RED'), 'red');
  config.gate = 'true';
  writeFileSync(join(box.web, 'pullboard.json'), JSON.stringify(config));
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): fixture config change [G1]');
  const refused = box.run(box.web, 'submit', '1', '--json');
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.out).error.code, 'GATE_RED', 'the committed original gate executes even though the candidate says true');
});

test('accepted-main merges carry foreign files without granting permission to alter them [L3,V4]', () => {
  const box = project('true');
  assert.equal(box.run(box.repo, 'add', 'web', 'Main merge', '--specs', 'G1', '--criterion', 'foreign main object preserved').code, 0);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  writeFileSync(join(box.repo, 'coordinator.txt'), 'accepted main fixture');
  box.git(box.repo, 'add', 'coordinator.txt');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: coordinator fixture');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/index.html'), 'app fixture');
  box.git(box.web, 'add', 'web/index.html');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): preserve main fixture [G1]');
  assert.equal(box.run(box.web, 'submit', '1').code, 0, 'unchanged accepted-main foreign objects are allowed');
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  box.git(box.repo, 'merge', '-q', '--ff-only', 'web/one');
  assert.equal(box.run(box.repo, 'verify', '1', 'accept', '--as', 'coordinator', '--note', 'private accepted-main fixture').code, 0);
  assert.equal(box.run(box.repo, 'doctor').code, 0, 'the pre-merge main proof remains available for historical audit');
  assert.equal(box.run(box.repo, 'add', 'web', 'Alter foreign file', '--specs', 'G1', '--criterion', 'ownership remains enforced').code, 0);
  assert.equal(box.run(box.web, 'claim', '2').code, 0);
  writeFileSync(join(box.web, 'coordinator.txt'), 'unauthorized replacement');
  attackCommit(box, box.web);
  const refused = box.run(box.web, 'submit', '2', '--json');
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.out).error.code, 'OUTSIDE_LANE');
});

test('foreign changes before claiming and cross-lane renames cannot hide from submit [L3,V4]', () => {
  for (const mode of ['before-claim', 'rename', 'delete']) {
    const box = project('true');
    writeFileSync(join(box.repo, 'foreign file.txt'), 'coordinator-owned');
    box.git(box.repo, 'add', '-A');
    box.git(box.repo, 'commit', '-q', '-m', 'chore: foreign fixture');
    box.git(box.web, 'merge', '-q', '--ff-only', 'main');
    assert.equal(box.run(box.repo, 'add', 'web', mode, '--specs', 'G1').code, 0);
    if (mode === 'before-claim') {
      writeFileSync(join(box.web, 'foreign file.txt'), 'unauthorized pre-claim replacement');
      attackCommit(box, box.web);
    }
    assert.equal(box.run(box.web, 'claim', '1').code, 0);
    mkdirSync(join(box.web, 'web'));
    if (mode === 'rename') box.git(box.web, 'mv', 'foreign file.txt', 'web/moved.txt');
    else if (mode === 'delete') box.git(box.web, 'rm', 'foreign file.txt');
    writeFileSync(join(box.web, 'web/index.html'), 'owned');
    attackCommit(box, box.web);
    const refused = box.run(box.web, 'submit', '1', '--json');
    assert.equal(refused.code, 1, mode);
    assert.equal(JSON.parse(refused.out).error.code, 'OUTSIDE_LANE', mode);
    assert.equal(JSON.parse(refused.out).error.message.includes('foreign file.txt'), true, mode);
  }
});

test('accept reruns the frozen check at the submission even when the reviewer repaired its HEAD [V4,M3]', () => {
  const box = project('true');
  assert.equal(box.run(box.repo, 'add', 'web', 'Exact check', '--specs', 'G1', '--check', 'test ! -f web/RED_CHECK').code, 0);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/RED_CHECK'), 'red');
  const commit = attackCommit(box, box.web);
  assert.equal(box.run(box.web, 'submit', '1').code, 0, 'the project gate passes while the separate item check is red');
  const review = join(box.dir, 'exact-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, commit);
  assert.equal(box.run(review, 'join', 'api').code, 0);
  box.git(review, 'rm', 'web/RED_CHECK');
  attackCommit(box, review); // Model the adversarial repair without disabling its lane hook.
  assert.equal(box.run(review, 'check', '1', '--yes').code, 0, 'the reviewer HEAD alone is green');
  const refused = box.run(review, 'verify', '1', 'accept', '--note', 'reviewer repair is not submission proof', '--json');
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.out).error.code, 'CHECK_RED');
  assert.equal(JSON.parse(box.run(review, 'show', '1', '--json').out).item_status, 'submitted');
});

test('accept independently refuses a historically unchecked foreign submission [L3,M3]', () => {
  const box = project('true');
  assert.equal(box.run(box.repo, 'add', 'web', 'Foreign receipt', '--specs', 'G1', '--check', 'true').code, 0);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  writeFileSync(join(box.web, 'coordinator.txt'), 'unauthorized');
  const commit = attackCommit(box, box.web);
  const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try { store.submit(board, 1, { agentId: 'web-1', commit, tree: box.git(box.web, 'rev-parse', 'HEAD^{tree}') }); }
  finally { store.closeBoard(board); }
  const review = join(box.dir, 'foreign-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, commit);
  assert.equal(box.run(review, 'join', 'api').code, 0);
  const refused = box.run(review, 'verify', '1', 'accept', '--note', 'a green check cannot authorize this path', '--json');
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.out).error.code, 'OUTSIDE_LANE');
});

test('replacement refs cannot conceal the real submitted foreign paths [L3,V4,M3]', () => {
  const box = project('true');
  assert.equal(box.run(box.repo, 'add', 'web', 'Replacement probe', '--specs', 'G1', '--check', 'true').code, 0);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  const base = box.git(box.web, 'rev-parse', 'HEAD');
  writeFileSync(join(box.web, 'coordinator.txt'), 'underlying unauthorized object');
  const commit = attackCommit(box, box.web);
  box.git(box.web, 'replace', commit, base);
  box.git(box.web, 'reset', '--hard', 'HEAD');
  assert.equal(existsSync(join(box.web, 'coordinator.txt')), false, 'Git normally shows the replacement tree');
  const submitted = box.run(box.web, 'submit', '1', '--json');
  assert.equal(submitted.code, 1);
  assert.equal(JSON.parse(submitted.out).error.code, 'OUTSIDE_LANE');
  const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try { store.submit(board, 1, { agentId: 'web-1', commit, tree: 'synthetic unchecked tree' }); }
  finally { store.closeBoard(board); }
  const review = join(box.dir, 'replacement-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, commit);
  assert.equal(box.run(review, 'join', 'api').code, 0);
  const accepted = box.run(review, 'verify', '1', 'accept', '--note', 'the replacement is not the pinned object', '--json');
  assert.equal(accepted.code, 1);
  assert.equal(JSON.parse(accepted.out).error.code, 'OUTSIDE_LANE');
});

test('replacement refs cannot turn a red committed owned tree into a clean green submission [V4,V16]', () => {
  const box = project('test ! -f web/RED');
  assert.equal(box.run(box.repo, 'add', 'web', 'Exact red tree', '--specs', 'G1').code, 0);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  const base = box.git(box.web, 'rev-parse', 'HEAD');
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/RED'), 'committed red');
  const commit = attackCommit(box, box.web);
  box.git(box.web, 'replace', commit, base);
  box.git(box.web, 'reset', '--hard', 'HEAD');
  assert.equal(existsSync(join(box.web, 'web/RED')), false, 'ordinary Git hides the failing committed file');
  const submitted = box.run(box.web, 'submit', '1', '--json');
  assert.equal(submitted.code, 1);
  assert.equal(JSON.parse(submitted.out).error.code, 'DIRTY', 'the underlying tree differs from the files the gate would execute');
});

test('a detached coordinator review cannot become a new claim policy [V4,V16]', () => {
  const box = project('test ! -f web/RED');
  assert.equal(box.run(box.repo, 'add', 'web', 'Detached policy', '--specs', 'G1').code, 0);
  const config = JSON.parse(readFileSync(join(box.web, 'pullboard.json'), 'utf8'));
  config.gate = 'true';
  config.lanes.web.owns.push('pullboard.json');
  writeFileSync(join(box.web, 'pullboard.json'), JSON.stringify(config));
  const candidate = attackCommit(box, box.web);
  box.git(box.repo, 'switch', '-q', '--detach', candidate);
  const refused = box.run(box.web, 'claim', '1', '--json');
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.out).error.code, 'NO_POLICY');
  assert.match(JSON.parse(refused.out).error.message, /return to its main branch/);
  box.git(box.repo, 'switch', '-q', 'main');
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  const submitted = box.run(box.web, 'submit', '1', '--json');
  assert.equal(submitted.code, 1);
  assert.equal(JSON.parse(submitted.out).error.code, 'OUTSIDE_LANE');
});
