/** @pullboard-test-input source-tree */
/** @pullboard-test-input .github/workflows/gate.yml .github/workflows/dco.yml */
/** Check that main CI shards work without hiding failures or cancelling unrelated runs [C7]. */
import { copyPackageFiles } from '../src/package-files.js';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChild } from './fixture-child.js';

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW = readFileSync(resolve(ROOT, '.github/workflows/gate.yml'), 'utf8');
const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Return the named workflow job's block so assertions apply to each job independently. */
function job(name) {
  const start = WORKFLOW.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `the workflow has a ${name} job`);
  const rest = WORKFLOW.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/u);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** Check that one runner job builds every shard for both supported Node versions. */
function checkRunner(name, system, shardList, total) {
  const text = job(name);
  assert.ok(text.includes(`\n    runs-on: ${system}\n`), `${name} uses ${system}`);
  assert.match(text, /\n {8}node: \['22\.13', '24'\]\n/u, `${name} covers both Node versions`);
  assert.ok(text.includes(`\n        shard: [${shardList}]\n`), `${name} declares shards ${shardList}`);
  assert.ok(text.includes(`\n        shards: [${total}]\n`), `${name} declares the shard count`);
  assert.ok(text.includes(`\n    name: ${name} (\${{ matrix.node }}) \${{ matrix.shard }}/\${{ matrix.shards }}\n`),
    `${name} job names show OS, Node and shard`);
  const specChecks = [...text.matchAll(/\n {6}- run: node bin\/pullboard\.js spec check(?=\n)/gu)];
  assert.equal(specChecks.length, 1, `${name} runs spec check exactly once in every matrix job`);
  assert.ok(text.includes('npm test -- --shard=${{ matrix.shard }}/${{ matrix.shards }}'),
    `${name} passes the native shard to the test runner`);
  assert.match(text, /\n {6}- uses: actions\/checkout@v4\n {8}with:\n {10}fetch-depth: 0\n/u,
    `${name} retains full history for spec check`);
  assert.match(text, /\n {4}strategy:\n {6}fail-fast: false\n/u, `${name} lets every shard report failures`);
}

/** Verify shard coverage, per-job checks, names, and cancellation scope from the checked-in workflow. */
function workflowShardsAndCancellation() {
  assert.match(WORKFLOW, /\non:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n {2}workflow_dispatch:\n/u,
    'the gate still runs for main pushes, pull requests and manual runs');
  checkRunner('linux', 'ubuntu-latest', '1, 2, 3', 3);
  checkRunner('macos', 'macos-latest', '1, 2', 2);
  assert.match(job('macos'), /\n {4}if: \$\{\{ !github\.event\.repository\.private \}\}\n/u,
    'macOS runs when the repository is public');
  assert.match(WORKFLOW,
    /\nconcurrency:\n {2}group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && github\.ref \|\| github\.run_id \}\}\n/u,
    'main pushes share their ref group while PR and manual runs get unique groups');
  assert.match(WORKFLOW,
    /\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' \}\}\n/u,
    'only a push to main cancels an in-progress run');
}

test('the gate workflow shards and cancels superseded main runs [C7]', workflowShardsAndCancellation);

/** Read an optional workflow so the test reports its absence as a workflow assertion. */
function workflowText(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** Check that the independently named DCO check runs for every pull request. */
function contributorWorkflows() {
  const dco = workflowText(resolve(ROOT, '.github/workflows/dco.yml'));
  assert.match(dco, /^name: DCO\n/u, 'the DCO check has a stable required-check name');
  assert.match(dco, /\n {2}pull_request:\n/u, 'the DCO workflow runs on pull requests');
  assert.match(dco, /\n  dco:\n {4}name: DCO\n/u, 'the pull-request check is named DCO');
  assert.match(dco, /\n {10}fetch-depth: 0\n/u, 'the checker receives the full pull-request history');
  assert.equal([...dco.matchAll(/uses: actions\/checkout@v4/gu)].length, 2,
    'contribution history and trusted implementation use separate checkouts');
  assert.match(dco, /path: contribution\n {10}persist-credentials: false\n/u);
  assert.match(dco, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.before != '0{40}' && github\.event\.before \|\| github\.sha \}\}\n {10}path: trusted-dco\n {10}persist-credentials: false\n/u,
    'PRs use the exact base SHA, pushes use before, and only an initial push falls back to HEAD');
  assert.match(dco, /working-directory: contribution\n {8}run: node "\$GITHUB_WORKSPACE\/trusted-dco\/bin\/check-signoffs\.js"\n/u,
    'the trusted entry point checks history from the contribution working directory');
  assert.match(dco, /permissions:\n {2}contents: read\n/u);
  assert.doesNotMatch(dco, /pull_request_target/u, 'PR work never gains a privileged event context');
}

