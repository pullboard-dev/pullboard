/**
 * The commit-message rules (C1, C2) and the pre-commit pattern checks on real staged changes.
 */
import { boardBusyError } from '../../../../packages/store/index.js';
import { openBoardReadOnly } from '../../../../packages/store/index.js';
import { rowDecisions } from '../../../../packages/spec/index.js';
import { checkLoosening } from '../../../../packages/doctrine/index.js';
import assert from 'node:assert/strict';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
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
import { fixtureSettledMachine } from '../../tests/fixtures/testkit.js';
import { stagedRepo } from '../../tests/fixtures/hooks-staged.js';

const approvedRowPorts = { boardBusyError, openBoardReadOnly, rowDecisions, checkLoosening };

const e2e = createE2eHelpers();
after(e2e.cleanup);

const SPEC = { ...parseSpec('## G\n- G1 [approved, must] One. | gate: t\n- G2 [retired] Gone.\n'), name: 'SPEC.md' };
const RULES = defaults().commits;

test('cli.journeys-hooks-main.a-hook-nudges-and-never-blocks: a hook nudges and never blocks, fails open on error or timeout, and init merges with the user\'s hooks [I6]', async () => {
  const box = e2e.project('true');
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { test: { inProcessHooks: false } });
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

/** Run the same staged protections called by the installed pre-commit hook. */
function stagedProblems(root) {
  return preCommitProblems({ approvedRowPorts, root, isMain: true, config: defaults(), agent: null });
}

/**
 * Problems with a message under the default rules, or the given ones.
 */
const check = (message, rules = RULES) => commitMsgProblems(message, { rules, spec: SPEC });

test('cli.journeys-hooks-main.hook-wiring-checks-the-configured-path: hook wiring checks the configured path and accepts pullboard delegation [L3]', (t) => {
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

test('cli.journeys-hooks-main.a-clean-header-citing-a-live: clause 1: a clean header citing a live id passes [C1, C2]', () => {
  assert.deepEqual(check('feat(web): add the page [G1]'), []);
  assert.deepEqual(check('docs: explain lanes'), []);
  assert.deepEqual(check('feat(web)!: drop the old page [G1]\n\nThe old page is gone.'), []);
});

test('cli.journeys-hooks-main.feat-and-fix-cite-ids-cited: feat and fix cite ids; cited ids exist and are not retired [C2]', () => {
  assert.match(check('feat(web): add the page')[0], /end the header with the spec rows this feat serves, like \[G1\]/);
  assert.match(check('fix: patch [G9]')[0], /G9 is not in SPEC.md/);
  assert.match(check('fix: patch [G2]')[0], /G2 is retired/);
});

test('cli.journeys-hooks-main.doctrine-citations-are-namespaced-a-colliding: doctrine citations are namespaced; a colliding bare id warns that it resolves to SPEC.md [A5]', () => {
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

test('cli.journeys-hooks-main.header-format-length-case-and-period: header format, length, case and period [C1]', () => {
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

test('cli.journeys-hooks-main.comments-are-dropped-merges-reverts-and: comments are dropped; merges, reverts and fixups are exempt [C1]', () => {
  assert.deepEqual(check('docs: explain lanes\n# Please enter the commit message'), []);
  assert.deepEqual(check("Merge branch 'web/page'"), []);
  assert.deepEqual(check('fixup! feat(web): add the page [G1]'), []);
});

test('cli.journeys-hooks-main.opt-in-rules-filler-words-emoji: opt-in rules: filler words, emoji, co-author trailers [C1]', () => {
  const strict = { ...RULES, banned: ['basically', 'seamless'], noEmoji: true, noCoAuthor: true };
  const problems = check('docs: basically seamless lanes \u{1F680}\n\nCo-Authored-By: Bot <b@x>', strict);
  assert.deepEqual(problems, ['drop the filler word "basically"', 'drop the filler word "seamless"', 'remove the emoji', 'remove the Co-Authored-By trailer']);
  assert.deepEqual(check('docs: basically fine'), []);
});

test('cli.journeys-hooks-main.blocked-paths-env-files-by-name: blocked paths: env files by name, examples allowed, patterns with a slash match paths [C5]', () => {
  const protect = { ...defaults().protect, blocked: [...defaults().protect.blocked, 'data/*.csv'] };
  assert.deepEqual(
    blockedPaths(['.env', 'app/.env.local', 'prod.env', '.env.example', 'data/claims.csv', 'docs/data/x.csv', 'src/a.js'], protect),
    ['.env', 'app/.env.local', 'prod.env', 'data/claims.csv'],
  );
  assert.ok(matchesPattern('*.env', 'deep/dir/staging.env'));
  assert.ok(!matchesPattern('.env.*', 'environment.js'));
});

test('cli.journeys-hooks-main.secrets-are-named-by-kind-and: secrets are named by kind and place, never echoed [C5]', () => {
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

test('cli.journeys-hooks-main.a-large-staged-binary-commits-without: a large staged binary commits without DIFF_TOO_LARGE [S1]', (t) => {
  const box = stagedRepo(t);
  const image = Buffer.alloc(9 * 1024 * 1024, 0x41);
  image.set([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]);
  writeFileSync(join(box.root, 'big.jpg'), image);
  box.git('add', '--', 'big.jpg');
  assert.deepEqual(stagedProblems(box.root), []);
});

test('cli.journeys-hooks-main.a-path-marked-diff-is-skipped: a path marked -diff is skipped by the secret scan as git itself skips it [S1]', (t) => {
  const box = stagedRepo(t);
  writeFileSync(join(box.root, '.gitattributes'), '*.dat -diff\n');
  writeFileSync(join(box.root, 'blob.dat'), `${'ordinary text\n'.repeat(700_000)}`);
  box.git('add', '--', '.gitattributes', 'blob.dat');
  assert.deepEqual(stagedProblems(box.root), []);
});

test('cli.journeys-hooks-main.a-staged-diff-beyond-the-safe: a staged diff beyond the safe output limit is a private coded refusal [P4]', (t) => {
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
