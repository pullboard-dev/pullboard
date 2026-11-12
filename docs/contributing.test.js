/** @pullboard-test-input CONTRIBUTING.md docs/contributing-runbook.md .github/pull_request_template.md .github/ISSUE_TEMPLATE/feature_request.md .github/ISSUE_TEMPLATE/bug_report.md .github/ISSUE_TEMPLATE/flaky.md .github/ISSUE_TEMPLATE/performance.md .github/ISSUE_TEMPLATE/config.yml packages/commits/src/logic/contribution.js CLA.md SECURITY.md CODE_OF_CONDUCT.md */
/** The approved contribution wording and the maintainers' complete safe intake path [I11]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseContributionRecord } from '../packages/commits/src/logic/contribution.js';

/** Read a public contribution document from the checked source tree. */
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('clause 1: CONTRIBUTING is the approved guide, asks for no sign-off, and the runbook names every step [I11]', () => {
  const contributing = read('CONTRIBUTING.md');
  assert.doesNotMatch(contributing, /sign-off|signoff|Signed-off-by|git commit -s/iu, 'the DCO is dropped (RFC 0009)');
  assert.equal(createHash('sha256').update(contributing).digest('hex'),
    '5cb38501a620e23a161270b8bee536e341f4118abefb9355122e013b38922e16',
    'CONTRIBUTING.md is the guide Corey approved on 8 Nov, byte for byte');
  for (const phrase of ['RFC 0009', 'CLA.md', 'Apache Individual CLA v2.2', 'you keep it', 'patents included', 'within 7 days']) {
    assert.ok(contributing.includes(phrase), phrase);
  }
  const runbook = read('docs/contributing-runbook.md');
  for (const phrase of [
    'When an issue arrives',
    'Reply when capacity allows: thank them, and say what happens next',
    'on our board as #N', 'a question first', 'not planned, because',
    'File it on the board, or map it onto an existing item or milestone', 'Link the board item in the reply',
    'When a pull request arrives',
    'there is no fixed response time',
    'Read the diff before running anything', 'changes outside the stated purpose', 'new dependencies (refuse them)',
    'sensitive paths (relay, sealing, signing, person moves, hooks, code that runs commands)',
    'network calls, file access outside the repo, obfuscation, big pasted blocks',
    'The check is the contributor\'s new test, which must fail on `main` and pass at their commit',
    'Record the PR number, the author and the exact commit',
    'a container or throwaway VM with no credentials, no access to the home folder and no network',
    'the full gate on the minimum Node version (22.13) plus the current version',
    'the browser tests when the change touches the view or relay',
    'outside code never runs on a machine holding credentials',
    'Sensitive paths need the owner\'s approval',
    'Confirm the [CLA](../CLA.md) before merge', 'as a comment on their pull request, the first time they contribute',
    'land through the merge train', 'Never use GitHub\'s merge button',
    'The contributor stays the commit author', 'Co-authored-by',
    'The PR shows as merged, or we close it with a link to the landed commit', 'Thank them, and link the receipt',
    'comment with the verifier\'s note in plain words', 'the item is verified again at the new commit',
    'Declining:** close with a clear, kind reason', 'Merging is always the project\'s call',
  ]) {
    assert.ok(runbook.includes(phrase), phrase);
  }
  assert.doesNotMatch(runbook, /reply within 3 days/iu);
  const template = read('.github/pull_request_template.md');
  assert.doesNotMatch(template, /sign.?off|Signed-off-by/iu, 'the PR template asks for no sign-off');
  assert.doesNotMatch(runbook, /sign-off|Signed-off-by/iu, 'the runbook asks for no sign-off');
  assert.match(template, /CLA/u);
  assert.match(template, /^refs:$/mu, 'the PR links same-repo issues through refs');
  const cla = read('CLA.md');
  assert.match(cla, /\bversion 2\.2\b/u);
  assert.equal(createHash('sha256').update(cla).digest('hex'),
    '866fe77a4eb04eb948c5f92494804136ecce3980bc3e6280d7e638f0791a691c',
    'the coordinator-approved 0124 CLA companion is copied without changing its terms');
  for (const phrase of ['Pullboard', 'Grant of Copyright License', 'Grant of Patent License',
    'You reserve all right', 'WITHOUT WARRANTIES']) assert.ok(cla.includes(phrase), phrase);
  assert.ok(!cla.includes('secretary@apache.org'), 'the Apache recipient is not presented as Pullboard contact');
  for (const path of ['SECURITY.md', 'CODE_OF_CONDUCT.md']) assert.ok(read(path).trim(), path);
});


test('the approved feature-request template routes new issues to feature [I1,C7]', () => {
  const template = read('.github/ISSUE_TEMPLATE/feature_request.md');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(template);
  assert.ok(frontmatter, 'the actual shipped template has bounded YAML frontmatter');
  const labels = [...frontmatter[1].matchAll(/^labels:\s*(.*?)\s*$/gmu)];
  assert.equal(labels.length, 1, 'the routing label is declared exactly once');
  const label = labels[0][1].replace(/^(["'])(.*)\1$/u, '$2');
  assert.equal(label, 'feature', '#1312 requires feature rather than the legacy enhancement label');
});

/** The yaml fences of a template, each with the text before it. */
function records(path) {
  const text = read(path);
  return [...text.matchAll(/(?:^|\n)([^\n][\s\S]*?)\n```yaml\n([\s\S]*?)```/gu)].map(m => ({ before: m[1], yaml: m[2] }));
}

test('clause 1: the issue templates are Bug, Ask, Flaky and Performance and Security links to private reporting [I11]', () => {
  const dir = '.github/ISSUE_TEMPLATE/';
  const shapes = { 'bug_report.md': 'Bug', 'feature_request.md': 'Ask', 'flaky.md': 'Flaky', 'performance.md': 'Performance' };
  for (const [file, shape] of Object.entries(shapes)) {
    const text = read(dir + file);
    assert.match(text, new RegExp('^name: ' + shape + '$', 'mu'), file + ' is the ' + shape + ' template');
    const found = records(dir + file);
    assert.equal(found.length, 1, file + ' shows one record');
    const summary = found[0].before.replace(/^---[\s\S]*?\n---\n+/u, '').trim();
    assert.ok(summary.length > 0 && !summary.includes('```'), file + ' shows the summary before the YAML');
    const parsed = parseContributionRecord(found[0].yaml, shape);
    assert.equal(parsed.shape, shape);
  }
  const config = read(dir + 'config.yml');
  assert.match(config, /name: Security/u);
  assert.match(config, /security\/advisories\/new/u, 'Security links to private reporting');
  assert.match(config, /blank_issues_enabled: false/u);
});

test('clause 2: the PR template shows Fix and Proposal as records that parse, and names the CLA on pullboard.dev [I11]', () => {
  const found = records('.github/pull_request_template.md');
  assert.equal(found.length, 2, 'Fix and Proposal');
  assert.match(found[0].before, /## Fix/u);
  assert.match(found[1].before, /## Proposal/u);
  assert.equal(parseContributionRecord(found[0].yaml, 'Fix').shape, 'Fix');
  assert.equal(parseContributionRecord(found[1].yaml, 'Proposal').shape, 'Proposal');
  const template = read('.github/pull_request_template.md');
  assert.ok(template.includes('Sign the CLA once on your pullboard.dev contributor profile.'));
  assert.ok(template.includes('2-3 sentences, then YAML'));
  assert.doesNotMatch(template, /I have read CLA\.md|CLA bot|one-click/iu, 'no comment sentence, no bot');
});