test('the named DCO check runs for pull requests [I1]', contributorWorkflows);

test('a pull request with an unsigned commit fails DCO and a signed replacement passes [I1]', (t) => {
  const box = e2e.sandbox();
  const repo = join(box.dir, 'dco-workflow');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  box.env.GIT_AUTHOR_NAME = 'Maintainer';
  box.env.GIT_AUTHOR_EMAIL = 'maintainer@example.test';
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ maintainers: ['maintainer@example.test'] }));
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: add trusted contribution policy');
  const base = box.git(repo, 'rev-parse', 'HEAD').trim();

  box.env.GIT_AUTHOR_NAME = 'Outside Contributor';
  box.env.GIT_AUTHOR_EMAIL = 'outside@example.test';
  writeFileSync(join(repo, 'README.md'), 'An unsigned contribution.\n');
  box.git(repo, 'add', 'README.md');
  box.git(repo, 'commit', '-q', '-m', 'feat: add an unsigned contribution');
  const unsigned = box.git(repo, 'rev-parse', 'HEAD').trim();
  const event = join(box.dir, 'pull-request.json');
  /** Run the public CI entry point against a real pull-request event and Git history. */
  function check() {
    writeFileSync(event, JSON.stringify({ pull_request: {
      base: { sha: base }, head: { sha: box.git(repo, 'rev-parse', 'HEAD').trim() },
    } }));
    return runFixtureChild(process.execPath, [resolve(ROOT, 'bin/check-signoffs.js')], {
      cwd: repo, encoding: 'utf8',
      env: { ...box.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event },
    });
  }
  const rejected = check();
  assert.equal(rejected.status, 1, rejected.failure || rejected.stderr);
  assert.ok(rejected.stderr.includes(unsigned.slice(0, 12)), 'the failure names the unsigned commit');

  box.git(repo, 'reset', '--soft', base);
  box.git(repo, 'commit', '-q', '-m', 'feat: sign the contribution',
    '-m', 'Signed-off-by: Outside Contributor <outside@example.test>');
  const accepted = check();
  assert.equal(accepted.status, 0, accepted.failure || accepted.stderr);
});

/** Execute the checked-in DCO command with the checkout layout it actually declares. */
function dcoWorkflowFixture(box) {
  const text = workflowText(resolve(ROOT, '.github/workflows/dco.yml'));
  const steps = [...text.matchAll(/ {6}- uses: actions\/checkout@v4\n([\s\S]*?)(?= {6}- |$)/gu)];
  assert.ok(steps.length, 'DCO checks out contribution history');
  const checkoutPath = step => step[1].match(/ {10}path: ([^\n]+)\n/u)?.[1] ?? '.';
  const workspace = join(box.dir, 'dco-tamper-workspace');
  const repo = join(workspace, checkoutPath(steps[0]));
  mkdirSync(repo, { recursive: true });
  copyPackageFiles(ROOT, repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ maintainers: ['maintainer@example.test'] }));
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: establish trusted DCO implementation');
  const base = box.git(repo, 'rev-parse', 'HEAD').trim();
  for (const step of steps.slice(1)) {
    const trusted = join(workspace, checkoutPath(step));
    box.git(workspace, 'clone', '-q', '--no-hardlinks', repo, trusted);
    box.git(trusted, 'checkout', '-q', '--detach', base);
  }
  const command = text.match(/ {8}run: ([^\n]+)\n/u)?.[1];
  assert.ok(command, 'execute the actual workflow command');
  const cwd = join(workspace, text.match(/ {8}working-directory: ([^\n]+)\n/u)?.[1] ?? '.');
  const event = join(box.dir, 'dco-tamper-event.json');
  /** Model structured GitHub PR and push events while executing the real shell entry point. */
  function check(eventName) {
    const head = box.git(repo, 'rev-parse', 'HEAD').trim();
    writeFileSync(event, JSON.stringify(eventName === 'pull_request'
      ? { pull_request: { base: { sha: base }, head: { sha: head } } }
      : { before: base, after: head }));
    return runFixtureChild('/bin/sh', ['-eu', '-c', command], {
      cwd, encoding: 'utf8', env: { ...box.env, GITHUB_WORKSPACE: workspace,
        GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: event },
    });
  }
  return { repo, base, check };
}

