/**
 * The commit-message rules (C1, C2) and the pre-commit pattern checks on real staged changes.
 */
import { boardBusyError } from '../../../../packages/store/index.js';
import { openBoardReadOnly } from '../../../../packages/store/index.js';
import { rowDecisions } from '../../../../packages/spec/index.js';
import { checkLoosening } from '../../../../packages/doctrine/index.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { defaults } from '../../../../packages/config/index.js';
import {
  commitMsgProblems,
  hookScript,
  preCommitProblems,
} from '../../../../packages/commits/index.js';
import { parseSpec } from '../../../../packages/spec/index.js';
import { Refused } from '../../../../packages/kernel/light.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureSettledMachine } from '../../tests/fixtures/testkit.js';
import { stagedRepo } from '../../tests/fixtures/hooks-staged.js';

const approvedRowPorts = { boardBusyError, openBoardReadOnly, rowDecisions, checkLoosening };

const e2e = createE2eHelpers();
after(e2e.cleanup);

const SPEC = { ...parseSpec('## G\n- G1 [approved, must] One. | gate: t\n- G2 [retired] Gone.\n'), name: 'SPEC.md' };
const RULES = defaults().commits;

/** Run the same staged protections called by the installed pre-commit hook. */
function stagedProblems(root) {
  return preCommitProblems({ approvedRowPorts, root, isMain: true, config: defaults(), agent: null });
}

/**
 * Problems with a message under the default rules, or the given ones.
 */
const check = (message, rules = RULES) => commitMsgProblems(message, { rules, spec: SPEC });

test('cli.journeys-hooks-main-part2.a-secret-in-a-staged-text: a secret in a staged text file is still refused [S1]', (t) => {
  const box = stagedRepo(t);
  const secret = `sk-ant-${'A'.repeat(32)}`;
  writeFileSync(join(box.root, 'settings.js'), `const token = \"${secret}\";\n`);
  box.git('add', '--', 'settings.js');
  const problems = stagedProblems(box.root);
  assert.deepEqual(problems, ['possible secret: Anthropic key at settings.js:1']);
  assert.ok(!problems.join(' ').includes(secret));
});

test('cli.journeys-hooks-main-part2.a-refused-merge-message-points-to: a refused merge message points to the message git writes, which is exempt [C4]', () => {
  assert.match(check('merge: include store date validation')[0], /For a merge, keep the message git writes, which is exempt: git merge --no-edit/);
  assert.deepEqual(check("Merge branch 'store/1'"), []);
});

