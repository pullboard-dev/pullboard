/** @pullboard-test-input CONTRIBUTING.md docs/contributing-runbook.md .github/pull_request_template.md .github/ISSUE_TEMPLATE/feature_request.md CLA.md SECURITY.md CODE_OF_CONDUCT.md */
/** The approved contribution wording and the maintainers' complete safe intake path [I11]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

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
  assert.match(template, /(?:linked.issue|fixes #)/iu);
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

test('clause 2: the contributor docs tell people to post the agreement sentence and name no CLA bot [I11]', () => {
  const sentence = 'I have read CLA.md and I agree to it.';
  for (const path of ['.github/pull_request_template.md', 'docs/contributing-runbook.md']) {
    const text = read(path);
    assert.ok(text.includes(sentence), path + ' quotes the sentence');
    assert.ok(/comment on (?:your|their) pull request/u.test(text), path + ' says to comment on the pull request');
    assert.doesNotMatch(text, /CLA bot|one-click/iu, path + ' no longer mentions a CLA bot');
  }
});