test('DCO rejects unsigned PR and push commits even when the contribution replaces its checker [I1]', () => {
  const box = e2e.sandbox();
  box.env.GIT_AUTHOR_NAME = 'Maintainer';
  box.env.GIT_AUTHOR_EMAIL = 'maintainer@example.test';
  const { repo, base, check } = dcoWorkflowFixture(box);
  const originalChecker = readFileSync(join(repo, 'bin/check-signoffs.js'), 'utf8');
  box.env.GIT_AUTHOR_NAME = 'Outside Contributor';
  box.env.GIT_AUTHOR_EMAIL = 'outside@example.test';
  for (const change of ['entry point', 'imported policy module']) {
    box.git(repo, 'reset', '--hard', base);
    writeFileSync(join(repo, 'bin/check-signoffs.js'), change === 'entry point'
      ? "process.stdout.write('replacement checker says success\\n');\n" : originalChecker);
    writeFileSync(join(repo, 'src/commit-signoff.js'),
      'export function contributionSignoffProblem() { return { checked: 1 }; }\n');
    writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ maintainers: ['outside@example.test'] }));
    box.git(repo, 'add', 'bin/check-signoffs.js', 'src/commit-signoff.js', 'pullboard.json');
    box.git(repo, 'commit', '-q', '-m', 'test: replace ' + change);
    const unsigned = box.git(repo, 'rev-parse', 'HEAD').trim();
    for (const eventName of ['pull_request', 'push']) {
      const rejected = check(eventName);
      assert.equal(rejected.status, 1, eventName + ' must reject unsigned ' + change + ': ' + rejected.stdout);
      assert.ok(rejected.stderr.includes(unsigned.slice(0, 12)), 'the trusted checker names the unsigned commit');
    }
    box.git(repo, 'reset', '--soft', base);
    box.git(repo, 'commit', '-q', '-m', 'test: sign replacement ' + change,
      '-m', 'Signed-off-by: Outside Contributor <outside@example.test>');
    for (const eventName of ['pull_request', 'push']) {
      const accepted = check(eventName);
      assert.equal(accepted.status, 0, accepted.failure || accepted.stderr);
      assert.match(accepted.stdout, /Contributor sign-offs checked: 1 non-merge commits/u);
    }
  }
});

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

/** Execute the actual workflow extraction against private input; no GitHub or npm command runs. */
function extract(t, script, changelog, tag = 'v1.2.3') {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-release-notes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'CHANGELOG.md'), changelog);
  const notes = join(root, 'release-notes.md');
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, GITHUB_REF_NAME: tag, RUNNER_TEMP: root },
  });
  return { ...result, notes: existsSync(notes) ? readFileSync(notes, 'utf8') : null };
}

test('the release workflow publishes exactly the tagged changelog section [O3]', t => {
  const match = workflow.match(/node --input-type=module <<'NOTES'\n([\s\S]*?)\n {10}NOTES/u);
  assert.ok(match, 'the workflow extracts its notes from CHANGELOG before publishing');
  const script = match[1].replace(/^ {10}/gmu, '');
  const body = '\n### Added\n\n- Preserve **Markdown**, Unicode café, and trailing spaces.  \n\n';
  const changelog = '# Changelog\n\n## [Unreleased]\n\nNot this future version.\n\n## [1.2.3] - 2026-10-26\n' + body
    + '## [1.2.2] - 2026-10-25\n\nNot this older version.\n';
  const selected = extract(t, script, changelog);
  assert.equal(selected.status, 0, selected.stderr);
  assert.equal(selected.notes, body, 'only the selected section body is copied byte for byte');
  const last = extract(t, script, '# Changelog\n\n## [1.2.3]\n' + body);
  assert.equal(last.status, 0, last.stderr);
  assert.equal(last.notes, body, 'the final section does not need a following release heading');
  for (const invalid of [changelog.replace('[1.2.3]', '[1.2.30]'), changelog + '\n## [1.2.3]\nDuplicate\n',
    '# Changelog\n\n## [1.2.3]\n\n## [1.2.2]\nOlder\n']) {
    const refused = extract(t, script, invalid);
    assert.notEqual(refused.status, 0, 'missing, duplicate, or empty notes refuse before publication');
    assert.equal(refused.notes, null, 'a refusal never writes a notes file');
  }
  assert.match(workflow, /gh release create "\$GITHUB_REF_NAME"[^\n]*--verify-tag[^\n]*--notes-file "\$RUNNER_TEMP\/release-notes\.md"/u);
  assert.doesNotMatch(workflow, /--generate-notes|--notes-from-tag/u, 'generated or tag-message notes never replace the changelog');
  assert.ok(workflow.indexOf("<<'NOTES'") < workflow.indexOf('run: npm publish'), 'missing notes stop before npm publishing');
  assert.ok(workflow.indexOf('run: npm publish') < workflow.indexOf('gh release create'), 'the GitHub release follows successful package publication');
  assert.match(workflow, /publish:\n\s+permissions:\n\s+contents: write/u, 'only the publishing job gains release-write authority');
});
