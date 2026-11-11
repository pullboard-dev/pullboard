/** @pullboard-test-input .github/workflows/stale.yml .github/workflows/reopen-clarify.yml */
/** Clarification issues close only after inactivity and reopen only for their author [I1]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertClarificationQuietPeriod } from './fixtures/stale.js';

const staleWorkflow = readFileSync(new URL('../../../.github/workflows/stale.yml', import.meta.url), 'utf8');
const reopenWorkflow = readFileSync(new URL('../../../.github/workflows/reopen-clarify.yml', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const scriptOffset = reopenWorkflow.indexOf('          script: |\n');
assert.notEqual(scriptOffset, -1, 'the author-reopen workflow has an executable script');
const scriptLines = reopenWorkflow.slice(scriptOffset + '          script: |\n'.length).split('\n');
const scriptEnd = scriptLines.findIndex(line => line.trim() && !line.startsWith('            '));
const scriptBlock = scriptLines.slice(0, scriptEnd < 0 ? scriptLines.length : scriptEnd);
assert.ok(scriptBlock.length, 'the author-reopen workflow script is nonempty');
const reopenScript = scriptBlock.map(line => line.replace(/^            /u, '')).join('\n');
const runReopenScript = new AsyncFunction('github', 'context', reopenScript);

test('the stale workflow closes only inactive clarify issues and never modifies PRs [I1]', () => {
  assert.match(staleWorkflow, /schedule:\n\s+- cron: '[0-9* ,/-]+'/u);
  assert.match(staleWorkflow, /uses: actions\/stale@v11\.0\.0\n/u, 'the stale action is version-pinned');
  assert.match(staleWorkflow, /only-issue-labels: clarify\n/u);
  assert.match(staleWorkflow, /stale-issue-label: clarify-inactive\n/u);
  assert.match(staleWorkflow, /days-before-issue-stale: 14\n\s+days-before-issue-close: 0\n/u);
  assert.match(staleWorkflow, /remove-issue-stale-when-updated: true\n/u, 'activity clears only the separate inactivity marker; clarify remains eligible');
  assert.match(staleWorkflow, /close-issue-message: "Closed\. No response\. Reply to reopen\."\n/u);
  assert.match(staleWorkflow, /close-issue-reason: completed\n/u, 'a quiet issue closes as completed, never not planned');
  assert.match(staleWorkflow, /days-before-pr-stale: -1\n\s+days-before-pr-close: -1\n\s+remove-pr-stale-when-updated: false\n/u);
  assert.match(staleWorkflow, /pull-requests: read\n/u);
  assert.doesNotMatch(staleWorkflow, /pull-requests: write\n/u);
});

/** Run the workflow's embedded script against a mutable issue response and count REST writes. */
function reopenFixture({ payloadIssue = {}, commentId = 7, currentIssue = {} } = {}) {
  const calls = [];
  const context = {
    repo: { owner: 'pullboard-dev', repo: 'pullboard' },
    payload: { issue: { number: 12, state: 'closed', user: { id: 7 }, labels: [{ name: 'clarify' }], ...payloadIssue }, comment: { user: { id: commentId } } },
  };
  const github = { rest: { issues: {
    async get(input) { calls.push(['get', input]); return { data: { number: 12, state: 'closed', user: { id: 7 }, labels: [{ name: 'clarify' }, { name: 'clarify-inactive' }, { name: 'bug' }], ...currentIssue } }; },
    async update(input) { calls.push(['update', input]); },
  } } };
  return { context, github, calls };
}

test('only the issue author reopens a closed clarify issue and clears its label [I1]', async () => {
  assert.match(reopenWorkflow, /issue_comment:\n\s+types: \[created\]/u);
  assert.match(reopenWorkflow, /github\.event\.issue\.pull_request == null/u);
  assert.match(reopenWorkflow, /github\.event\.issue\.state == 'closed'/u);
  assert.match(reopenWorkflow, /contains\(github\.event\.issue\.labels\.\*\.name, 'clarify'\)/u);
  assert.match(reopenWorkflow, /github\.event\.comment\.user\.id == github\.event\.issue\.user\.id/u);
  assert.match(reopenWorkflow, /actions\/github-script@v9\.0\.0/u);
  assert.match(reopenWorkflow, /github\.rest\.issues\.get/u);
  assert.match(reopenWorkflow, /github\.rest\.issues\.update/u);
  assert.match(reopenScript, /await github\.rest\.issues\.get/u);
  assert.match(reopenScript, /await github\.rest\.issues\.update/u);

  const author = reopenFixture();
  await runReopenScript(author.github, author.context);
  assert.deepEqual(author.calls, [
    ['get', { owner: 'pullboard-dev', repo: 'pullboard', issue_number: 12 }],
    ['update', { owner: 'pullboard-dev', repo: 'pullboard', issue_number: 12, state: 'open', labels: ['bug'] }],
  ]);
});

test('non-authors, pull requests, reopened issues, and missing clarify labels do not change state [I1]', async () => {
  const nonAuthor = reopenFixture({ commentId: 8 });
  await runReopenScript(nonAuthor.github, nonAuthor.context);
  assert.deepEqual(nonAuthor.calls, []);

  const pullRequest = reopenFixture({ payloadIssue: { pull_request: { url: 'https://example.invalid/pull/12' } } });
  await runReopenScript(pullRequest.github, pullRequest.context);
  assert.deepEqual(pullRequest.calls, []);

  const notClosedAtEvent = reopenFixture({ payloadIssue: { state: 'open' } });
  await runReopenScript(notClosedAtEvent.github, notClosedAtEvent.context);
  assert.deepEqual(notClosedAtEvent.calls, []);

  const notClarifyAtEvent = reopenFixture({ payloadIssue: { labels: [{ name: 'bug' }] } });
  await runReopenScript(notClarifyAtEvent.github, notClarifyAtEvent.context);
  assert.deepEqual(notClarifyAtEvent.calls, []);

  const opened = reopenFixture({ currentIssue: { state: 'open' } });
  await runReopenScript(opened.github, opened.context);
  assert.deepEqual(opened.calls, [['get', { owner: 'pullboard-dev', repo: 'pullboard', issue_number: 12 }]]);

  const unlabeled = reopenFixture({ currentIssue: { labels: [{ name: 'bug' }] } });
  await runReopenScript(unlabeled.github, unlabeled.context);
  assert.deepEqual(unlabeled.calls, [['get', { owner: 'pullboard-dev', repo: 'pullboard', issue_number: 12 }]]);

  const changedAuthor = reopenFixture({ currentIssue: { user: { id: 8 } } });
  await runReopenScript(changedAuthor.github, changedAuthor.context);
  assert.deepEqual(changedAuthor.calls, [['get', { owner: 'pullboard-dev', repo: 'pullboard', issue_number: 12 }]]);
});

test('the pinned stale processor closes after fourteen quiet days since a day-ten comment [I1]', async t => {
  const result = await assertClarificationQuietPeriod(staleWorkflow);
  assert.equal(result.before.observations.at(-1).state, 'open', 'the former config reproduces the permanent-comment bug');
  assert.deepEqual(result.after.observations.map(({ day, state }) => ({ day, state })), [
    { day: 20, state: 'open' }, { day: 24, state: 'closed' },
  ]);
  t.diagnostic(result.scope);
});
