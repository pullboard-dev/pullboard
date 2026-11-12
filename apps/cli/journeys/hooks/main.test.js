/**
 * The commit-message rules (C1, C2) and the pre-commit pattern checks on real staged changes.
 */
import { boardBusyError } from '../../../../packages/store/index.js';
import { openBoardReadOnly } from '../../../../packages/store/index.js';
import { rowDecisions } from '../../../../packages/spec/index.js';
import { checkLoosening } from '../../../../packages/doctrine/index.js';

const approvedRowPorts = { boardBusyError, openBoardReadOnly, rowDecisions, checkLoosening };
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  runFixtureExecFile as execFileSync,
  runFixtureChildAsync,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { defaults } from '../../../../packages/config/index.js';
import {
  addedLines,
  blockedPaths,
  commitCitationWarnings,
  commitMsgProblems,
  hookScript,
  matchesPattern,
  preCommitProblems,
  secretsIn,
  unwiredHookProblems,
} from '../../../../packages/commits/index.js';
import { parseSpec } from '../../../../packages/spec/index.js';
import { Refused } from '../../../../packages/kernel/light.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const SPEC = { ...parseSpec('## G\n- G1 [approved, must] One. | gate: t\n- G2 [retired] Gone.\n'), name: 'SPEC.md' };
const RULES = defaults().commits;