test('cli.journeys-hooks-main-part2.a-spec-less-feature-commit-is: a spec-less feature commit is told a path that works [S1,B26]', async () => {
  const box = e2e.sandbox();
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { test: { inProcessHooks: false } });
  const root = join(box.dir, 'newcomer');
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  const initialized = (await box.runLocal(root, 'init'));
  assert.equal(initialized.code, 0, initialized.err || initialized.out);
  const source = readFileSync(join(root, 'SPEC.md'), 'utf8');
  assert.match(source, /- G1 \[draft, must\]/u, 'the fresh spec visibly contains a fenced format example');
  const listed = (await box.runLocal(root, 'spec', '--json'));
  assert.equal(listed.code, 0, listed.err || listed.out);
  assert.deepEqual(JSON.parse(listed.out).rows.filter(row => row.file === 'SPEC.md'), [], 'the example is not a real row');
  assert.equal((await box.runLocal(root, 'lane', 'add', 'app', '--owns', 'app/')).code, 0);
  mkdirSync(join(root, 'app'));
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', 'chore: set up the private board');
  const added = (await fixtureAdd(box.runLocal, root, 'app', 'Build the first useful thing', '--criterion', 'The first useful thing works.', '--json'));
  assert.equal(added.code, 0, added.err || added.out);
  assert.equal(JSON.parse(added.out).item.item_spec_ids, '');
  writeFileSync(join(root, 'app/first.txt'), 'first useful thing\n');
  box.git(root, 'add', '--', 'app/first.txt');
  const missing = box.tryGit(root, 'commit', '-q', '-m', 'feat(app): build the first useful thing');
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /pullboard spec draft "<text>"/u, 'the actual installed hook names a supported command');
  assert.match(missing.stderr, /cite the returned id now/iu, 'a draft id is usable immediately');
  assert.match(missing.stderr, /the person approves it in parallel/iu, 'approval happens alongside useful work');
  assert.doesNotMatch(missing.stderr, /then cite it|wait for (?:the person )?approval/iu, 'the refusal does not tell the agent to wait');
  assert.doesNotMatch(missing.stderr, /like \[G1,G2\]|as a chore|use chore/iu, 'the hook neither invents ids nor mislabels the feature');
  const malformed = box.tryGit(root, 'commit', '-q', '-m', 'Added the first useful thing');
  assert.notEqual(malformed.status, 0);
  assert.doesNotMatch(malformed.stderr, /\[G7\]/u, 'format guidance also avoids an invented citation');
  const copiedExample = box.tryGit(root, 'commit', '-q', '-m', 'feat(app): build the first useful thing [G1]');
  assert.notEqual(copiedExample.status, 0);
  assert.match(copiedExample.stderr, /G1 is not in SPEC\.md/u);
  assert.match(copiedExample.stderr, /fenced.*example.*not.*rows/iu, 'the refusal explains why the visible format example is not a row');
  const drafted = (await box.runLocal(root, 'spec', 'draft', 'The first useful thing works.', '--json'));
  assert.equal(drafted.code, 0, drafted.err || drafted.out);
  const id = JSON.parse(drafted.out).id;
  const citedBeforeApproval = box.tryGit(root, 'commit', '-q', '-m', `feat(app): build the first useful thing [${id}]`);
  assert.equal(citedBeforeApproval.status, 0, citedBeforeApproval.failure || citedBeforeApproval.stderr || citedBeforeApproval.stdout);
  for (const args of [['spec', 'approve', id], ['spec', 'apply']]) {
    const result = (await box.runLocal(root, ...args));
    assert.equal(result.code, 0, result.err || result.out);
  }
  writeFileSync(join(root, 'app/first.txt'), 'first useful thing, approved\n');
  box.git(root, 'add', '-A');
  const committed = box.tryGit(root, 'commit', '-q', '-m', `feat(app): build the first useful thing [${id}]`);
  assert.equal(committed.status, 0, committed.failure || committed.stderr || committed.stdout);

  for (const [open, close] of [['```markdown', '```'], ['~~~markdown', '~~~'], ['   ````markdown', '   ````'], ['````markdown\n```', '````']]) {
    const fenced = parseSpec(`## G\n${open}\n- G1 [approved, must] Example only. | gate: true\n${close}\n- R9 [approved, must] Real requirement. | gate: true\n`);
    assert.deepEqual(fenced.rows.map(row => row.id), ['R9'], `only real rows are read around ${open}`);
    const advice = commitMsgProblems('feat(app): add a feature', { rules: RULES, spec: { ...fenced, name: 'SPEC.md' } });
    assert.match(advice.join('\n'), /\[R9\]/u, 'an approved board names an id that really exists');
    assert.doesNotMatch(advice.join('\n'), /\[G1(?:,G2)?\]/u, 'a fenced example is never suggested as a citation');
  }
});

