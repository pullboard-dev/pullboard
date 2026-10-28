/** @pullboard-test-gui */
/** Plain presentation over real native events, preserving quoted words and action identities [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../src/board.js';
import { applyRelayMove, appliedSequence, prepareEngineMove } from '../../src/engine.js';
import { activityWords } from '../../src/view/activity-words.js';
import { machine, project, build, sendBack, startView, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, press } from './fixture.js';

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

test('only typed native words are translated while user quotations keep their codes [N26]', () => {
  const quote = 'Keep [RANK_INVERSION] and (TEST_FAILURE). Appointment 2026-10-28T04:12:00Z';
  assert.equal(activityWords({ why: quote }, { preserveWords: true, timestampLabels: new Map([['2026-10-28T04:12:00Z', '9:12 PM']]) }).text,
    'Keep [RANK_INVERSION] and (TEST_FAILURE). Appointment 9:12 PM');
  assert.equal(activityWords({ cause: 'TEST_FAILURE' }).label, 'Tests failed');
  assert.equal(activityWords({ kind: 'proof-run' }).label, 'ran the proof');
});

test('native board kinds, names, reasons and sentinel notices read plainly across every surface [N26]', { timeout: 180_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the visible plain-words scanner.');
  const box = machine(), alpha = project(box, 'plain-words');
  box.run(alpha.repo, 'add', 'web', 'Visible subject for native evidence', '--specs', 'G1', '--criterion', 'greets');
  build(box, alpha, 1, 'plain.txt'); // Actual native frozen check and proof receipt, not synthetic assurance.
  sendBack(box, alpha, 1, 'Keep [MY_CODE] in this quoted review note.');
  for (const [kind, text] of [['measurement', 'Measured the native example.'], ['note', 'Keep [MY_CODE] in the native note.']]) {
    box.run(alpha.repo, 'fact', '1', kind, text);
  }
  box.run(alpha.repo, 'add', 'web', 'Legacy holder has a subject', '--specs', 'G1', '--criterion', 'visible');
  const unknown = join(box.dir, 'legacy-unknown');
  box.git(alpha.repo, 'worktree', 'add', '-q', '-b', 'web/plain-legacy', unknown, 'main');
  // Historical stored registrations can have no model even though modern CLI joins require it.
  // @pullboard-board-file journey: a real legacy seat and ordered health events feed the live HTTP projection.
  const board = store.openBoard(join(alpha.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    store.register(board, { lane: 'web', path: unknown });
    box.run(unknown, 'claim', '2');
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
  box.run(alpha.repo, 'shout', 'person', 'Which plain greeting?', '--decision');
  box.run(alpha.repo, 'hold', 'web', '--reason', 'Waiting for plain guidance.');
  box.run(unknown, 'shout', 'all', 'Keep [MY_CODE] and these words. Appointment 2026-10-28T04:12:00Z');
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-plain-words-'));
  let chrome;
  const forbidden = /\(unknown\)|\b(?:health-failure|health-resolved|health-scan|proof-run|rehomeImport|submit-merge|TEST_FAILURE|BEHAVIOR_MISMATCH)\b|\[RANK_INVERSION\]|\d{4}-\d\d-\d\dT\d\d:/u;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.root === ' + JSON.stringify(alpha.repo));
    for (const name of ['dashboard', 'items', 'shouts', 'activity']) {
      await tab(chrome, name);
      if (name === 'activity') {
        await chrome.stable('document.querySelectorAll("#activity details").forEach(node => { node.open = true; })');
        const rows = await chrome.stable('[...document.querySelectorAll("#activity .activity-event")].map(node => node.innerText)');
        assert.ok(rows.some(text => /Measured|measurement/iu.test(text)), 'the genuine measurement has an Activity sentence');
        assert.ok(rows.every(text => text.trim()), 'no native Activity row is empty');
        const subjects = await chrome.stable('[...document.querySelectorAll("#activity .activity-event")].map(node => (node.querySelector(".activity-who") || node.querySelector("summary b"))?.textContent)');
        assert.ok(subjects.every(subject => typeof subject === 'string' && subject.trim()), 'every native Activity sentence has its actual actor or Sentinels subject');
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
    assert.doesNotMatch(await chrome.stable('[...document.querySelectorAll("#flow svg text")].map(node => node.textContent).join(" ")'), /rehomeImport|submit-merge|\bintake\b|\bpatch\b/u, 'lifecycle labels use plain action words');
    assert.doesNotMatch(await chrome.stable('[...document.querySelectorAll("#flow svg title")].map(node => node.textContent).join(" ")'), /\b(?:rehomeImport|submit-merge|intake|patch)\b/u, 'lifecycle hover text uses plain action words as well');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
