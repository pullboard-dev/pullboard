/** @pullboard-test-input packages/gate/tests/fixtures/actions-stale-v11/* */
/** Execute the pinned upstream processor with isolated REST/clock adapters, never GitHub. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const manifest = JSON.parse(readFileSync(new URL('../../../gate/tests/fixtures/actions-stale-v11/manifest.json', import.meta.url), 'utf8'));
const DAY = 86400000, epoch = Date.parse('2026-01-01T00:00:00Z');
let now = epoch;
/** Preserve real Date parsing while injecting a deterministic wall clock. */
class ClockDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
/** Logging and quota accounting are outside this activity-policy contract. */
class Logger {
  info() {} warning() {} error() {}
  createOptionLink(value) { return value; }
}
class Operations {
  consumeOperation() {} getConsumedOperationsCount() { return 0; }
}
const context = vm.createContext({ Date: ClockDate, console,
  Logger, IssueLogger: Logger, Operations, StaleOperations: Operations, retry: undefined,
  LoggerService: new Proxy({}, { get: () => value => value }),
  Option: new Proxy({}, { get: (_, key) => key }),
  context: { repo: { owner: 'fixture', repo: 'fixture' } },
  core: { setFailed(error) { throw error; } },
  deburr: value => { assert.match(value, /^[\x00-\x7f]*$/u); return value; },
  getHumanizedDate: date => date.toISOString(),
  isValidDate: date => Number.isFinite(date.getTime()),
});
/** Only erase TypeScript/import/export syntax; retain complete upstream method bodies. */
function load(file, name) {
  const entry = manifest.sources.find(entry => entry.source === file);
  assert.ok(entry, 'only a pinned upstream source is evaluated');
  const bytes = readFileSync(new URL('../../../gate/tests/fixtures/actions-stale-v11/' + entry.file, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, 'the exact pinned upstream bytes are intact');
  const source = bytes.toString('utf8');
  const plain = stripTypeScriptTypes(source).replace(/^import .*;\r?\n/gmu, '').replace(/^export /gmu, '');
  vm.runInContext(plain + (name ? `\nglobalThis.${name} = ${name};` : ''), context, { filename: file });
}
for (const file of ['is-boolean', 'clean-label', 'words-to-list', 'is-labeled', 'is-pull-request', 'should-mark-when-stale']) {
  load('src/functions/' + file + '.ts');
}
load('src/functions/dates/is-date-more-recent-than.ts');
for (const [file, name] of [['ignore-updates', 'IgnoreUpdates'], ['assignees', 'Assignees'],
  ['milestones', 'Milestones'], ['exempt-draft-pull-request', 'ExemptDraftPullRequest'], ['issue', 'Issue']]) {
  load('src/classes/' + file + '.ts', name);
}
load('issues-processor-v11.ts', 'IssuesProcessor');

/** Read the exact workflow's scalar action inputs; this is not a YAML general-purpose parser. */
function inputs(text) {
  const values = Object.fromEntries([...text.matchAll(/^          ([a-z-]+): (.+)$/gmu)].map(([, key, value]) => [key, value.replace(/^"|"$/gu, '')]));
  return { daysBeforeStale: 60, daysBeforeClose: 7, onlyLabels: '', onlyPrLabels: '', onlyIssueLabels: values['only-issue-labels'],
    anyOfLabels: '', anyOfIssueLabels: '', anyOfPrLabels: '', exemptIssueLabels: '', exemptPrLabels: '',
    staleIssueLabel: values['stale-issue-label'], stalePrLabel: 'Stale', staleIssueMessage: '', stalePrMessage: '',
    closeIssueMessage: values['close-issue-message'], closePrMessage: '', closeIssueLabel: '', closePrLabel: '',
    daysBeforeIssueStale: Number(values['days-before-issue-stale']), daysBeforeIssueClose: Number(values['days-before-issue-close']),
    daysBeforePrStale: Number(values['days-before-pr-stale']), daysBeforePrClose: Number(values['days-before-pr-close']),
    removeStaleWhenUpdated: true, removeIssueStaleWhenUpdated: values['remove-issue-stale-when-updated'] === 'true',
    removePrStaleWhenUpdated: false, ignoreUpdates: false, debugOnly: false,
    exemptMilestones: '', exemptIssueMilestones: '', exemptPrMilestones: '',
    exemptAssignees: '', exemptIssueAssignees: '', exemptPrAssignees: '', exemptDraftPr: false };
}

/** Advance one millisecond per synthetic REST request; adapter calls mutate only this in-memory issue. */
async function scenario(text, expectedClose, { marked = false, labels = ['clarify'], pullRequest = false } = {}) {
  const options = inputs(text), events = [{ event: 'labeled', label: { name: 'clarify' }, created_at: new Date(epoch).toISOString() }];
  if (marked) events.push({ event: 'labeled', label: { name: options.staleIssueLabel }, created_at: new Date(epoch).toISOString() });
  const comments = [{ user: { type: 'User' }, body: 'Clarification supplied.', created_at: new Date(epoch + 10 * DAY).toISOString() }];
  const state = { number: 1, title: 'fixture', state: 'open', labels: [...labels, ...(marked ? [options.staleIssueLabel] : [])].map(name => ({ name })), pull_request: pullRequest ? {} : undefined, created_at: new Date(epoch).toISOString(),
    updated_at: comments[0].created_at, locked: false, milestone: null, assignees: [] };
  const writes = [];
  const api = {
    async listComments({ since }) { now++; return { data: comments.filter(comment => comment.created_at >= since) }; },
    listEvents: { endpoint: { merge: value => value } },
    async addLabels({ labels }) { now++; state.updated_at = new Date(now).toISOString(); writes.push(['add', ...labels]); for (const name of labels) {
      if (!state.labels.some(label => label.name === name)) state.labels.push({ name });
      events.push({ event: 'labeled', label: { name }, created_at: new Date(now).toISOString() });
    } },
    async removeLabel({ name }) { now++; state.updated_at = new Date(now).toISOString(); state.labels = state.labels.filter(label => label.name !== name); writes.push(['remove', name]); },
    async createComment({ body }) { now++; state.updated_at = new Date(now).toISOString(); writes.push(['comment', body]); },
    async update({ state: next }) { now++; state.updated_at = new Date(now).toISOString(); state.state = next; writes.push(['state', next]); },
  };
  context.getOctokit = () => ({ rest: { issues: api }, async paginate() { now++; return structuredClone(events); } });
  const observations = [];
  for (const day of marked ? [20, 24, 35] : [20, 24]) {
    now = epoch + day * DAY + 1000;
    const processor = new context.IssuesProcessor(options, {});
    await processor.processIssue(new context.Issue(options, structuredClone(state)), [], [], []);
    observations.push({ day, state: state.state, labels: state.labels.map(row => row.name) });
    if (marked && day === 20) assert.deepEqual(state.labels.map(row => row.name), ['clarify'], 'activity removes only the inactive marker');
    assert.equal(state.state, expectedClose && day === (marked ? 35 : 24) ? 'closed' : 'open');
  }
  if (expectedClose) assert.deepEqual(writes.filter(row => row[0] === 'comment'),
    [['comment', "Closed. No response. Reply to reopen."]]);
  if (!expectedClose) assert.deepEqual(writes, [], 'excluded or still-active records receive no REST writes');
  return { observations, writes };
}

/** Prove the committed workflow's inactivity behavior using the pinned upstream implementation. */
export async function assertClarificationQuietPeriod(after) {
  const before = readFileSync(new URL('../../../gate/tests/fixtures/actions-stale-v11/stale/before.yml', import.meta.url), 'utf8');
  return { before: await scenario(before, false), after: await scenario(after, true),
    activityResetsMarker: await scenario(after, true, { marked: true }),
    unlabelledIssue: await scenario(after, false, { labels: ['bug'] }),
    pullRequest: await scenario(after, false, { pullRequest: true }),
    scope: 'Complete pinned upstream processor, deterministic clock and simulated REST only; no network or scheduler.' };
}
