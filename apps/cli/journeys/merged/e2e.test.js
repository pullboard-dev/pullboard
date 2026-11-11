/**
 * @pullboard-world-pin reads this repo's own AGENTS.md and README.md to prove init writes the approved text byte for byte.
 * End to end on real repos: init, the coordinator's resume and spec check (B1–B3, B6, V3, V4, V7, L3, L4, C3, I1, I2, P2). The board, lane and gate-slot journeys live in e2e-board and e2e-gate-slot so each file stays under two minutes.
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { parseSpec } from '../../../../packages/spec/index.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { joinFixtureSeat } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const { sandbox, CONFIG, SPEC, project, commitFile, startView } = e2e;

/** Use the fixture's exact environment and production command function without spawning Node. */
async function command(box, cwd, ...argv) {
  return runCliInProcess(argv, { cwd, env: box.env });
}

test('init writes config, spec, agent docs and hooks once, and never clobbers [I1, I2]', async () => {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'AGENTS.md'), '# Mine\n\nkeep me\n');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const first = (await command(box, repo, 'init', '--verbose'));
  assert.equal(first.code, 0);
  assert.match(first.out, /added the pullboard section to AGENTS.md/);
  assert.equal(JSON.parse(readFileSync(join(repo, 'pullboard.json'), 'utf8')).gate, 'npm test');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ ...CONFIG, gate: 'mine' }));
  const second = (await command(box, repo, 'init', '--verbose'));
  assert.match(second.out, /kept pullboard.json/);
  assert.doesNotMatch(second.out, /no gate yet/, 'the config already names a gate');
  assert.equal(JSON.parse(readFileSync(join(repo, 'pullboard.json'), 'utf8')).gate, 'mine');
  const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
  assert.ok(agents.startsWith('# Mine\n\nkeep me\n'));
  assert.equal(agents.split('<!-- pullboard:start -->').length, 2);
  assert.equal(readFileSync(join(repo, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
  // The block is the approved text in this repo's own AGENTS.md, byte for byte [P1].
  const approved = readFileSync(new URL('../../../../AGENTS.md', import.meta.url), 'utf8');
  const between = (text) => text.slice(text.indexOf('<!-- pullboard:start -->'), text.indexOf('<!-- pullboard:end -->'));
  assert.equal(between(agents), between(approved), 'a fresh setup writes the approved pullboard block');
  assert.ok(readFileSync(join(repo, 'COORDINATOR.md'), 'utf8').includes('Coordinator'), 'a fresh setup writes the coordinator guide');
  assert.equal(box.git(repo, 'config', '--get', 'core.hooksPath'), '.githooks');
  for (const hook of ['pre-commit', 'commit-msg', 'pre-push']) assert.ok(existsSync(join(repo, '.githooks', hook)));
  const doctrine = readFileSync(join(repo, 'DOCTRINE.md'), 'utf8');
  assert.ok(doctrine.startsWith('# Doctrine'));
  assert.deepEqual(parseSpec(doctrine).rows, [], 'fresh init copies no standard rules [D4]');
  assert.equal(parseSpec(doctrine).sections.length, 6);
  assert.equal(doctrine.split('Inherits Pullboard standard doctrine version 1.').length, 2);
  assert.equal((await command(box, repo, 'spec', 'check')).code, 0, 'fresh init has no repeated ids [A5]');
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
  const representativeRows = (await command(box, repo, 'spec', 'check'));
  assert.equal(representativeRows.code, 0, representativeRows.err || representativeRows.out);
  assert.match(agents, /PB1 \(standard 1\)/, 'fresh guidance shows inherited rules [D3]');
  assert.ok(existsSync(join(repo, '.claude', 'skills', 'pullboard-decompose', 'SKILL.md')));
  assert.match(second.out, /kept DOCTRINE.md/);
  assert.match(second.out, /kept the Claude Code skills/);
});

test("init's spec has its sections and no rows, and the README's example fits under them as written [I1, S8]", async () => {
  const box = sandbox();
  const repo = join(box.dir, 'fresh');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  assert.equal((await command(box, repo, 'init')).code, 0);
  const spec = readFileSync(join(repo, 'SPEC.md'), 'utf8');
  assert.deepEqual(parseSpec(spec).rows, [], 'no placeholder row, so no placeholder id is ever committed and made permanent');
  assert.deepEqual(parseSpec(spec).sections.map((section) => section.name), ['G · Goals: what the client asked for', 'K · Constraints']);
  const readme = readFileSync(join(import.meta.dirname, '../../../../README.md'), 'utf8');
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
  const check = (await command(box, repo, 'spec', 'check'));
  assert.equal(check.code, 0, check.out);
  assert.match(check.out, new RegExp(`SPEC.md: ${rows.length} rows, 0 errors`));
});

test("the coordinator's resume names its next step from the spec and the board, stage by stage [N32, I9]", async () => {
  const next = (box, cwd) => /^next: (.*)$/m.exec(box.run(cwd, 'resume', '--diagnostics').out)?.[1] ?? '';
  const fresh = sandbox();
  const repo = join(fresh.dir, 'fresh');
  mkdirSync(repo);
  fresh.git(repo, 'init', '-q', '-b', 'main');
  fresh.git(repo, 'config', 'user.name', 'Test Agent');
  fresh.git(repo, 'config', 'user.email', 'agent@example.com');
  const initialized = fresh.run(repo, 'init', '--verbose', '--yes');
  assert.match(initialized.out, /^wrote Claude Code skills: pullboard-decompose, pullboard-plan, pullboard-signoff, pullboard-spec-review, pullboard-verify, pullboard-run, pullboard-triage$/m, 'init installs the Claude Code skills');
  const joined = joinFixtureSeat(fresh, repo, 'coordinator');
  assert.equal(joined.code, 0, joined.out);
  assert.match(joined.out, /read COORDINATOR\.md before you route anything/, 'join coordinator tells the coordinator to read the guide');
  const firstSetup = JSON.parse(fresh.run(repo, 'resume', '--diagnostics', '--json').out).setup;
  assert.equal(firstSetup?.step, 1, 'a new board starts by asking what the person wants');
  assert.equal(next(fresh, repo), firstSetup.command);
  assert.equal(fixtureAdd(fresh.run, repo, 'coordinator', 'Tidy the readme').code, 0);
  assert.equal(fresh.run(repo, 'claim', '1').code, 0);
  assert.equal(JSON.parse(fresh.run(repo, 'resume', '--diagnostics', '--json').out).setup.step, 2, 'a working board with an item and no spec rows treats the spec as optional (#866)');
  writeFileSync(join(repo, 'SPEC.md'), '# Fresh\n\n## G · Goals\n- G1 [draft, must] It works. | gate: test\n');
  assert.equal(JSON.parse(fresh.run(repo, 'resume', '--diagnostics', '--json').out).setup.step, 1, 'nor the approval');
  writeFileSync(join(repo, 'SPEC.md'), '# Fresh\n\n## G · Goals\n- G1 [approved, must] It works. | gate: test\n');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify(CONFIG));
  fresh.env.PULLBOARD_VIEW_FOREGROUND = '1';
  const freshView = await startView(fresh, repo);
  await freshView.stop();
  assert.match(next(fresh, repo), /^commit the applied row file first: .*git add -- SPEC\.md && git commit .*; then build #1, commit, then pullboard submit 1/u, 'after setup the applied row is committed before the coordinator’s first build');

  const box = project();
  box.env.PULLBOARD_VIEW_FOREGROUND = '1';
  const view = await startView(box, box.repo);
  await view.stop();
  const firstItem = JSON.parse(box.run(box.repo, 'resume', '--diagnostics', '--json').out).setup;
  assert.equal(firstItem?.step, 4, 'setup asks for the first small piece before planning the remaining rows');
  assert.equal(next(box, box.repo), firstItem.command);
  fixtureAdd(box.run, box.repo, 'web', 'Page', '--specs', 'G1');
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

test('spec check lints both files; spec view writes one page into the git dir [S6, S7]', async () => {
  const box = project();
  writeFileSync(join(box.repo, 'DOCTRINE.md'), '# Doctrine\n\n## C · Code\n- C1 [approved, must] Functions under 60 lines.\n');
  const check = (await command(box, box.repo, 'spec', 'check'));
  assert.equal(check.code, 1);
  assert.match(check.out, /DOCTRINE.md:4 C1 error: an approved must-row names its gate/);
  assert.match(check.out, /SPEC.md: 2 rows, 0 errors/);
  const view = (await command(box, box.repo, 'spec', 'view'));
  assert.equal(view.code, 0, view.err);
  const file = join(box.repo, '.git', 'pullboard', 'spec.html');
  assert.ok(readFileSync(file, 'utf8').includes('The page renders.'));
  assert.match(view.out, /open: file:\/\//);
});

