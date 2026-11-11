/** @pullboard-test-input .github/workflows/cla.yml .github/workflows/gate.yml .github/workflows/release.yml packages/gate/src/io/check/cla.js */
/** @pullboard-test-input .github/workflows/gate.yml .github/workflows/cla.yml .github/workflows/stale.yml */
/** Check that main CI shards work without hiding failures or cancelling unrelated runs [C7]. */
import { copyPackageFiles } from '../../../../packages/runners/index.js';
import assert from 'node:assert/strict';
import {
  cpSync,
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
import { cellSandbox } from '../../../../packages/store/tests/fixtures/cell.js';
import {
  privateFixtureFiles,
  runFixtureChild,
} from '../../tests/fixtures/child.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const WORKFLOW = readFileSync(resolve(ROOT, '.github/workflows/gate.yml'), 'utf8');
const cleanups = [];
after(() => { for (const cleanup of cleanups.reverse()) cleanup(); });
/** The module-level owner of each sandbox's cleanup, for helpers that run outside a test context. */
const owner = { after: cleanup => cleanups.push(cleanup) };

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
  const specChecks = [...text.matchAll(/\n {6}- run: node apps\/cli\/pullboard\.js spec check(?=\n)/gu)];
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
  assert.doesNotMatch(WORKFLOW, /\n {2}macos:\n/u, 'registered Mac runners replace the hosted macOS job');
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

/** The DCO is dropped (Corey, 8 Nov; RFC 0009): no workflow runs a sign-off check or asks for Signed-off-by. */
test('no workflow requires a DCO sign-off [I1]', () => {
  assert.equal(workflowText(resolve(ROOT, '.github/workflows/dco.yml')), '', 'the DCO workflow is removed');
  for (const name of ['gate.yml', 'cla.yml', 'stale.yml']) {
    assert.doesNotMatch(workflowText(resolve(ROOT, '.github/workflows', name)), /check-signoffs|Signed-off-by/u, name + ' requires no sign-off');
  }
});

const workflow = readFileSync(new URL('../../../../.github/workflows/release.yml', import.meta.url), 'utf8');

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

const CLA_WORKFLOW = workflowText(resolve(ROOT, '.github/workflows/cla.yml'));
const CLA_SENTENCE = 'I have read CLA.md and I agree to it.';

/** Run packages/gate/src/io/check/cla.js against a fixture pull request and signatures file in a temp folder. */
function runCla(t, pr, signatures) {
  const fixture = privateFixtureFiles('cla-');
  const dir = fixture.root;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  fixture.write('pr.json', JSON.stringify(pr));
  fixture.write('signatures.json', JSON.stringify(signatures));
  return runFixtureChild(process.execPath, [resolve(ROOT, 'packages/gate/src/io/check/cla.js')], {
    encoding: 'utf8',
    env: { ...process.env, CLA_PR_FILE: join(dir, 'pr.json'), CLA_SIGNATURES_FILE: join(dir, 'signatures.json') },
  });
}

const claCommit = (login, parents = ['p']) => ({ sha: 'abcdef012345', login, parents });
const claComment = (login, body) => ({ login, body, id: 1, url: 'https://example.test/c/1', created_at: '2026-11-06T00:00:00Z' });
const claSigned = { exempt: ['maintainer'], signatures: [{ login: 'alice', id: 1, comment_url: 'u', agreed_at: 't', cla_sha256: 'h' }] };

test('clause 1: the CLA workflow runs on pull requests and PR comments with only checkout and setup-node [C7]', () => {
  assert.match(CLA_WORKFLOW, /^name: CLA\n/u);
  assert.match(CLA_WORKFLOW, /\n {2}pull_request:\n {4}types: \[opened, synchronize, reopened\]\n {2}issue_comment:\n {4}types: \[created\]\n/u);
  assert.match(CLA_WORKFLOW, /github\.event\.issue\.pull_request/u, 'comments on plain issues are skipped');
  const used = [...CLA_WORKFLOW.matchAll(/^\s*-\s+uses: ([^\s]+)/gmu)].map((m) => m[1].split('@')[0]);
  assert.deepEqual([...new Set(used)].sort(), ['actions/checkout', 'actions/setup-node']);
  assert.match(CLA_WORKFLOW, /node packages\/gate\/src\/io\/check\/cla\.js/u);
  assert.doesNotMatch(CLA_WORKFLOW, /pull_request_target/u);
  assert.deepEqual([...CLA_WORKFLOW.matchAll(/^ {2}([\w-]+): write$/gmu)].map((m) => m[1]), ['statuses'],
    'statuses is the only write permission');
  assert.doesNotMatch(CLA_WORKFLOW, /contents: write/u);
});

test('clause 2: check-cla passes for a listed signer [C7]', (t) => {
  const result = runCla(t, { commits: [claCommit('alice')], comments: [] }, claSigned);
  assert.equal(result.status, 0, result.stderr);
});

test('clause 2: check-cla passes for the exact comment and for exempt authors [C7]', (t) => {
  const result = runCla(t, { commits: [claCommit('bob'), claCommit('maintainer'), claCommit('bob', ['a', 'b'])],
    comments: [claComment('bob', `  ${CLA_SENTENCE}\n`)] }, claSigned);
  assert.equal(result.status, 0, result.stderr);
});

test('clause 2: check-cla fails naming the login for a near-miss comment [C7]', (t) => {
  const result = runCla(t, { commits: [claCommit('bob')], comments: [claComment('bob', 'I have read CLA.md and I agree to it')] }, claSigned);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bob/u);
  assert.ok(result.stderr.includes(CLA_SENTENCE), 'the failure quotes the exact sentence');
});

