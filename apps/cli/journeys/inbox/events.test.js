/** HTTP event stream: state, moves, requests and live frames [A2,V2,H16,H12,R2]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
} from 'node:path';
import { test } from 'node:test';

import { registerProject } from '../../../../packages/seats/index.js';
import { serveView } from '../../src/io/commands/view.js';

import {
  apiHttpFixture as fixture,
  apiHttpBox as httpBox,
  registerFixtureRunner,
  shellWord,
  FIXTURE_BRIEF,
} from '../../tests/fixtures/api.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { fetchFresh } from '../../tests/fixtures/http.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';

import { fixtureSettledMachine } from '../../tests/fixtures/testkit.js';

/** Commit a fixture-owned app change so the native submit move has a real head to capture. */
function commitAppChange(worktree, filename, env) {
  mkdirSync(join(worktree.path, 'app'), { recursive: true });
  writeFileSync(join(worktree.path, 'app', filename), 'export const fixture = true;\n');
  runFixtureGit(['add', '--', `app/${filename}`], { cwd: worktree.path, env, stdio: 'pipe' });
  runFixtureGit(['commit', '-q', '-m', `feat(test): add ${filename} [G1]`], { cwd: worktree.path, env, stdio: 'pipe' });
}

/** Serve a registered private fixture through the actual person's view adapter. */
async function viewHttpBox(t, existing = null) {
  const box = existing ?? fixture(t);
  const previousHome = process.env.PULLBOARD_HOME;
  let view;
  t.after(async () => {
    try { await view?.close(); }
    finally {
      if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
      else process.env.PULLBOARD_HOME = previousHome;
    }
  });
  process.env.PULLBOARD_HOME = box.env.PULLBOARD_HOME;
  registerProject(box.root);
  view = await serveView({ port: 0, runCommand: nativeTestMain });
  const url = new URL(view.url);
  const key = url.searchParams.get('k');
  const origin = url.origin;
  /** Make a real HTTP call to this fixture's view and decode its versioned response. */
  async function call(path, value, headers = {}) {
    const response = await fetchFresh(origin + path, {
      method: value === undefined ? 'GET' : 'POST',
      headers: { 'x-pullboard-key': key, ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    const document = await response.json();
    assert.equal(document.version, 1);
    return { status: response.status, document };
  }
  const listed = await call('/api/v1/boards');
  assert.equal(listed.status, 200);
  assert.equal(listed.document.boards.length, 1);
  const id = listed.document.boards[0].id;
  return { ...box, api: view, origin, key, id, call, path: '/api/v1/boards/' + id };
}


test('[A2] real HTTP state, moves and refusals use the CLI and exact committed events', async (t) => {
  const box = await httpBox(t);
  // This test never registers a runner, so its submit and next --verify must settle in the command: pin controller dispatch [P7].
  const settingsFile = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, settings);
  const one = await box.cliLocal(box.root, 'worktree', 'app', '--model', 'fixture-one');
  const two = await box.cliLocal(box.root, 'worktree', 'app', '--model', 'fixture-two');
  const added = await box.call(box.path + '/moves', { verb: 'add', args: { lane: 'app', title: 'HTTP item', criterion: 'complete', specs: 'G1', brief: FIXTURE_BRIEF } });
  assert.equal(added.status, 200);
  assert.equal(added.document.event.event_kind, 'add');
  const id = added.document.result.item.item_id;
  const claimed = await box.call(box.path + '/moves', { verb: 'claim', item: id, agent: one.agent });
  assert.equal(claimed.status, 200);
  commitAppChange(one, `http-${id}.js`, box.env);
  assert.equal(claimed.document.event.event_by, one.agent);
  assert.equal(claimed.document.event.event_kind, 'claim');
  const refused = await box.call(box.path + '/moves', { verb: 'claim', item: id, agent: two.agent });
  const terminal = await runCliInProcess(['claim', String(id), '--json'], { cwd: two.path, env: box.env });
  assert.equal(refused.status, 409);
  assert.equal(terminal.status, 1);
  assert.equal(refused.document.error.code, JSON.parse(terminal.stdout).error.code);
  assert.deepEqual(refused.document.error, JSON.parse(terminal.stdout).error, 'the original CLI refusal keeps its message and next step');
  const state = await box.call(box.path + '/state');
  assert.equal(state.document.state.board, box.id);
  assert.equal(state.document.state.items.find((item) => item.id === id).claim.by, one.agent);
  assert.equal((await box.call(box.path + '/items/' + id)).document.item.owner, one.agent);
  const events = await box.call(box.path + '/events?after=' + added.document.event.event_id);
  assert.deepEqual(events.document.events.map((event) => event.event_kind), ['milestone_placed', 'claim']);
  assert.equal(events.document.events[0].item_id, id);
  assert.deepEqual(events.document.events[1], claimed.document.event);
  const badAgent = await box.call(box.path + '/moves', { verb: 'release', item: id, agent: 'absent-agent' });
  assert.equal(badAgent.status, 409);
  assert.equal(badAgent.document.error.code, 'NO_AGENT');
  const submitted = await box.call(box.path + '/moves', { verb: 'submit', item: id, agent: one.agent });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.document));
  const review = await box.call(box.path + '/moves', { verb: 'next', agent: two.agent, args: { verify: true } });
  assert.equal(review.status, 200, JSON.stringify(review.document));
  assert.equal(review.document.result.item.item_id, id);
  const missingNote = await box.call(box.path + '/moves', { verb: 'release', item: id, agent: two.agent, args: { reason: 'BLOCKED' } });
  assert.equal(missingNote.status, 409);
  assert.equal(missingNote.document.error.code, 'NOTE_REQUIRED');
  const release = await box.call(box.path + '/moves', { verb: 'release', item: id, agent: two.agent, args: { note: 'reviewed the wrong tree', reason: 'OTHER' } });
  assert.equal(release.status, 200, JSON.stringify(release.document));
  assert.deepEqual(JSON.parse(release.document.event.event_detail), { review: true, reason: 'reviewed the wrong tree', reasonCode: 'OTHER', model: 'fixture-two' });
});

