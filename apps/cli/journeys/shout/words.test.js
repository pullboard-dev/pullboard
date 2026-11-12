// pullboard: browser
/** @pullboard-test-gui */
/** Plain presentation over real native events, preserving quoted words and action identities [N26]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { recordGateRun } from '../../../lib/index.js';
import {
  applyRelayMove,
  appliedSequence,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import { activityWords } from '../../../view/index.js';
import { runGate } from '../../../../packages/gate/index.js';
import { runnerExecutionServices } from '../../../../packages/runners/index.js';
import { landingExecutionServices } from '../../../../packages/landing/index.js';
import {
  readGateReceipt,
  receiptStore,
} from '../../../../packages/gate/index.js';
import {
  machine,
  project,
  build,
  sendBack,
  startView,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
} from '../../tests/fixtures/cockpit/harness.js';

/** Seed authoritative health transitions through the normal ordered receiver, never fabricated event rows. */
function scan(board, findings) {
  const args = { agentId: 'coordinator', findings, observedRevision: store.events(board).at(-1).event_id };
  const move = prepareEngineMove(board, 'recordHealthFindings', [args], { actor: 'coordinator' });
  const result = applyRelayMove(board, move, { sequence: appliedSequence(board) + 1, at: new Date().toISOString(), kind: 'move', sender: { kind: 'agent', agent: 'coordinator', userId: 'fixture-user' } });
  assert.equal(result.error, undefined, JSON.stringify(result));
}

/** Select a real tab and wait for its own visible pane, keeping hidden-pane isolation intact. */
async function tab(chrome, name) {
  await press(chrome, 'document.querySelector("#tabs [data-tab=' + name + ']")');
  await chrome.waitFor('!document.querySelector("[data-pane=' + name + ']").hidden');
}

