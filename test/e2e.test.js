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
const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  BIN, cockpitSource, sandboxes, sandbox, CONFIG, SPEC, project, holdingGate,
  launch, waitFor, gateEvents, commitFile, attackCommit, privateCheckSubmission,
  startView, LIGHT_BRIEF,
} = e2e;

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
  const doctrine = readFileSync(join(repo, 'DOCTRINE.md'), 'utf8');
  assert.ok(doctrine.startsWith('# Doctrine'));
  assert.deepEqual(parseSpec(doctrine).rows, [], 'fresh init copies no standard rules [D4]');
  assert.equal(parseSpec(doctrine).sections.length, 6);
  assert.equal(doctrine.split('Inherits Pullboard standard doctrine version 1.').length, 2);
  assert.equal(box.run(repo, 'spec', 'check').code, 0, 'fresh init has no repeated ids [A5]');
  const specRows = parseSpec(readFileSync(join(repo, 'SPEC.md'), 'utf8'));
  const doctrineRows = parseSpec(doctrine);
  const specPrefixes = specRows.sections.map(({ name }) => /^([A-Z])\s/u.exec(name)?.[1]).filter(Boolean);
  const doctrinePrefixes = doctrineRows.sections.map(({ name }) => /^([A-Z])\s/u.exec(name)?.[1]).filter(Boolean);
  assert.equal(specPrefixes.some((prefix) => doctrinePrefixes.includes(prefix)), false, 'init assigns distinct row prefixes to SPEC and DOCTRINE');
  for (const [file, parsed] of [['SPEC.md', specRows], ['DOCTRINE.md', doctrineRows]]) {
    const source = readFileSync(join(repo, file), 'utf8');
    const additions = parsed.sections.map(({ name }) => {
      const prefix = /^([A-Z])\s/u.exec(name)?.[1];
      return prefix ? `\n- ${prefix}1 [draft] A starter row.\n` : '';
    }).join('');
    writeFileSync(join(repo, file), `${source}${additions}`);
  }
  const representativeRows = box.run(repo, 'spec', 'check');
  assert.equal(representativeRows.code, 0, representativeRows.err || representativeRows.out);
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