test('cli.journeys-hooks-main-part2.a-hook-names-a-pullboard-version: a hook names a Pullboard version mismatch instead of running old rules [C1,I2]', (t) => {
  const box = stagedRepo(t);
  const hooks = join(box.root, '.githooks'), bin = join(box.root, '.fakebin'), local = join(box.root, 'node_modules', '.bin');
  mkdirSync(hooks); mkdirSync(bin);
  box.git('config', 'core.hooksPath', '.githooks');
  box.git('config', 'user.name', 'Fixture');
  box.git('config', 'user.email', 'fixture@example.com');
  writeFileSync(join(hooks, 'commit-msg'), hookScript('commit-msg', '0.9.0'));
  chmodSync(join(hooks, 'commit-msg'), 0o755);
  /** A pullboard that reports one version and says so if its rules ever run. */
  const fake = (dir, version) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pullboard'), `#!/bin/sh\nif [ "$1" = --version ]; then echo ${version}; exit 0; fi\necho "rules of ${version} ran" >&2\nexit 0\n`);
    chmodSync(join(dir, 'pullboard'), 0o755);
  };
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const commit = () => spawnSync('git', ['commit', '--allow-empty', '-q', '-m', 'chore: try a commit'], { cwd: box.root, env, encoding: 'utf8' });

  fake(bin, '0.8.4');
  let result = commit();
  assert.equal(result.status, 1, 'an older global pullboard is stopped');
  assert.match(result.stderr, /stopped before running any rule; these hooks were installed by Pullboard 0\.9\.0, but pullboard is Pullboard 0\.8\.4\. Run: npm i -g pullboard@0\.9\.0/u);
  assert.doesNotMatch(result.stderr, /rules of 0\.8\.4 ran/u, 'the old rules never run');

  fake(local, '0.8.4');
  result = commit();
  assert.equal(result.status, 1, 'an older project install is stopped');
  assert.match(result.stderr, /Pullboard 0\.8\.4\. Run: npm i -D pullboard@0\.9\.0/u, 'a project install is fixed in the project');
  rmSync(join(box.root, 'node_modules'), { recursive: true, force: true });

  fake(bin, '0.9.9');
  result = commit();
  assert.equal(result.status, 1, 'a newer pullboard under older hooks is stopped too');
  assert.match(result.stderr, /Pullboard 0\.9\.9\. Run: cd ".*" && pullboard init/u, 'newer rules rewrite the hooks with init, from the main checkout');

  fake(bin, '0.9.0');
  result = commit();
  assert.equal(result.status, 0, `the matching version runs: ${result.stderr}`);
  assert.match(result.stderr, /rules of 0\.9\.0 ran/u, 'the hook runs the version that installed it');
});

test('cli.journeys-hooks-main-part2.pre-push-keeps-its-ref-records: pre-push keeps its ref records when the version query reads stdin [C3,L3,I2]', () => {
  const box = e2e.project('test ! -f RED');
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { test: { inProcessHooks: false } });
  writeFileSync(join(box.repo, 'RED'), 'this older commit is red\n');
  box.git(box.repo, 'add', 'RED');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: create the red commit');
  const red = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  box.git(box.repo, 'rm', '-q', 'RED');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: check out a green commit');
  const green = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  assert.notEqual(red, green);
  const remote = join(box.dir, 'private-remote.git');
  box.git(box.dir, 'init', '--bare', '-q', remote);
  box.git(box.repo, 'remote', 'add', 'private', remote);
  const wrapper = join(box.dir, 'version-wrapper');
  mkdirSync(wrapper);
  /** Quote the controlled Node executable and the real fixture CLI. */
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(join(wrapper, 'pullboard'), '#!/bin/sh\nif [ "$1" = --version ]; then cat > "$HOOK_VERSION_STDIN"; fi\nexec '
    + quote(process.execPath) + ' ' + quote(e2e.BIN) + ' "$@"\n');
  chmodSync(join(wrapper, 'pullboard'), 0o755);
  box.env.PATH = `${wrapper}:${box.env.PATH}`;
  box.env.HOOK_VERSION_STDIN = join(box.dir, 'version-input');

  const pushed = box.tryGit(box.repo, 'push', 'private', `${red}:refs/heads/main`);
  assert.notEqual(pushed.status, 0, `the gate on ${green} must not admit ${red}: ${pushed.stdout}${pushed.stderr}`);
  assert.match(pushed.stderr, /is not checked out/u, pushed.stderr);
  assert.notEqual(box.tryGit(remote, 'rev-parse', '--verify', 'refs/heads/main').status, 0,
    'the rejected push leaves the private remote unchanged');
  assert.equal(readFileSync(box.env.HOOK_VERSION_STDIN, 'utf8'), '', 'the version query receives EOF');

  const matching = box.tryGit(box.repo, 'push', 'private', `${green}:refs/heads/main`);
  assert.equal(matching.status, 0, matching.failure || matching.stderr || matching.stdout);
  assert.equal(box.git(remote, 'rev-parse', 'refs/heads/main').trim(), green,
    'the real hook still admits the checked and gated commit');
  assert.equal(readFileSync(box.env.HOOK_VERSION_STDIN, 'utf8'), '', 'the successful push also preserves its refs');
});

