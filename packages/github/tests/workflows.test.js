/** @pullboard-test-input .github/workflows/stale.yml .github/workflows/reopen-clarify.yml .github/workflows/contribution-gate.yml .github/workflows/contribution-post.yml */
/** Clarification issues close only after inactivity and reopen only for their author [I1]. */
/** @pullboard-world-pin: the clauses read the repository workflow files, which are the subject of these rules. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const staleWorkflow = readFileSync(new URL('../../../.github/workflows/stale.yml', import.meta.url), 'utf8');
const reopenWorkflow = readFileSync(new URL('../../../.github/workflows/reopen-clarify.yml', import.meta.url), 'utf8');
const gateWorkflow = readFileSync(new URL('../../../.github/workflows/contribution-gate.yml', import.meta.url), 'utf8');
const postWorkflow = readFileSync(new URL('../../../.github/workflows/contribution-post.yml', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const scriptOffset = reopenWorkflow.indexOf('          script: |\n');
assert.notEqual(scriptOffset, -1, 'the author-reopen workflow has an executable script');
const scriptLines = reopenWorkflow.slice(scriptOffset + '          script: |\n'.length).split('\n');
const scriptEnd = scriptLines.findIndex(line => line.trim() && !line.startsWith('            '));
const scriptBlock = scriptLines.slice(0, scriptEnd < 0 ? scriptLines.length : scriptEnd);
assert.ok(scriptBlock.length, 'the author-reopen workflow script is nonempty');
const reopenScript = scriptBlock.map(line => line.replace(/^            /u, '')).join('\n');
const runReopenScript = new AsyncFunction('github', 'context', reopenScript);

test('github.workflows.stale-closes-inactive-only: the stale workflow closes only inactive clarify issues and never modifies PRs [I1]', () => {
  assert.match(staleWorkflow, /schedule:\n\s+- cron: '[0-9* ,/-]+'/u);
  assert.match(staleWorkflow, /uses: actions\/github-script@v7\.0\.1\n/u, 'the script action is version-pinned');
  assert.match(staleWorkflow, /labels: 'clarify'/u);
  assert.match(staleWorkflow, /14 \* 24 \* 60 \* 60 \* 1000/u);
  assert.match(staleWorkflow, /body: 'Closed\. No response\. Reply to reopen\.'/u);
  assert.match(staleWorkflow, /state_reason: 'completed'/u, 'a quiet issue closes as completed, never not planned');
  assert.match(staleWorkflow, /issue\.pull_request/u, 'pull requests are skipped');
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
    async get(input) { calls.push(['get', input]); return { data: { number: 12, state: 'closed', user: { id: 7 }, labels: [{ name: 'clarify' }, { name: 'bug' }], ...currentIssue } }; },
    async update(input) { calls.push(['update', input]); },
  } } };
  return { context, github, calls };
}

test('github.workflows.author-reopens: only the issue author reopens a closed clarify issue and clears its label [I1]', async () => {
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

test('github.workflows.non-author-no-change: non-authors, pull requests, reopened issues, and missing clarify labels do not change state [I1]', async () => {
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

test('github.workflows.stale-fourteen-days: the stale script closes an issue quiet for fourteen days and leaves active issues and PRs alone [I1]', async () => {
  const lines = staleWorkflow.slice(staleWorkflow.indexOf('          script: |\n') + '          script: |\n'.length).split('\n');
  const end = lines.findIndex(line => line.trim() && !line.startsWith('            '));
  const script = lines.slice(0, end < 0 ? lines.length : end).map(line => line.replace(/^            /u, '')).join('\n');
  const day = 86400000, now = Date.now();
  const issues = [
    { number: 1, updated_at: new Date(now - 15 * day).toISOString() },
    { number: 2, updated_at: new Date(now - 13 * day).toISOString() },
    { number: 3, updated_at: new Date(now - 30 * day).toISOString(), pull_request: {} },
  ];
  const calls = [];
  const github = { paginate: async () => issues, rest: { issues: {
    listForRepo: 'list',
    createComment: async arg => { calls.push(['comment', arg.issue_number, arg.body]); },
    update: async arg => { calls.push(['update', arg.issue_number, arg.state, arg.state_reason]); },
  } } };
  await new AsyncFunction('github', 'context', script)(github, { repo: { owner: 'o', repo: 'r' } });
  assert.deepEqual(calls, [['comment', 1, 'Closed. No response. Reply to reopen.'], ['update', 1, 'closed', 'completed']]);
});

test('github.workflows.contribution-gate-trusted-base: the contribution gate runs on pull requests from the base tree with read-only permission and no secrets [I1]', () => {
  assert.match(gateWorkflow, /on:\n  pull_request:\n/u);
  assert.doesNotMatch(gateWorkflow, /pull_request_target/u);
  assert.match(gateWorkflow, /name: Lands through Pullboard\n/u);
  assert.match(gateWorkflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}\n/u, 'the base sha is checked out');
  assert.doesNotMatch(gateWorkflow, /pull_request\.head/u, 'the PR head is never checked out');
  assert.match(gateWorkflow, /persist-credentials: false\n/u);
  assert.match(gateWorkflow, /working-directory: trusted-gate\n\s+run: node apps\/cli\/pullboard\.js gate --static\n/u);
  assert.match(gateWorkflow, /permissions:\n  contents: read\n/u);
  assert.doesNotMatch(gateWorkflow, /: write\b/u);
  assert.doesNotMatch(gateWorkflow, /secrets\./u);
});

test('github.workflows.contribution-post-trusted-quotes: the post workflow runs after the gate with one write permission, runs no pull request code and quotes only sanitized values [I1]', () => {
  assert.match(postWorkflow, /on:\n  workflow_run:\n    workflows: \["Contribution gate"\]\n    types: \[completed\]\n/u, 'it runs on workflow_run of the gate');
  assert.doesNotMatch(postWorkflow, /pull_request_target|pull_request:/u);
  assert.match(postWorkflow, /permissions:\n  pull-requests: write\n/u);
  assert.equal([...postWorkflow.matchAll(/: write\b/gu)].length, 1, 'pull-requests write is the only write permission');
  assert.doesNotMatch(postWorkflow, /actions\/checkout|head_sha|head_branch|pull_request\.head/u, 'no pull request code is checked out or run');
  assert.doesNotMatch(postWorkflow, /secrets\./u);
  const scriptAt = postWorkflow.indexOf('script: |');
  assert.notEqual(scriptAt, -1);
  assert.doesNotMatch(postWorkflow.slice(scriptAt), /\$\{\{/u, 'no expression is spliced into the script');
  assert.match(postWorkflow, /const sanitize = /u, 'the sanitizing step is present');
  assert.match(postWorkflow, /\[link removed\]/u);
  assert.match(postWorkflow, /> result: \$\{conclusion\}/u, 'the body quotes only sanitized values');
});