test('clause 2: check-cla fails naming the login for a comment by a different person [C7]', (t) => {
  const result = runCla(t, { commits: [claCommit('bob')], comments: [claComment('carol', CLA_SENTENCE)] }, claSigned);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bob/u);
});

test('clause 2: check-cla fails naming a second unsigned co-author and a commit with no login [C7]', (t) => {
  const result = runCla(t, { commits: [claCommit('bob'), claCommit('dave'), claCommit(null)],
    comments: [claComment('bob', CLA_SENTENCE)] }, claSigned);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dave/u);
  assert.doesNotMatch(result.stderr, /bob has not/u);
  assert.match(result.stderr, /no GitHub login/u);
});

test('clause 3: the workflow events and allowed actions, a listed signer and an exact comment pass, and a near-miss, another person and a second unsigned co-author fail with the login named [C7]', (t) => {
  assert.match(CLA_WORKFLOW, /\n {2}pull_request:\n {4}types: \[opened, synchronize, reopened\]\n {2}issue_comment:\n {4}types: \[created\]\n/u);
  const used = [...CLA_WORKFLOW.matchAll(/^\s*-\s+uses: ([^\s]+)/gmu)].map((m) => m[1].split('@')[0]);
  assert.deepEqual([...new Set(used)].sort(), ['actions/checkout', 'actions/setup-node']);
  // Every scenario reads its signatures from a fixture file, never the real .github/cla-signatures.json.
  assert.equal(runCla(t, { commits: [claCommit('alice')], comments: [] }, claSigned).status, 0, 'a listed signer passes');
  assert.equal(runCla(t, { commits: [claCommit('bob')], comments: [claComment('bob', CLA_SENTENCE)] }, claSigned).status, 0, 'the exact comment passes');
  const nearMiss = runCla(t, { commits: [claCommit('bob')], comments: [claComment('bob', `${CLA_SENTENCE} `.trim().replace('.', ''))] }, claSigned);
  assert.notEqual(nearMiss.status, 0);
  assert.match(nearMiss.stderr, /bob/u, 'a near-miss comment fails naming the login');
  const other = runCla(t, { commits: [claCommit('bob')], comments: [claComment('carol', CLA_SENTENCE)] }, claSigned);
  assert.notEqual(other.status, 0);
  assert.match(other.stderr, /bob/u, "another person's comment fails naming the author");
  const second = runCla(t, { commits: [claCommit('bob'), claCommit('dave')], comments: [claComment('bob', CLA_SENTENCE)] }, claSigned);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /dave/u, 'a second unsigned co-author fails naming the login');
});

test('a landing appends a signer entry with the CLA hash [C7]', async (t) => {
  const { appendSignatures } = await import('../../../../packages/gate/src/io/check/cla.js');
  const fixture = privateFixtureFiles('cla-land-');
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const file = join(fixture.root, 'cla-signatures.json');
  fixture.write('cla-signatures.json', JSON.stringify(claSigned));
  const claText = 'CLA text at base\n';
  appendSignatures(file, [{ login: 'bob', comment: { user_id: 7, url: 'https://example.test/c/1', created_at: '2026-11-06T00:00:00Z' } }], claText);
  const entries = JSON.parse(readFileSync(file, 'utf8')).signatures;
  assert.equal(entries.length, 2);
  assert.deepEqual(Object.keys(entries[1]), ['login', 'id', 'comment_url', 'agreed_at', 'cla_sha256']);
  assert.equal(entries[1].cla_sha256, (await import('node:crypto')).createHash('sha256').update(claText).digest('hex'));
});
