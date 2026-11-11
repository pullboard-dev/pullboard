/** @pullboard-test-input source-tree */
/** An agent-shell serve cannot record a person move [P6,B26]. */
import { viewApiPorts } from '../../../../view/index.js';
import { apiBoardOpeners } from '../../../tests/fixtures/board.js';
import { main as nativeTestMain } from '../../../tests/fixtures/native.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runFixtureGit } from '../../../tests/fixtures/child.js';
import { startFixtureChild } from '../../../tests/fixtures/child.js';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { serveApi } from '../../../../../packages/api/index.js';
import { refusalDocument } from '../../../index.js';
import { serveView } from '../../../src/io/commands/view.js';
import { main } from '../../../tests/fixtures/native.js';
import { registerProject } from '../../../../../packages/seats/index.js';
import { apiHttpFixture as fixture } from '../../../tests/fixtures/api.js';

const BIN = resolve(import.meta.dirname, '../../../pullboard.js');
import { fetchFresh } from '../../../tests/fixtures/http.js';

test("an agent-shell serve cannot record a person's move [P6,B26]", { timeout: 60_000 }, // budget: hang ceiling for private CLI/API startup and person-channel checks, not a throughput claim.
async (t) => {
  const box = fixture(t);
  const spec = join(box.root, 'SPEC.md');
  writeFileSync(spec, readFileSync(spec, 'utf8') + '\n- G2 [pending, must] Person approval only. | gate: true\n- G3 [pending, must] Person decline only. | gate: true\n');
  runFixtureGit(['add', 'SPEC.md'], { cwd: box.root, env: box.env });
  runFixtureGit(['commit', '-qm', 'chore(test): prepare person-only rows'], { cwd: box.root, env: box.env });
  const item = box.cli(box.root, 'add', 'app', 'Private channel item', '--specs', 'G1', '--criterion', 'No person bypass').item.item_id;
  const decision = box.cli(box.root, 'shout', 'person', 'Choose the private fixture decision', '--decision').id;
  const child = startFixtureChild(process.execPath, [BIN, 'serve', '--port', '0', '--json'], {
    cwd: box.root, env: { ...box.env, CLAUDECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise(resolveClosed => child.once('close', resolveClosed));
  let stopped = false;
  /** Stop only the private server and await its terminal close before deleting its fixture. */
  async function stopServer() {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    let timer;
    try {
      const ended = await Promise.race([closed.then(() => true), new Promise(resolveWait => { timer = setTimeout(() => resolveWait(false), 2000); })]);
      if (!ended) { child.kill('SIGKILL'); await closed; }
    } finally { clearTimeout(timer); }
  }
  t.after(stopServer);
  const served = await new Promise((resolveAddress, rejectAddress) => {
    let output = '';
    const timer = setTimeout(() => rejectAddress(new Error('private agent serve did not announce its address')), 20_000);
    child.once('exit', () => { clearTimeout(timer); rejectAddress(new Error('private agent serve exited before its address')); });
    child.stdout.on('data', chunk => {
      output += chunk;
      try {
        const document = JSON.parse(output);
        if (typeof document.url === 'string') { clearTimeout(timer); resolveAddress(new URL(document.url)); }
      } catch { /* Wait for the complete private JSON announcement, never print its key. */ }
    });
  });
  const headers = { 'x-pullboard-key': served.searchParams.get('k'), 'content-type': 'application/json' };
  const listing = await (await fetchFresh(served.origin + '/api/v1/boards', { headers })).json();
  const id = listing.boards.find(board => resolve(board.root) === resolve(box.root)).id;
  const path = '/api/v1/boards/' + id;
  const before = box.cli(box.root, 'log').events.length;
  const attempts = [
    { verb: 'spec-approve', args: { ids: 'G2' } },
    { verb: 'spec-decline', args: { ids: 'G3', reason: 'Not approved by a person' } },
    { verb: 'answer', item: decision, args: { text: 'Forged person answer', as: 'person' } },
    { verb: 'verify', item, args: { decision: 'accept', as: 'person', note: 'Forged person verification' } },
    { verb: 'next', args: { as: 'person' } },
  ];
  for (const move of attempts) {
    const response = await fetchFresh(served.origin + path + '/moves', { method: 'POST', headers, body: JSON.stringify(move) });
    const document = await response.json();
    assert.equal(document.error?.code, 'B26_PERSON_CHANNEL', move.verb + ' never receives person authority from an API key');
    assert.notEqual(response.status, 200);
    assert.equal(box.cli(box.root, 'log').events.length, before, move.verb + ' records no event');
  }
  const tokenResponse = await fetchFresh(served.origin + path + '/tokens', { method: 'POST', headers, body: JSON.stringify({ id: randomUUID() }) });
  assert.equal((await tokenResponse.json()).error?.code, 'B26_PERSON_CHANNEL', 'API token management has no person authority either');
  assert.equal(box.cli(box.root, 'log').events.length, before);
  await stopServer();
  // Denial belongs to the interface, even when the server has no agent-shell marker.
  const plain = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, port: 0, runCommand: main, projects: () => [{ root: box.root, name: 'Plain API fixture' }] });
  t.after(() => plain.close());
  const plainAddress = new URL(plain.url);
  const plainReply = await fetchFresh(plainAddress.origin + path + '/moves', {
    method: 'POST', headers: { 'x-pullboard-key': plainAddress.searchParams.get('k'), 'content-type': 'application/json' },
    body: JSON.stringify({ verb: 'spec-approve', args: { ids: 'G2' } }),
  });
  assert.equal((await plainReply.json()).error?.code, 'B26_PERSON_CHANNEL', 'an ordinary-shell API has no person authority');
  assert.equal(box.cli(box.root, 'log').events.length, before);
  registerProject(box.root);
  const view = await serveView({ port: 0, runCommand: nativeTestMain });
  t.after(() => view.close());
  const viewAddress = new URL(view.url);
  const response = await fetchFresh(viewAddress.origin + path + '/moves', {
    method: 'POST', headers: { 'x-pullboard-key': viewAddress.searchParams.get('k'), 'content-type': 'application/json' },
    body: JSON.stringify({ verb: 'spec-approve', args: { ids: 'G2' } }),
  });
  assert.equal(response.status, 200, 'the actual view keeps the person channel');
  const approved = (await response.json()).event;
  assert.equal(approved.event_by, 'person');
  assert.equal(box.cli(box.root, 'log').events.length, before + 1);
});