test('items and commit headers cite doctrine rows by namespace; bare collisions warn [A5]', () => {
  const box = project();
  const added = box.run(box.repo, 'add', 'web', 'Use the inherited rule', '--specs', 'doctrine:PB1');
  assert.equal(added.code, 0, added.err);
  assert.match(box.run(box.repo, 'show', '1').out, /\[doctrine:PB1\]/u);

  const message = join(box.dir, 'message.txt');
  writeFileSync(message, 'feat(web): use the inherited rule [doctrine:PB1]\n');
  const namespaced = box.run(box.repo, 'hook', 'commit-msg', message);
  assert.equal(namespaced.code, 0, namespaced.err);
  assert.doesNotMatch(namespaced.out, /warning:/u);

  const doctrine = readFileSync(join(box.repo, 'DOCTRINE.md'), 'utf8');
  writeFileSync(join(box.repo, 'DOCTRINE.md'), `${doctrine}\n## Local\n- G1 [draft] A local rule colliding with SPEC.md.\n`);
  writeFileSync(message, 'feat(web): use the product rule [G1]\n');
  const warning = box.run(box.repo, 'hook', 'commit-msg', message);
  assert.equal(warning.code, 0, warning.err);
  assert.match(warning.out, /warning: G1 is a known collision at SPEC\.md:4 and DOCTRINE\.md:\d+; bare ids cite SPEC\.md/u);
  assert.match(warning.out, /use doctrine:G1 for a doctrine row/u);
  const check = box.run(box.repo, 'spec', 'check');
  assert.equal(check.code, 1);
  assert.match(check.out, /duplicate id; also appears at DOCTRINE\.md:/u);
  const legacy = readFileSync(join(box.repo, 'DOCTRINE.md'), 'utf8');
  rmSync(join(box.repo, 'DOCTRINE.md'));
  writeFileSync(join(box.repo, 'PRACTICE.md'), legacy);
  const legacyCheck = box.run(box.repo, 'spec', 'check');
  assert.equal(legacyCheck.code, 1);
  assert.match(legacyCheck.out, /SPEC\.md:4 G1 error: duplicate id; also appears at PRACTICE\.md:\d+/u);
  assert.match(legacyCheck.out, /PRACTICE\.md:\d+ G1 error: duplicate id; also appears at SPEC\.md:4/u);
  assert.doesNotMatch(legacyCheck.out, /DOCTRINE\.md:/u);
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

test('explicit and trunk pre-push landings jump the machine gate line and show in resources [Q1,Q2]', async () => {
  const box = sandbox();
  const gate = holdingGate(box);
  const projectBox = project(gate.command, box);
  assert.equal(projectBox.run(projectBox.repo, 'settings', 'gateSlots', '1').code, 0);
  writeFileSync(gate.mode, 'armed');

  const ordinary = launch(projectBox, projectBox.repo, process.execPath, [BIN, 'gate']);
  const children = [ordinary];
  let explicitLanding;
  try {
    await waitFor(() => gateEvents(gate).length === 1, 'ordinary gate to hold the sole machine slot');
    explicitLanding = launch(projectBox, projectBox.web, process.execPath, [BIN, 'gate', '--landing']);
    children.push(explicitLanding);
    let latestResources = '';
    await waitFor(() => {
      const result = projectBox.run(projectBox.repo, 'resources', '--json');
      assert.equal(result.code, 0, result.err);
      latestResources = result.out;
      const resource = JSON.parse(result.out).resources.find((entry) => entry.scope === 'machine' && entry.name === 'gate');
      return resource?.line.length > 0;
    }, 'explicit gate run to appear in the resource listing').catch((error) => {
      throw new Error(`${error.message}\nresources: ${latestResources}\nlanding stdout: ${explicitLanding.stdoutText}\nlanding stderr: ${explicitLanding.stderrText}\nevents: ${gateEvents(gate).join(',')}`);
    });
    const json = projectBox.run(projectBox.repo, 'resources', '--json');
    assert.equal(json.code, 0, json.err);
    const queued = JSON.parse(json.out).resources.find((resource) => resource.scope === 'machine' && resource.name === 'gate');
    assert.deepEqual(queued.line.map(({ landing }) => landing), [true]);
    const humanQueue = projectBox.run(projectBox.repo, 'resources');
    assert.equal(humanQueue.code, 0, humanQueue.err);
    assert.match(humanQueue.out, /waiting: .* \(landing\)/u);
    writeFileSync(gate.release, 'released');
    const results = await Promise.all(children.map((child) => child.closed));
    assert.deepEqual(results.map(({ code }) => code), [0, 0]);
    assert.deepEqual(gateEvents(gate), ['start', 'end', 'start', 'end']);
  } finally {
    writeFileSync(gate.release, 'released');
    await Promise.all(children.map((child) => child.closed));
  }

  const pushBox = sandbox();
  const pushGate = holdingGate(pushBox);
  const pushProject = project(pushGate.command, pushBox);
  const remote = join(pushBox.dir, 'remote.git');
  pushProject.git(pushBox.dir, 'init', '-q', '--bare', remote);
  pushProject.git(pushProject.repo, 'remote', 'add', 'origin', remote);
  assert.equal(pushProject.run(pushProject.repo, 'settings', 'gateSlots', '1').code, 0);
  writeFileSync(pushGate.mode, 'armed');
  const holder = launch(pushProject, pushProject.web, process.execPath, [BIN, 'gate']);
  const pushChildren = [holder];
  let push;
  try {
    await waitFor(() => gateEvents(pushGate).length === 1, 'gate holder to start before trunk push');
    push = launch(pushProject, pushProject.repo, 'git', ['push', '-q', 'origin', 'main']);
    pushChildren.push(push);
    let latestPushResources = '';
    await waitFor(() => {
      const result = pushProject.run(pushProject.repo, 'resources', '--json');
      assert.equal(result.code, 0, result.err);
      latestPushResources = result.out;
      const resource = JSON.parse(result.out).resources.find((entry) => entry.scope === 'machine' && entry.name === 'gate');
      return resource?.line.length > 0;
    }, 'trunk pre-push gate to appear in the resource listing').catch((error) => {
      throw new Error(`${error.message}\nresources: ${latestPushResources}\npush stdout: ${push.stdoutText}\npush stderr: ${push.stderrText}\nevents: ${gateEvents(pushGate).join(',')}`);
    });
    const json = pushProject.run(pushProject.repo, 'resources', '--json');
    assert.equal(json.code, 0, json.err);
    const queued = JSON.parse(json.out).resources.find((resource) => resource.scope === 'machine' && resource.name === 'gate');
    assert.deepEqual(queued.line.map(({ landing }) => landing), [true], 'the hook marks its trunk update as a landing');
    const humanQueue = pushProject.run(pushProject.repo, 'resources');
    assert.equal(humanQueue.code, 0, humanQueue.err);
    assert.match(humanQueue.out, /waiting: .* \(landing\)/u);
    writeFileSync(pushGate.release, 'released');
    const results = await Promise.all(pushChildren.map((child) => child.closed));
    assert.deepEqual(results.map(({ code }) => code), [0, 0]);
    assert.deepEqual(gateEvents(pushGate), ['start', 'end', 'start', 'end']);
  } finally {
    writeFileSync(pushGate.release, 'released');
    await Promise.all(pushChildren.map((child) => child.closed));
  }
});
