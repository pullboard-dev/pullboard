/**
 * CI runs the gate (C7): on every push to main and every pull request, with Node 22.13 and 24, on
 * Linux always and on macOS once the repository is public, since GitHub bills macOS minutes tenfold
 * on private repositories. The workflow is read as text: the suite has no YAML parser and needs none.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { runFixtureChild } from './fixture-child.js';

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW = readFileSync(resolve(ROOT, '.github/workflows/gate.yml'), 'utf8');
const RELEASE = readFileSync(resolve(ROOT, '.github/workflows/release.yml'), 'utf8');

/** Execute the workflow's actual decision code against a saved API response in a private folder. */
function releaseDecision(t, script, run) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-release-ci-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'outputs');
  writeFileSync(join(directory, 'release-gate.json'), JSON.stringify(run));
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], {
    cwd: directory, encoding: 'utf8',
    env: { ...process.env, RUNNER_TEMP: directory, GITHUB_OUTPUT: output, GITHUB_SHA: 'a'.repeat(40) },
  });
  return { ...result, approved: existsSync(output) ? readFileSync(output, 'utf8') : '' };
}

/** Require a real completed Linux matrix; other platforms do not replace its evidence. */
function assertReleaseDecisions(t, script) {
  const linux = ['22.13', '24'].flatMap(node => [1, 2, 3].map(shard => ({
    name: `linux (${node}) ${shard}/3`, status: 'completed', conclusion: 'success',
  })));
  const run = { databaseId: 123, url: 'https://github.com/example/project/actions/runs/123',
    headSha: 'a'.repeat(40), headBranch: 'main', event: 'push', jobs: [...linux,
      { name: 'macos (24) 1/2', status: 'in_progress', conclusion: '' }] };
  const green = releaseDecision(t, script, run);
  assert.equal(green.status, 0, green.context);
  assert.equal(green.approved, 'passed=true\n', 'passing Linux jobs permit the publish step while macOS still runs');
  for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out', '']) {
    const jobs = linux.map((job, index) => index ? job : { ...job,
      status: conclusion ? 'completed' : 'in_progress', conclusion });
    const red = releaseDecision(t, script, { ...run, jobs });
    assert.equal(red.status, 1, red.context);
    assert.equal(red.approved, '', `${conclusion || 'pending'} never authorizes publication`);
    assert.match(red.stderr, /gate\.yml run 123.*Linux jobs that did not succeed: linux \(22\.13\) 1\/3/u,
      'the refusal names the gate run and the exact failed or unfinished Linux job');
  }
  for (const change of [{ jobs: [] }, { headSha: 'b'.repeat(40) }, { headBranch: 'topic' }, { event: 'pull_request' }]) {
    const red = releaseDecision(t, script, { ...run, ...change });
    assert.equal(red.status, 1, red.context);
    assert.equal(red.approved, '', 'absent jobs or a different CI origin never authorize publication');
    assert.match(red.stderr, /gate\.yml run 123.*refusing npm publish/u);
  }
}

test('a tag publishes only a commit main CI passed [C7]', (t) => {
  assert.doesNotMatch(RELEASE, /npm\s+(?:run\s+gate|test)\b/u, 'a release reuses main CI instead of starting a different gate');
  assert.match(RELEASE, /\n  actions: read\n/u, 'the workflow can read the exact gate run');
  assert.match(RELEASE, /gh run list[^\n]*--workflow gate\.yml[^\n]*--branch main[^\n]*--event push[^\n]*--commit "\$GITHUB_SHA"/u,
    'the evidence comes from main push CI for the tagged commit');
  assert.match(RELEASE, /if \[ -z "\$run_id" \]; then\n[^\n]*No gate\.yml run[^\n]*\n\s+exit 1/u,
    'a missing run refuses publication explicitly');
  assert.match(RELEASE, /gh run view "\$run_id"[^\n]*--json [^\n]*headSha[^\n]*jobs/u,
    'the selected run supplies commit identity and individual job results');
  assert.match(RELEASE, /id: main-ci\n/u);
  assert.match(RELEASE, /- if: \$\{\{ steps\.main-ci\.outputs\.passed == 'true' \}\}\n\s+run: npm publish --provenance --access public/u,
    'publication requires the main-CI decision and retains trusted provenance publishing');
  assert.ok(RELEASE.indexOf('id: main-ci') < RELEASE.indexOf('run: npm publish'), 'CI evidence is checked before publishing');
  assert.ok(RELEASE.includes('test "v$(node -p "require(\'./package.json\').version")" = "$GITHUB_REF_NAME"'),
    'the tag must still match the package version');
  const match = RELEASE.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n {10}NODE/u);
  assert.ok(match, 'the workflow contains its executable CI decision');
  assertReleaseDecisions(t, match[1].replace(/^ {10}/gmu, ''));
});

/**
 * One job's text, from its name to the next job or the end.
 *
 * @param {string} name
 * @returns {string}
 */
function job(name) {
  const start = WORKFLOW.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `the workflow has a ${name} job`);
  const rest = WORKFLOW.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

test('CI runs the gate on every push and pull request, Node 22.13 and 24, on Linux and, once public, macOS [C7]', () => {
  assert.match(WORKFLOW, /\non:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n/, 'pushes to main and pull requests');
  for (const [name, system] of [['linux', 'ubuntu-latest'], ['macos', 'macos-latest']]) {
    const text = job(name);
    assert.ok(text.includes(`\n    runs-on: ${system}\n`), `${name} runs on ${system}`);
    assert.match(text, /\n {8}node: \['22\.13', '24'\]\n/, `${name} runs Node 22.13 and 24`);
    assert.match(text, /\n {10}node-version: \$\{\{ matrix\.node \}\}\n/, `${name} sets up the matrix's Node`);
    assert.match(text, /\n {10}fetch-depth: 0\n/, `${name} checks out full history, which spec check reads`);
    assert.match(text, /if: github\.event_name == 'push' \|\| github\.event_name == 'pull_request'\n\s+run: node bin\/check-signoffs\.js/u,
      `${name} includes sign-offs in the matrix gate that publication requires`);
    assert.equal([...text.matchAll(/\n {6}- run: node bin\/pullboard\.js spec check(?=\n)/gu)].length, 1,
      `${name} checks the spec exactly once in every matrix job`);
    assert.ok(text.includes('npm test -- --shard=${{ matrix.shard }}/${{ matrix.shards }}'),
      `${name} forwards its native shard to the test runner`);
  }
  assert.match(job('macos'), /\n {4}if: \$\{\{ !github\.event\.repository\.private \}\}\n/, 'macOS runs once the repository is public');
  assert.doesNotMatch(job('linux'), /\n {4}if:/, 'Linux runs every time');
});

test("the README header shows the board's own badges, not the CI status badge [C7]", () => {
  // Drop the gate badge from the header: a live red CI badge says less than the board's verified record.
  const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
  const section = readme.search(/^## /mu);
  assert.notEqual(section, -1, 'the README has a section after its header');
  const header = readme.slice(0, section);
  assert.doesNotMatch(header, /actions\/workflows\/gate\.yml/u, 'the header carries no CI status badge');
  for (const badge of ['pullboard', 'npm']) assert.match(header, new RegExp(`alt="${badge}(?:: [^"]+)?"`, 'u'), `the header shows the ${badge} badge`);
});