for (const channel of ['stderr', 'stdout', 'matching-output']) {
  test(`a failed ${channel} hook version probe shows its refusal before rules run [C1,C3,P3,P4]`, (t) => {
    const box = stagedRepo(t);
    const bin = join(box.root, '.probe-bin');
    mkdirSync(bin);
    const executable = join(bin, 'pullboard');
    const refusal = 'probe refused: install Node 22.13 or newer, then retry';
    const output = channel === 'stdout'
      ? `printf '%s\\n' '${refusal}'`
      : `${channel === 'matching-output' ? "printf '%s\\n' '0.9.0'; " : ''}printf '%s\\n' '${refusal}' >&2`;
    writeFileSync(executable, `#!/bin/sh\nif [ "$1" = --version ]; then ${output}; exit 7; fi\nprintf '%s\\n' 'RULE_RAN' >&2\nexit 0\n`);
    chmodSync(executable, 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    for (const hook of ['pre-commit', 'pre-merge-commit', 'commit-msg', 'pre-push', 'post-commit']) {
      const file = join(box.root, `try-${hook}`);
      writeFileSync(file, hookScript(hook, '0.9.0'));
      const result = spawnSync('/bin/sh', [file, join(box.root, 'MESSAGE')], { cwd: box.root, env, input: 'private ref records\n', encoding: 'utf8', timeout: 6000 });
      assert.notEqual(result.status, 0, `${hook} must refuse a failed probe even if it prints the matching version`);
      assert.ok(result.stderr.includes(refusal), `${hook} must show the probe's own refusal: ${result.stderr}`);
      assert.doesNotMatch(result.stderr, /these hooks were installed|Run: npm i|Run: pullboard init|RULE_RAN/u, `${hook} must not invent version advice or run rules`);
      assert.equal(result.stdout, '', `${hook} reports the refusal on stderr`);
    }
  });
}

/** A staged repository that has adopted test cells: its listing names one journey, and one root test is already committed. */
function cellRepo(t) {
  const box = stagedRepo(t);
  mkdirSync(join(box.root, 'bin/checks'), { recursive: true });
  mkdirSync(join(box.root, 'test'), { recursive: true });
  mkdirSync(join(box.root, 'packages/gate/data/tests'), { recursive: true });
  writeFileSync(join(box.root, 'packages/gate/data/tests/test-cells.json'), JSON.stringify({ journeys: { 'test/listed.test.js': 'drives the CLI end to end' } }) + '\n');
  writeFileSync(join(box.root, 'test/old.test.js'), "import { test } from 'node:test';\n");
  box.git('add', '-A');
  box.git('-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-q', '-m', 'chore: adopt test cells');
  return box;
}

test('cli.journeys-hooks-main-part2.t-4005-clause-1-committing-a-new: #4005 clause 1: committing a new unlisted root test is refused naming the cell tests folder and the next step [C7]', (t) => {
  const box = cellRepo(t);
  writeFileSync(join(box.root, 'test/new.test.js'), "import { test } from 'node:test';\n");
  box.git('add', '--', 'test/new.test.js');
  assert.throws(() => stagedProblems(box.root), (error) => {
    assert.ok(error instanceof Refused);
    assert.equal(error.code, 'ROOT_TEST_UNLISTED');
    assert.match(error.message, /test\/new\.test\.js is a new root test that packages\/gate\/data\/tests\/test-cells\.json does not list as a journey/u);
    assert.match(error.next, /packages\/<cell>\/tests\//u);
    return true;
  });
});

test('cli.journeys-hooks-main-part2.t-4005-clause-2-a-new-cell: #4005 clause 2: a new cell test, a listed journey and an edit to an existing root test all commit [C7]', (t) => {
  const box = cellRepo(t);
  mkdirSync(join(box.root, 'packages/alpha/tests'), { recursive: true });
  writeFileSync(join(box.root, 'packages/alpha/tests/unit.test.js'), "import { test } from 'node:test';\n");
  writeFileSync(join(box.root, 'test/listed.test.js'), "import { test } from 'node:test';\n");
  writeFileSync(join(box.root, 'test/old.test.js'), "import { test } from 'node:test';\n// edited\n");
  box.git('add', '-A');
  assert.deepEqual(stagedProblems(box.root), []);
});

test('cli.journeys-hooks-main-part2.t-4005-a-repository-without-the-test: #4005: a repository without the test-cell listing keeps adding root tests as before [C7]', (t) => {
  const box = stagedRepo(t);
  mkdirSync(join(box.root, 'test'), { recursive: true });
  writeFileSync(join(box.root, 'test/first.test.js'), "import { test } from 'node:test';\n");
  box.git('add', '-A');
  assert.deepEqual(stagedProblems(box.root), []);
});