/** Exercise real bookkeeping writers, retaining their source/receipt identities outside Activity. */
async function seedBookkeeping(box, alpha) {
  await box.inProcess(alpha.repo, 'add', 'web', 'Bookkeeping keeps its native subject', '--specs', 'G1', '--criterion', 'The native fixture command runs.', '--check', 'node --version');
  await box.inProcess(alpha.repo, 'milestone', 'add', 'Plain launch', '--reason', 'Arrange fixture release', '--items', '1');
  await box.inProcess(alpha.repo, 'milestone', 'items', 'Plain launch', '--add', '2', '--reason', 'Arrange fixture release');
  await box.inProcess(alpha.repo, 'milestone', 'order', 'Plain launch', '2,1', '--reason', 'Arrange fixture release');
  await box.inProcess(alpha.web, 'claim', '3');
  const source = box.git(alpha.web, 'rev-parse', 'HEAD');
  const patch = join(box.dir, 'plain-native.patch');
  writeFileSync(patch, ['diff --git a/docs/plain-native.txt b/docs/plain-native.txt', 'new file mode 100644', '--- /dev/null', '+++ b/docs/plain-native.txt', '@@ -0,0 +1 @@', '+Native companion provenance.', ''].join('\n'));
  await box.inProcess(alpha.repo, 'patch', 'attach', '3', patch, '--key', 'plain-native', '--author', 'coordinator', '--source', source);
  mkdirSync(join(alpha.web, 'web'), { recursive: true });
  writeFileSync(join(alpha.web, 'web', 'bookkeeping.js'), 'export const bookkeeping = true;\n');
  box.git(alpha.web, 'add', 'web/bookkeeping.js');
  box.git(alpha.web, 'commit', '-q', '-m', 'feat(web): native bookkeeping source [G1]');
  const descendant = box.git(alpha.web, 'rev-parse', 'HEAD');
  const run = await runGate(alpha.repo, JSON.parse(readFileSync(join(alpha.repo, 'pullboard.json'), 'utf8')), {
    executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, trustStamp: false, agent: 'coordinator',
  });
  assert.equal(run.isGreen, true, run.output);
  const receipt = readGateReceipt(receiptStore(alpha.repo), run.receiptId);
  assert.ok(receipt, 'the real private gate retained its source-bound receipt');
  // @pullboard-board-file journey: actual native writers feed the same private HTTP projection.
  const board = openBoard(join(alpha.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    recordGateRun(board, { agentId: 'coordinator', receipt, lane: 'web' });
    const followed = store.followItemPatches(board, 3, { agentId: 'web-1', commit: descendant });
    assert.equal(followed.changed, true, 'the actual descendant advances the companion binding');
    store.removeItemPatch(board, 3, { agentId: 'coordinator', key: 'plain-native' });
    store.holdItem(board, 3, { agentId: 'coordinator', reason: 'The native fixture needs guidance.' });
    const rejection = store.events(board, { itemId: 1 }).findLast(event => event.event_kind === 'reject');
    const rejected = store.getItem(board, 1), originalClock = board.clock;
    const now = new Date(Date.parse(rejection.event_at) + 601_000);
    board.clock = { now: () => now };
    try {
      store.recordHealthFindings(board, { agentId: 'coordinator', observedRevision: store.events(board).at(-1).event_id, returnRejected: true,
        findings: [{ key: 'REWORK_UNCLAIMED:item:1', cause: 'REWORK_UNCLAIMED', item: 1, subject: '#1', title: 'rejected work needs another builder', since: rejection.event_at,
          why: 'The private rejected work has waited ten minutes.', next: 'Claim the returned work.', owner: { who: 'coordinator' },
          detail: { move: 'reject', rejection: rejection.event_id, builder: rejected.item_built_by, commit: rejected.item_commit, reason: 'timeout', presence: 'idle', heartbeatAt: null, observedAt: now.toISOString() } }] });
    } finally { board.clock = originalClock; }
    assert.equal(JSON.parse(store.events(board).findLast(event => event.event_kind === 'gate-run').event_detail).run.id, receipt.id, 'the gate event retains its actual receipt identity');
  } finally { store.closeBoard(board); }
  await box.inProcess(alpha.repo, 'hold', 'web', '--reason', 'Waiting for plain guidance.');
  // @pullboard-board-file journey: reopen the CLI's persisted private board to observe actual idle and baseline events.
  const held = openBoard(join(alpha.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    // The fixture has no registered runner, so no background baseline ever lands; record a request and complete it through the real store calls.
    const pending = { command: store.getItem(held, 3).item_check, main: box.git(alpha.repo, 'rev-parse', 'HEAD'), result: 'pending', request: randomUUID() };
    store.saveCheckBaseline(held, 3, pending);
    assert.equal(store.completeCheckBaseline(held, 3, { agentId: 'coordinator', expected: pending,
      baseline: { command: pending.command, main: pending.main, result: 'green', seconds: 1 } }), true, 'the request is still current');
    store.board_recordNextIdle(held, { agentId: 'coordinator', reason: 'held' });
    const kinds = new Set(store.events(held).map(event => event.event_kind));
    for (const kind of ['gate-run', 'milestone_order', 'milestone_items', 'join', 'next-idle', 'check-baseline', 'item_patch_attach', 'item_patch_remove', 'item_patch_follow', 'reject_returned', 'hold_item']) {
      assert.ok(kinds.has(kind), 'private native history genuinely contains ' + kind);
    }
  } finally { store.closeBoard(held); }
}

test('only typed native words are translated while user quotations keep their codes [N26]', () => {
  const quote = 'Keep [RANK_INVERSION] and (TEST_FAILURE). Appointment 2026-10-28T04:12:00Z';
  assert.equal(activityWords({ why: quote }, { preserveWords: true, timestampLabels: new Map([['2026-10-28T04:12:00Z', '9:12 PM']]) }).text,
    'Keep [RANK_INVERSION] and (TEST_FAILURE). Appointment 9:12 PM');
  assert.equal(activityWords({ cause: 'TEST_FAILURE' }).label, 'Tests failed');
  assert.equal(activityWords({ kind: 'proof-run' }).label, 'ran the proof');
});

test('clause 1: native board kinds, names, reasons and sentinel notices read plainly across every surface [N26]', { timeout: 180_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the visible plain-words scanner.');
  const box = machine(), alpha = project(box, 'plain-words');
  await box.inProcess(alpha.repo, 'add', 'web', 'Visible subject for native evidence', '--specs', 'G1', '--criterion', 'greets');
  build(box, alpha, 1, 'plain.txt'); // Actual native frozen check and proof receipt, not synthetic assurance.
  sendBack(box, alpha, 1, 'Keep [MY_CODE] in this quoted review note.');
  for (const [kind, text] of [['measurement', 'Measured the native example.'], ['note', 'Keep [MY_CODE] in the native note.']]) {
    await box.inProcess(alpha.repo, 'fact', '1', kind, text);
  }
  await box.inProcess(alpha.repo, 'add', 'web', 'Legacy holder has a subject', '--specs', 'G1', '--criterion', 'visible');
  const unknown = join(box.dir, 'legacy-unknown');
  box.git(alpha.repo, 'worktree', 'add', '-q', '-b', 'web/plain-legacy', unknown, 'main');
  // Historical stored registrations can have no model even though modern CLI joins require it.
  // @pullboard-board-file journey: a real legacy seat and ordered health events feed the live HTTP projection.
  const board = openBoard(join(alpha.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    store.register(board, { lane: 'web', path: unknown });
    await box.inProcess(unknown, 'claim', '2');
    const since = new Date(Date.now() - 60_000).toISOString();
    const finding = { key: 'RANK_INVERSION:item:2', cause: 'RANK_INVERSION', item: 2, subject: '#2', title: 'a free item ranks ahead', since,
      owner: { who: 'web-2', role: 'agent' }, why: 'web-2 claimed #2 while #1 ranks ahead in the web lane and sits free', next: 'release #2, then claim #1' };
    scan(board, [finding]);
    scan(board, []);
    const kinds = new Set(store.events(board).map(event => event.event_kind));
    for (const kind of ['add', 'claim', 'submit', 'reject', 'proof-run', 'fact', 'health-failure', 'health-resolved', 'health-scan']) {
      assert.ok(kinds.has(kind), 'private native history genuinely contains ' + kind);
    }
  } finally { store.closeBoard(board); }
  await seedBookkeeping(box, alpha);
  await box.inProcess(alpha.repo, 'shout', 'person', 'Which plain greeting?', '--decision');
  await box.inProcess(unknown, 'shout', 'all', 'Keep [MY_CODE] and these words. Appointment 2026-10-28T04:12:00Z');
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-plain-words-'));
  let chrome;
  const forbidden = /\(unknown\)|\b(?:health-failure|health-resolved|health-scan|proof-run|rehomeImport|submit-merge|TEST_FAILURE|BEHAVIOR_MISMATCH)\b|\[RANK_INVERSION\]|\d{4}-\d\d-\d\dT\d\d:/u;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.root === ' + JSON.stringify(alpha.repo));
    for (const name of ['dashboard', 'items', 'shouts', 'activity']) {
      await tab(chrome, name);
      if (name === 'activity') {
        const selection = await chrome.stable(`(() => {
          const before = JSON.stringify(data.project.events), raw = activityModel(data.project), plain = activityModel(data.project, { words: activityWords });
          const excluded = ['gate-run', 'milestone_order', 'milestone_items', 'join', 'next-idle', 'check-baseline', 'item_patch_attach', 'item_patch_remove', 'item_patch_follow', 'reject_returned', 'hold_item'];
          return { raw: raw.rows.map(row => row.id), plain: plain.rows.map(row => row.id),
            bookkeeping: data.project.events.filter(event => excluded.includes(event.event_kind)).map(event => event.event_id),
            unchanged: before === JSON.stringify(data.project.events) };
        })()`);
        assert.deepEqual(selection.plain, selection.raw, 'plain wording preserves the exact native Activity row IDs and count');
        assert.ok(selection.bookkeeping.length > 0 && selection.bookkeeping.every(id => !selection.raw.includes(id) && !selection.plain.includes(id)), 'bookkeeping remains native history without becoming a work row');
        assert.equal(selection.unchanged, true, 'both presentation modes preserve every raw native event field and identity');
        await chrome.stable('document.querySelectorAll("#activity details").forEach(node => { node.open = true; })');
        const rows = await chrome.stable('[...document.querySelectorAll("#activity .activity-event")].map(node => node.innerText)');
        assert.ok(rows.some(text => /Measured|measurement/iu.test(text)), 'the genuine measurement has an Activity sentence');
        assert.ok(rows.every(text => text.trim()), 'no native Activity row is empty');
        const subjects = await chrome.stable('[...document.querySelectorAll("#activity .activity-event")].map(node => (node.querySelector(".activity-who") || node.querySelector("summary b"))?.textContent)');
        assert.ok(subjects.every(subject => typeof subject === 'string' && subject.trim()), 'every native Activity sentence has its actual actor or Sentinels subject');
        const workSubjects = await chrome.stable('[...document.querySelectorAll("#activity .activity-event")].filter(node => !["shout", "sentinels"].includes(node.dataset.activityKind)).map(node => node.querySelector(".activity-item")?.textContent)');
        assert.ok(workSubjects.every(subject => typeof subject === 'string' && subject.trim()), 'every native work sentence retains its actual item subject');
      }
      const text = await chrome.stable('document.querySelector("[data-pane=' + name + ']").innerText');
      assert.doesNotMatch(text, forbidden, name + ': visible scanner finds no raw machine words');
      if (name === 'shouts') assert.match(text, /Keep \[MY_CODE\] and these words\./u, 'free user words remain exact');
    }
    await tab(chrome, 'items');
    assert.match(await chrome.stable('document.querySelector("#needs").innerText'), /Asked by coordinator/u, 'the person keeps the actual source of the decision');
    assert.doesNotMatch(await chrome.stable('document.querySelector("#needs").innerText'), /\(unknown\)/u, 'Needs attribution shows no invented model');
    await press(chrome, 'document.querySelector("#chain [data-item=\\\"1\\\"]")');
    await chrome.waitFor('document.querySelector("#detail").textContent.includes("Visible subject")');
    const detail = await chrome.stable('document.querySelector("#detail").innerText');
    assert.doesNotMatch(detail, forbidden, 'item timeline and verdict contain plain visible labels');
    assert.match(detail, /Keep \[MY_CODE\] in this quoted review note\./u, 'reviewer words remain exact');
    assert.equal(await chrome.stable('document.querySelector("#detail .verdict.no [title=BEHAVIOR_MISMATCH]")?.title'), 'BEHAVIOR_MISMATCH', 'the exact reason survives as a tooltip');
    await tab(chrome, 'activity');
    if (!await chrome.stable('document.querySelectorAll("#flow svg title").length > 0')) await press(chrome, 'document.querySelector("#flow-show")');
    await chrome.waitFor('document.querySelectorAll("#flow svg title").length > 0');
    assert.doesNotMatch(await chrome.stable('[...document.querySelectorAll("#flow svg text")].map(node => node.textContent).join(" ")'), /rehomeImport|submit-merge|\bintake\b|\bpatch\b/u, 'lifecycle labels use plain action words');
    assert.doesNotMatch(await chrome.stable('[...document.querySelectorAll("#flow svg title")].map(node => node.textContent).join(" ")'), /\b(?:rehomeImport|submit-merge|intake|patch)\b/u, 'lifecycle hover text uses plain action words as well');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