test('[A2,V2,H16] board-state JSON retains pending and red baselines and removes cleared observations', async (t) => {
  const box = await httpBox(t);
  const pending = { command: 'true', main: box.commit, result: 'pending', request: randomUUID() };
  // @pullboard-board-file journey: the inbox HTTP view and the CLI read this same repo board file.
  const board = store.openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  let id;
  try {
    id = store.addItem(board, { by: 'coordinator', lane: 'app', title: 'Captured API observation',
      check: pending.command, checkBaseline: pending });
  } finally { store.closeBoard(board); }
  const initial = await box.call(box.path + '/items/' + id);
  assert.deepEqual(initial.document.item.checkBaseline, pending,
    'a pending captured request reaches the public state endpoint before completion');
  // @pullboard-board-file journey: the inbox HTTP view and the CLI read this same repo board file.
  const completed = store.openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  try {
    store.completeCheckBaseline(completed, id, { agentId: 'coordinator', expected: pending,
      baseline: { command: pending.command, main: pending.main, result: 'red', seconds: 1 } });
  } finally { store.closeBoard(completed); }
  const redState = await box.call(box.path + '/items/' + id);
  const red = redState.document.item.checkBaseline;
  assert.deepEqual(red, { command: pending.command, main: pending.main, result: 'red', seconds: 1, request: pending.request });
  assert.equal(Object.hasOwn(red, 'warning'), false, 'a failing baseline has no proves-nothing warning');
  const cleared = await box.call(box.path + '/moves', { verb: 'edit', item: id, args: { check: '' } });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.document));
  const clearedState = await box.call(box.path + '/items/' + id);
  const clearedItem = clearedState.document.item;
  assert.equal(clearedItem.check, '');
  assert.equal(Object.hasOwn(clearedItem, 'checkBaseline'), false, 'clearing the check removes its old observation from API state');
});

test('[A2,V2] HTTP add and edit preserve explicit blocking baseline requests', async (t) => {
  const box = await httpBox(t);
  registerFixtureRunner(t, box);
  // The stand-in runner serves the baseline inside the command, so pin controller dispatch as test 1 does [P7].
  const settingsFile = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, settings);
  /** Build a finite check whose completion can be observed independently of the HTTP response. */
  function completedCheck(marker) {
    const script = `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'finished')`;
    return `${shellWord(process.execPath)} -e ${shellWord(script)}`;
  }
  const firstMarker = join(box.dir, 'add-finished');
  const check = completedCheck(firstMarker);
  const added = await box.call(box.path + '/moves', { verb: 'add', args: {
    lane: 'app', title: 'Blocking API check', check, wait: true,
  } });
  assert.equal(added.status, 200, JSON.stringify(added.document));
  const item = added.document.result.item;
  assert.equal(item.item_check_baseline.result, 'green', '--wait returns a terminal observation in the add response');
  assert.equal(item.item_check_baseline.warning, 'CRITERION_PROVES_NOTHING');
  assert.equal(readFileSync(firstMarker, 'utf8'), 'finished');
  const addedState = await box.call(box.path + '/items/' + item.item_id);
  const projected = addedState.document.item;
  assert.equal(projected.check, check);
  assert.deepEqual(projected.checkBaseline, item.item_check_baseline, 'board-state item JSON carries the same complete observation and warning');
  const secondMarker = join(box.dir, 'edit-finished');
  const editedCheck = completedCheck(secondMarker);
  const edited = await box.call(box.path + '/moves', { verb: 'edit', item: item.item_id, args: {
    check: editedCheck, wait: true,
  } });
  assert.equal(edited.status, 200, JSON.stringify(edited.document));
  assert.equal(edited.document.result.item.item_check_baseline.command, editedCheck);
  assert.equal(edited.document.result.item.item_check_baseline.result, 'green', '--wait also blocks edit until its new check finishes');
  assert.equal(readFileSync(secondMarker, 'utf8'), 'finished');
  const editedState = await box.call(box.path + '/items/' + item.item_id);
  const editedItem = edited.document.result.item;
  assert.deepEqual(editedState.document.item.checkBaseline,
    editedItem.item_check_baseline, 'board-state JSON replaces the observation when the check changes');
});

