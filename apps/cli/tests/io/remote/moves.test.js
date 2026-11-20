/** A seat with board.url set moves a served board through POST /moves and opens no board.sqlite [P7]. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { FIXTURE_MODEL } from '../../fixtures/testkit.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { runCliInProcess } from '../../fixtures/process.js';
import { cloneBoard } from '../../fixtures/api/remote-moves.js';
import { onRemoteSeats } from '../../fixtures/api/remote-moves.js';
import { sendRemoteHeartbeat } from '../../../src/io/remote/moves.js';

test('cli.io-remote-moves.a-seat-joined-by-url-claims-commits: clause 1: a seat joined by URL claims, commits in its own clone and submits, exiting 0 with the clone as the source [P7,C7]', { timeout: 120_000 }, // budget: hang ceiling for fixture init, a served board, one submit handoff and five CLI calls, not a throughput claim.
onRemoteSeats(async (seats) => {
  const id = await seats.add('Remote clone item');
  const own = (...args) => runCliInProcess(args, { cwd: seats.clone, env: { ...seats.box.env, PULLBOARD_MACHINE_HOME: seats.machine, PULLBOARD_AGENT: '' } });
  // The commit transport is off by default: this clone opts in, so its submit carries its commits as a bundle [P7,C7].
  assert.equal((await own('settings', 'board.commits', 'bundle')).status, 0);
  const joined = await own('join', 'app', '--model', FIXTURE_MODEL, '--route', 'strong', '--json');
  assert.equal(joined.status, 0, joined.stdout + joined.stderr);
  const claimed = await own('claim', String(id), '--json');
  assert.equal(claimed.status, 0, claimed.stdout + claimed.stderr);
  mkdirSync(join(seats.clone, 'app'), { recursive: true });
  writeFileSync(join(seats.clone, 'app', `work-${id}.txt`), `work for #${id}\n`);
  runFixtureGit(['add', '-A'], { cwd: seats.clone, env: seats.box.env, stdio: 'pipe' });
  runFixtureGit(['commit', '-q', '-m', `feat: fixture work [G1]\n\nPullboard-Item: #${id}`], { cwd: seats.clone, env: seats.box.env, stdio: 'pipe' });
  const submitted = await own('submit', String(id));
  assert.equal(submitted.status, 0, submitted.stdout + submitted.stderr);
  assert.match(submitted.stdout, new RegExp(`^submitted #${id}\\b.* via http://`, 'mu'));
  assert.equal(cloneBoard(seats.clone), false, 'no move opened a local board');
}));

test('cli.io-remote-moves.a-claim-by-a-seat-joined-by: a claim by a seat joined by URL opens no item folder on the board host [C7]', { timeout: 90_000 }, // budget: hang ceiling for fixture init, a served board, one join and one claim, not a throughput claim.
onRemoteSeats(async (seats) => {
  const id = await seats.add('Remote folderless item');
  const own = (...args) => runCliInProcess(args, { cwd: seats.clone, env: { ...seats.box.env, PULLBOARD_MACHINE_HOME: seats.machine, PULLBOARD_AGENT: '' } });
  const joined = await own('join', 'app', '--model', FIXTURE_MODEL, '--route', 'strong', '--json');
  assert.equal(joined.status, 0, joined.stdout + joined.stderr);
  const claimed = await own('claim', String(id), '--json');
  assert.equal(claimed.status, 0, claimed.stdout + claimed.stderr);
  assert.equal(JSON.parse(claimed.stdout).itemFolder, undefined, 'the claim result names no item folder');
  assert.equal((await seats.row(id)).status, 'claimed', 'the claim reached the served board');
  const folders = readdirSync(dirname(seats.box.root)).filter((name) => name.endsWith(`-item-${id}`));
  assert.deepEqual(folders, [], 'no item folder appeared beside the board host checkout');
  assert.equal(cloneBoard(seats.clone), false, 'the claim opened no local board');
}));

test('cli.io-remote-moves.heartbeat-posts-the-move: sendRemoteHeartbeat posts {verb: heartbeat, args: {}, agent} to the fixture server /moves and reports a refusal as not held [P7,B3]', async (t) => {
  const posts = [];
  let refuse = false;
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (part) => { body += part; });
    request.on('end', () => {
      posts.push({ path: request.url, body: JSON.parse(body) });
      response.writeHead(refuse ? 409 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(refuse ? { error: { code: 'NOT_HELD', message: 'this seat holds no claim' } } : { result: {} }));
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const remote = { url: `http://127.0.0.1:${server.address().port}/api/v1/boards/b1`, token: 'k', agent: 'core-9' };
  assert.equal(await sendRemoteHeartbeat(remote), true);
  assert.deepEqual(posts, [{ path: '/api/v1/boards/b1/moves', body: { verb: 'heartbeat', args: {}, agent: 'core-9' } }]);
  refuse = true;
  assert.equal(await sendRemoteHeartbeat(remote), false, 'a refused beat reads as not held');
});