test("a hook nudges and never blocks, fails open on error or timeout, and init merges with the user's hooks [I6]", async () => {
  const box = e2e.project('true');
  const result = await runCliInProcess(['hook', 'SessionStart'], {
    cwd: box.web, env: box.env, input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: box.web }),
  });
  assert.equal(result.code, 0, `a native session-start hook must nudge without refusing: ${result.out}${result.err}`);
  const response = JSON.parse(result.out);
  assert.equal(response.continue === false || response.decision === 'block', false);
  assert.equal(response.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(response.hookSpecificOutput.additionalContext, /pullboard|work|claim/i);
  const claude = join(box.repo, '.claude/settings.json'), codex = join(box.repo, '.codex/hooks.json');
  const mine = { permissions: { allow: ['Bash(my-check)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo my-stop' }] }] } };
  const codexMine = { description: 'My existing hooks', hooks: { SessionEnd: 'unrelated vendor metadata', SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo my-start' }] }] } };
  writeFileSync(claude, JSON.stringify(mine));
  writeFileSync(codex, JSON.stringify(codexMine));
  assert.equal((await box.runLocal(box.repo, 'init', '--no-permissions')).code, 0,
    'the actual init entrypoint merges existing agent hooks');
  const configured = [claude, codex].map(file => JSON.parse(readFileSync(file, 'utf8')));
  assert.ok(configured[0].hooks.SessionEnd.some(group => group.hooks.some(handler => handler.command.includes('hook SessionEnd'))));
  assert.equal(configured[1].hooks.SessionEnd, codexMine.hooks.SessionEnd, 'Codex preserves unrelated event data and installs only its existing supported events');
  assert.deepEqual(configured[0].permissions, mine.permissions);
  assert.deepEqual(configured[0].hooks.Stop[0], mine.hooks.Stop[0]);
  assert.deepEqual(configured[1].hooks.SessionStart[0], codexMine.hooks.SessionStart[0]);
  assert.equal(configured[1].description, codexMine.description);
  for (const settings of configured) for (const event of ['SessionStart', 'Stop']) {
    const handlers = settings.hooks[event].flatMap(group => group.hooks);
    assert.equal(handlers.filter(handler => handler.command.includes(`hook ${event}`)).length, 1);
    const handler = handlers.find(handler => handler.command.includes(`hook ${event}`));
    assert.equal(handler.type, 'command');
    assert.ok(handler.timeout > 0);
    assert.equal(handler.command.includes('\n'), false, 'the installation is one thin resolver line');
    const missing = runFixtureChild('/bin/sh', ['-c', handler.command], { cwd: box.dir,
      env: { ...box.env, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    assert.equal(missing.status, 0, 'missing executable cannot break the vendor session');
    assert.equal(missing.stdout, '');
  }
  const once = [readFileSync(claude, 'utf8'), readFileSync(codex, 'utf8')];
  assert.equal((await box.runLocal(box.repo, 'hooks')).code, 0);
  assert.deepEqual([readFileSync(claude, 'utf8'), readFileSync(codex, 'utf8')], once, 'merging twice is idempotent');

  const added = (await fixtureAdd(box.runLocal, box.repo, 'web', 'Native stop reminder', '--criterion', 'committed work is named', '--json'));
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal((await box.runLocal(box.web, 'claim', String(id))).code, 0);
  assert.equal(e2e.commitFile(box, box.web, 'web/nudge.txt', 'committed work\n', 'feat(web): nudge work [G1]').status, 0);
  // Contract probes use current documented vendor envelopes, never an actual user's transcript.
  // https://learn.chatgpt.com/docs/hooks and https://code.claude.com/docs/en/hooks
  for (const vendor of ['codex', 'claude']) {
    const payload = { session_id: `private-${vendor}-fixture`, cwd: box.web, hook_event_name: 'Stop', stop_hook_active: false,
      ...(vendor === 'codex' ? { turn_id: 'private-turn', last_assistant_message: null } : { transcript_path: join(box.dir, 'private-unused.jsonl') }) };
    const stop = await runCliInProcess(['hook', 'Stop'], { cwd: box.web, env: box.env, input: JSON.stringify(payload) });
    assert.equal(stop.code, 0, stop.err);
    const notice = JSON.parse(stop.out);
    assert.equal(notice.continue === false || notice.decision === 'block', false);
    assert.match(notice.systemMessage, new RegExp(`#${id}\\b`));
  }
  const broken = await runCliInProcess(['hook', 'SessionStart'], { cwd: box.dir, env: box.env });
  assert.equal(broken.code, 0);
  assert.match(JSON.parse(broken.out).systemMessage, /warning.*continuing/i);
  const unknown = await runCliInProcess(['hook', 'FutureVendorEvent'], { cwd: box.dir, env: box.env });
  assert.equal(unknown.code, 0);
  assert.equal(unknown.out, '');
  const slow = join(box.dir, 'slow-git');
  mkdirSync(slow);
  writeFileSync(join(slow, 'git'), '#!/bin/sh\nexec /bin/sleep 10\n');
  chmodSync(join(slow, 'git'), 0o755);
  // Process-level: the hook's wall-clock timeout against a hung git needs a real child.
  const timeout = runFixtureChild(process.execPath, [e2e.BIN, 'hook', 'SessionStart'], {
    cwd: box.web, env: { ...box.env, PATH: `${slow}:${box.env.PATH}` }, encoding: 'utf8',
  });
  assert.equal(timeout.status, 0);
  assert.match(JSON.parse(timeout.stdout).systemMessage, /timed out.*continuing/i);
  const doctor = (await box.runLocal(box.repo, 'doctor', '--json'));
  const status = JSON.parse(doctor.out).agentHooks.find(hook => hook.vendor === 'Codex');
  assert.deepEqual(status.events, ['SessionStart', 'Stop']);
  assert.equal(status.trust, 'unverified', 'installation never fabricates vendor trust');
  const validCodex = readFileSync(codex, 'utf8');
  writeFileSync(codex, '{ malformed user JSON');
  const malformed = (await box.runLocal(box.repo, 'hooks'));
  assert.equal(malformed.code, 0);
  assert.match(malformed.out, /warning.*kept.*unchanged/i);
  assert.equal(readFileSync(codex, 'utf8'), '{ malformed user JSON');
  writeFileSync(codex, validCodex);
  assert.equal((await box.runLocal(box.repo, 'hooks', 'uninstall')).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(claude, 'utf8')), mine);
  assert.deepEqual(JSON.parse(readFileSync(codex, 'utf8')), codexMine);
  const disabled = join(box.dir, 'disabled');
  mkdirSync(disabled);
  box.git(disabled, 'init', '-q', '-b', 'main');
  assert.equal((await box.runLocal(disabled, 'init', '--no-hooks', '--no-permissions')).code, 0);
  assert.equal(existsSync(join(disabled, '.codex/hooks.json')), false);
  assert.equal(existsSync(join(disabled, '.claude/settings.json')), false);
});

/** Make a private real repository for staged-diff hook tests, with cleanup tied to the test. */
function stagedRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-staged-diff-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  /** Run Git only in this fixture, without the maintainer's identity or configuration. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env, encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  return { root, git };
}

/** Run the same staged protections called by the installed pre-commit hook. */
function stagedProblems(root) {
  return preCommitProblems({ approvedRowPorts, root, isMain: true, config: defaults(), agent: null });
}

/**
 * Problems with a message under the default rules, or the given ones.
 */
const check = (message, rules = RULES) => commitMsgProblems(message, { rules, spec: SPEC });

test('hook wiring checks the configured path and accepts pullboard delegation [L3]', (t) => {
  const box = stagedRepo(t);
  const hooks = join(box.root, '.husky');
  mkdirSync(hooks);
  box.git('config', 'core.hooksPath', '.husky');
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nnpx lint-staged\n');
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  assert.deepEqual(unwiredHookProblems(box.root), [{
    code: 'HOOK_UNWIRED',
    message: 'active Git hook .husky/pre-commit does not call pullboard hook pre-commit',
    next: 'add this line: pullboard hook pre-commit "$@"',
  }]);
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\n# pullboard hook pre-commit "$@"\nnot-pullboard hook pre-commit\n');
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  assert.equal(unwiredHookProblems(box.root).length, 1);
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\npullboard hook pre-commit "$@"\n');
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  assert.deepEqual(unwiredHookProblems(box.root), []);
  for (const source of [
    `#!/bin/sh\necho 'pullboard hook pre-commit'\n`,
    `#!/bin/sh\necho 'example; pullboard hook pre-commit'\n`,
    '#!/bin/sh\nbin=some-other-tool; "$bin" hook pre-commit\n',
  ]) {
    writeFileSync(join(hooks, 'pre-commit'), source);
    assert.equal(unwiredHookProblems(box.root).length, 1, source);
  }
  for (const source of [
    '#!/bin/sh\nexec "$root/node_modules/.bin/pullboard" hook pre-commit\n',
    '#!/bin/sh\nnode "./apps/cli/pullboard.js" hook pre-commit\n',
  ]) {
    writeFileSync(join(hooks, 'pre-commit'), source);
    assert.deepEqual(unwiredHookProblems(box.root), [], source);
  }
  writeFileSync(join(hooks, 'pre-commit'), hookScript('pre-commit'));
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  assert.deepEqual(unwiredHookProblems(box.root), []);
});

test('clause 1: a clean header citing a live id passes [C1, C2]', () => {
  assert.deepEqual(check('feat(web): add the page [G1]'), []);
  assert.deepEqual(check('docs: explain lanes'), []);
  assert.deepEqual(check('feat(web)!: drop the old page [G1]\n\nThe old page is gone.'), []);
});

test('feat and fix cite ids; cited ids exist and are not retired [C2]', () => {
  assert.match(check('feat(web): add the page')[0], /end the header with the spec rows this feat serves, like \[G1\]/);
  assert.match(check('fix: patch [G9]')[0], /G9 is not in SPEC.md/);
  assert.match(check('fix: patch [G2]')[0], /G2 is retired/);
});

test('doctrine citations are namespaced; a colliding bare id warns that it resolves to SPEC.md [A5]', () => {
  const doctrine = {
    name: 'DOCTRINE.md',
    repo: { rows: [{ id: 'G1', line: 4 }] },
    rows: [{ id: 'G1', status: 'approved' }, { id: 'PB1', status: 'approved' }],
  };
  assert.deepEqual(commitMsgProblems('feat(web): add the rule [doctrine:PB1]', { rules: RULES, spec: SPEC, doctrine }), []);
  assert.deepEqual(commitMsgProblems('feat(web): add the rule [doctrine:G1]', { rules: RULES, spec: SPEC, doctrine }), []);
  assert.match(commitMsgProblems('fix(web): add the rule [doctrine:missing]', { rules: RULES, spec: SPEC, doctrine })[0], /doctrine:missing is not in doctrine/u);
  assert.deepEqual(commitCitationWarnings('feat(web): patch the rule [G1]', { spec: SPEC, doctrine }), [
    'G1 is a known collision at SPEC.md:2 and DOCTRINE.md:4; bare ids cite SPEC.md, use doctrine:G1 for a doctrine row',
  ]);
});

test('header format, length, case and period [C1]', () => {
  assert.match(check('Added the page')[0], /type\(scope\): subject/);
  assert.match(check('Added the page')[0], /saw "Added the page"/, 'the refusal shows the header it saw (C4)');
  assert.match(check('feature: add the page [G1]')[0], /type\(scope\): subject/, 'a type outside the configured list is refused');
  assert.match(check(`docs: ${'x'.repeat(80)}`)[0], /shorten the header to 72 characters or fewer \(it has 86\)/);
  assert.deepEqual(check('docs: Explain lanes.'), [
    'start the subject with a lowercase letter (saw "Explain lanes.")',
    'remove the period at the end of the subject',
  ]);
  assert.match(check('feat: x [G K P D]')[0], /cite only rows that exist and are live, separated by commas \(/);
  assert.match(check('feat: x [G K P D]')[0], /like \[G1\]/, 'invalid-id guidance names only an approved row that exists');
  assert.deepEqual(check('docs: explain lanes\nsecond line'), ['leave a blank line after the header']);
});

test('comments are dropped; merges, reverts and fixups are exempt [C1]', () => {
  assert.deepEqual(check('docs: explain lanes\n# Please enter the commit message'), []);
  assert.deepEqual(check("Merge branch 'web/page'"), []);
  assert.deepEqual(check('fixup! feat(web): add the page [G1]'), []);
});

test('opt-in rules: filler words, emoji, co-author trailers [C1]', () => {
  const strict = { ...RULES, banned: ['basically', 'seamless'], noEmoji: true, noCoAuthor: true };
  const problems = check('docs: basically seamless lanes \u{1F680}\n\nCo-Authored-By: Bot <b@x>', strict);
  assert.deepEqual(problems, ['drop the filler word "basically"', 'drop the filler word "seamless"', 'remove the emoji', 'remove the Co-Authored-By trailer']);
  assert.deepEqual(check('docs: basically fine'), []);
});

test('blocked paths: env files by name, examples allowed, patterns with a slash match paths [C5]', () => {
  const protect = { ...defaults().protect, blocked: [...defaults().protect.blocked, 'data/*.csv'] };
  assert.deepEqual(
    blockedPaths(['.env', 'app/.env.local', 'prod.env', '.env.example', 'data/claims.csv', 'docs/data/x.csv', 'src/a.js'], protect),
    ['.env', 'app/.env.local', 'prod.env', 'data/claims.csv'],
  );
  assert.ok(matchesPattern('*.env', 'deep/dir/staging.env'));
  assert.ok(!matchesPattern('.env.*', 'environment.js'));
});

test('secrets are named by kind and place, never echoed [C5]', () => {
  // Built at run time, so this file never holds a string its own pre-commit scan would refuse.
  const fakeKey = ['sk', 'ant', 'abcdefghijklmnopqrstuvwxyz0123'].join('-');
  const diff = [
    '+++ b/config/settings.js',
    '@@ -0,0 +1,3 @@',
    '+const ok = 1;',
    `+const key = "${fakeKey}";`,
    '+export CLOUDFLARE_API_TOKEN=abcdefghijklmnopqrstuvwxyz012345',
  ].join('\n');
  const found = secretsIn(addedLines(diff));
  assert.deepEqual(found, ['Anthropic key at config/settings.js:2', 'env-style secret at config/settings.js:3']);
  assert.ok(found.every((entry) => !entry.includes('abcdefghij')));
});

test('the secret scan handles 2.4 MiB of binary images and finds an embedded key [P4]', (t) => {
  const box = stagedRepo(t);
  const secret = `sk-ant-${'A'.repeat(32)}`;
  for (let index = 0; index < 17; index += 1) {
    const image = Buffer.alloc(150_000);
    image.set([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]);
    if (index === 0) image.write(`${secret}\n`, 11, 'ascii');
    writeFileSync(join(box.root, `image-${index}.jpg`), image);
  }
  box.git('add', '--', '*.jpg');
  const problems = stagedProblems(box.root);
  assert.deepEqual(problems, ['possible secret: Anthropic key at image-0.jpg:1']);
  assert.ok(!problems.join(' ').includes(secret));
});

test('a staged diff beyond the safe output limit is a private coded refusal [P4]', (t) => {
  const box = stagedRepo(t);
  const marker = 'STAGED_CONTENT_MUST_NOT_BE_ECHOED';
  writeFileSync(join(box.root, 'large.txt'), `${marker}\n${'ordinary text\n'.repeat(700_000)}`);
  box.git('add', '--', 'large.txt');
  assert.throws(() => stagedProblems(box.root), (error) => {
    assert.ok(error instanceof Refused);
    assert.equal(error.code, 'DIFF_TOO_LARGE');
    assert.match(error.message, /large\.txt alone exceeds the safe scan limit; split that file into smaller commits, then retry/);
    assert.ok(!error.message.includes(marker));
    return true;
  });
});

test('pre-commit still refuses and redacts a staged text secret [P4]', (t) => {
  const box = stagedRepo(t);
  const secret = `sk-ant-${'A'.repeat(32)}`;
  writeFileSync(join(box.root, 'settings.js'), `const token = \"${secret}\";\n`);
  box.git('add', '--', 'settings.js');
  const problems = stagedProblems(box.root);
  assert.deepEqual(problems, ['possible secret: Anthropic key at settings.js:1']);
  assert.ok(!problems.join(' ').includes(secret));
});

test('a refused merge message points to the message git writes, which is exempt [C4]', () => {
  assert.match(check('merge: include store date validation')[0], /For a merge, keep the message git writes, which is exempt: git merge --no-edit/);
  assert.deepEqual(check("Merge branch 'store/1'"), []);
});


test('a spec-less feature commit is told a path that works [S1,B26]', async () => {
  const box = e2e.sandbox();
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

test('a lane agent drafts a row and cites it without leaving its lane [S1,B26]', async () => {
  const box = e2e.project('pullboard spec check');
  assert.equal((await fixtureAdd(box.runLocal, box.repo, 'web', 'Show the list', '--criterion', 'web/list.html exists')).code, 0);
  const claimed = (await box.runLocal(box.web, 'claim', '1'));
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  const drafted = (await box.runLocal(box.web, 'spec', 'draft', 'A person sees their list', '--json'));
  assert.equal(drafted.code, 0, drafted.out + drafted.err);
  const id = JSON.parse(drafted.out).id;
  assert.match(id, /^G\d+$/u, `spec draft prints the new id: ${drafted.out}`);
  assert.equal(box.tryGit(box.web, 'status', '--porcelain').stdout, '', 'drafting from the lane leaves its worktree clean');
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web', 'list.html'), '<ul></ul>\n');
  box.git(box.web, 'add', 'web/list.html');
  const commit = box.tryGit(box.web, 'commit', '-q', '-m', `feat(web): show the list [${id}]`);
  assert.equal(commit.status, 0, `the lane cites its drafted row in a feature commit: ${commit.stderr}`);
  const submitted = (await box.runLocal(box.web, 'submit', '1'));
  assert.equal(submitted.code, 0, `the lane submits with the gate pullboard spec check: ${submitted.out}${submitted.err}`);

  // The coordinator's spec apply writes the board draft into SPEC.md as a draft row, and the person approves it there.
  const row = () => readFileSync(join(box.repo, 'SPEC.md'), 'utf8').split('\n').find((line) => line.startsWith(`- ${id} `));
  assert.equal(row(), undefined, 'until apply, SPEC.md does not hold the lane draft');
  const applied = (await box.runLocal(box.repo, 'spec', 'apply'));
  assert.equal(applied.code, 0, applied.out + applied.err);
  assert.match(applied.out, new RegExp(`${id} drafted from a lane, for the person to approve`, 'u'));
  assert.equal(row(), `- ${id} [draft, must] A person sees their list | gate: review`, 'spec apply writes the draft at its own id');
  assert.equal((await box.runLocal(box.repo, 'spec', 'approve', id)).code, 0, 'the person approves the drafted row as before');
  assert.equal((await box.runLocal(box.repo, 'spec', 'apply')).code, 0);
  assert.match(row(), /\[approved, must\]/u, 'the approved row is applied');
});

test('a lane draft and a coordinator draft never share an id, in either order [S1,B26]', async () => {
  const box = e2e.project('pullboard spec check');
  const draft = async (cwd, text) => {
    const result = (await box.runLocal(cwd, 'spec', 'draft', text, '--json'));
    assert.equal(result.code, 0, result.out + result.err);
    return JSON.parse(result.out).id;
  };
  // Lane first: the coordinator's next id skips the lane's board draft.
  const laneFirst = (await draft(box.web, 'A lane row drafted first'));
  const coordinatorAfter = (await draft(box.repo, 'A coordinator row drafted after'));
  // Coordinator first, committed through the installed hooks: the lane's older files lack it, and its next id still skips it.
  const coordinatorFirst = (await draft(box.repo, 'A coordinator row drafted first'));
  box.git(box.repo, 'add', 'SPEC.md');
  const committed = box.tryGit(box.repo, 'commit', '-q', '-m', `docs(spec): draft two rows [${coordinatorAfter},${coordinatorFirst}]`);
  assert.equal(committed.status, 0, committed.stderr);
  const laneAfter = (await draft(box.web, 'A lane row drafted after'));
  const ids = [laneFirst, coordinatorAfter, coordinatorFirst, laneAfter];
  assert.equal(new Set(ids).size, 4, `every proposal keeps its own id: ${ids.join(', ')}`);
  assert.equal(box.tryGit(box.web, 'status', '--porcelain').stdout, '', 'the lane edits no file outside its lane');

  const applied = (await box.runLocal(box.repo, 'spec', 'apply'));
  assert.equal(applied.code, 0, applied.out + applied.err);
  assert.doesNotMatch(applied.out, /holds other text/u);
  const spec = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  for (const [id, text] of [[laneFirst, 'A lane row drafted first'], [coordinatorAfter, 'A coordinator row drafted after'],
    [coordinatorFirst, 'A coordinator row drafted first'], [laneAfter, 'A lane row drafted after']]) {
    assert.ok(spec.includes(`- ${id} [draft, must] ${text} | gate: review`), `${id} keeps its own text as a draft after apply`);
  }
  const approve = (await box.runLocal(box.web, 'spec', 'approve', laneAfter));
  assert.notEqual(approve.code, 0, 'a lane cannot approve its own draft; the person does');
});

test('a lane draft and a main-checkout draft started at the same moment keep distinct ids [S1,B26]', async () => {
  const box = e2e.project('pullboard spec check');
  const cli = resolve(import.meta.dirname, '../../pullboard.js');
  /** Start one real spec draft without waiting for it. */
  // Process-level: two separate processes contend for the board lock.
  const start = (cwd, text) => runFixtureChildAsync(process.execPath, [cli, 'spec', 'draft', text, '--json'], { cwd, env: box.env });
  const proposals = [];
  for (let pair = 1; pair <= 4; pair += 1) {
    const texts = [`A lane row from pair ${pair}`, `A coordinator row from pair ${pair}`];
    const results = await Promise.all([start(box.web, texts[0]), start(box.repo, texts[1])]);
    results.forEach((result, index) => {
      assert.equal(result.status, 0, result.context);
      proposals.push({ id: JSON.parse(result.stdout).id, text: texts[index] });
    });
  }
  assert.equal(new Set(proposals.map(({ id }) => id)).size, proposals.length, `every proposal keeps its own id: ${proposals.map(({ id }) => id).join(', ')}`);
  assert.equal(box.tryGit(box.web, 'status', '--porcelain').stdout, '', 'the lane edits no file outside its lane');

  const applied = (await box.runLocal(box.repo, 'spec', 'apply'));
  assert.equal(applied.code, 0, applied.out + applied.err);
  assert.doesNotMatch(applied.out, /holds other text/u);
  const spec = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  for (const { id, text } of proposals) assert.ok(spec.includes(`- ${id} [draft, must] ${text} | gate: review`), `${id} keeps its own text as a draft after apply`);
  assert.notEqual((await box.runLocal(box.web, 'spec', 'approve', proposals[0].id)).code, 0, 'a lane cannot approve its own draft; the person does');

  // The same headline with a different gate and tier is another proposal: each writer keeps its own definition.
  const headline = 'A row both writers name alike';
  // Process-level: two separate processes contend for the board lock.
  const [lane, main] = await Promise.all([
    runFixtureChildAsync(process.execPath, [cli, 'spec', 'draft', headline, '--gate', 'true', '--aim', '--json'], { cwd: box.web, env: box.env }),
    runFixtureChildAsync(process.execPath, [cli, 'spec', 'draft', headline, '--gate', 'false', '--json'], { cwd: box.repo, env: box.env }),
  ]);
  assert.equal(lane.status, 0, lane.context);
  assert.equal(main.status, 0, main.context);
  const laneRow = JSON.parse(lane.stdout);
  const mainRow = JSON.parse(main.stdout);
  assert.notEqual(laneRow.id, mainRow.id, 'two definitions with one headline get two ids');
  assert.deepEqual([laneRow.row.gate, laneRow.row.tier], ['true', 'aim'], 'the lane gets back its own definition');
  assert.deepEqual([mainRow.row.gate, mainRow.row.tier], ['false', 'must'], 'the main checkout gets back its own definition');
  assert.equal(box.tryGit(box.web, 'status', '--porcelain').stdout, '');
  assert.equal((await box.runLocal(box.repo, 'spec', 'apply')).code, 0);
  const both = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  assert.ok(both.includes(`- ${laneRow.id} [draft, aim] ${headline} | gate: true`), 'the lane row is applied as it was asked');
  assert.ok(both.includes(`- ${mainRow.id} [draft, must] ${headline} | gate: false`), 'the main row stays as it was written');
  assert.notEqual((await box.runLocal(box.web, 'spec', 'approve', laneRow.id)).code, 0, 'the person alone approves');
});

test('a hook names a Pullboard version mismatch instead of running old rules [C1,I2]', (t) => {
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
  assert.match(result.stderr, /Pullboard 0\.9\.9\. Run: pullboard init/u, 'newer rules rewrite the hooks with init');

  fake(bin, '0.9.0');
  result = commit();
  assert.equal(result.status, 0, `the matching version runs: ${result.stderr}`);
  assert.match(result.stderr, /rules of 0\.9\.0 ran/u, 'the hook runs the version that installed it');
});

test('pre-push keeps its ref records when the version query reads stdin [C3,L3,I2]', () => {
  const box = e2e.project('test ! -f RED');
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

test('#4005 clause 1: committing a new unlisted root test is refused naming the cell tests folder and the next step [C7]', (t) => {
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

test('#4005 clause 2: a new cell test, a listed journey and an edit to an existing root test all commit [C7]', (t) => {
  const box = cellRepo(t);
  mkdirSync(join(box.root, 'packages/alpha/tests'), { recursive: true });
  writeFileSync(join(box.root, 'packages/alpha/tests/unit.test.js'), "import { test } from 'node:test';\n");
  writeFileSync(join(box.root, 'test/listed.test.js'), "import { test } from 'node:test';\n");
  writeFileSync(join(box.root, 'test/old.test.js'), "import { test } from 'node:test';\n// edited\n");
  box.git('add', '-A');
  assert.deepEqual(stagedProblems(box.root), []);
});

test('#4005: a repository without the test-cell listing keeps adding root tests as before [C7]', (t) => {
  const box = stagedRepo(t);
  mkdirSync(join(box.root, 'test'), { recursive: true });
  writeFileSync(join(box.root, 'test/first.test.js'), "import { test } from 'node:test';\n");
  box.git('add', '-A');
  assert.deepEqual(stagedProblems(box.root), []);
});