test('[A2, H12, R2] requests and shouts append events and requests stay outside decisions', async (t) => {
  const box = await viewHttpBox(t);
  const requested = await box.call(box.path + '/requests', { text: 'Please approve the fixture row.' });
  assert.equal(requested.status, 200);
  assert.equal(requested.document.result.request, true);


  assert.equal(requested.document.event.event_kind, 'shout');
  const shout = await box.call(box.path + '/moves', { verb: 'shout', args: { to: 'app', text: 'new work' } });
  assert.equal(shout.document.event.event_kind, 'shout');
  const state = await box.call(box.path + '/state');
  assert.equal(state.document.state.requests.length, 1);
  assert.equal(state.document.state.decisions.length, 0);
  const premature = await box.call(box.path + '/moves', { verb: 'answer', item: requested.document.result.id, args: { text: 'I am working on it' } });
  assert.equal(premature.status, 409);
  assert.equal(premature.document.error.code, 'REQUEST_OUTCOME');
  assert.equal((await box.call(box.path + '/state')).document.state.requests.length, 1);
  const answer = await box.call(box.path + '/moves', { verb: 'answer', item: requested.document.result.id, args: { text: 'done checked and recorded' } });
  assert.equal(answer.status, 200);
  assert.equal(answer.document.event.event_kind, 'answer');
  assert.equal((await box.call(box.path + '/state')).document.state.requests.length, 0);
});

test('[A2] a live HTTP stream follows CLI writes and reconnects after Last-Event-ID', async (t) => {
  const box = await httpBox(t);
  const initial = await box.call(box.path + '/events');
  const after = initial.document.events.at(-1).event_id;
  const controller = new AbortController();
  const response = await fetchFresh(box.origin + box.path + '/events?after=' + after, { headers: { 'x-pullboard-key': box.key, accept: 'text/event-stream' }, signal: controller.signal });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  let buffered = '';
  /** Read a complete live event with a bounded timeout. */
  async function frame() {
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      while (!/\ndata: .+\n\n/.test(buffered)) {
        const { value, done } = await reader.read();
        assert.equal(done, false, 'stream stays open until its event arrives');
        buffered += new TextDecoder().decode(value);
      }
      const match = /id: (\d+)\ndata: (.+)\n\n/.exec(buffered);
      assert.ok(match);
      buffered = buffered.slice(match.index + match[0].length);
      return { id: Number(match[1]), document: JSON.parse(match[2]) };
    } finally { clearTimeout(timeout); }
  }
  const added = await box.cliLocal(box.root, 'add', 'app', 'Terminal event', '--criterion', 'done', '--specs', 'G1');
  const live = await frame();
  assert.equal(live.document.version, 1);
  assert.equal(live.document.event.event_kind, 'add');
  assert.equal(live.document.event.item_id, added.item.item_id);
  assert.equal(live.id, live.document.event.event_id);
  await reader.cancel();
  controller.abort();
  const replay = await fetchFresh(box.origin + box.path + '/events?after=0', { headers: { 'x-pullboard-key': box.key, 'last-event-id': String(live.id) } });
  const replayed = (await replay.json()).events;
  assert.deepEqual(replayed.map(event => [event.event_kind, event.item_id]), [['milestone_placed', added.item.item_id]], 'the later placement event replays after the add cursor');
  const invalid = await box.call(box.path + '/events?after=1.5');
  assert.equal(invalid.status, 400);
  assert.equal(invalid.document.error.code, 'BAD_CURSOR');
});
