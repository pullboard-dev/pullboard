/** @pullboard-test-input apps/cli/src/io/cli-main/run.js apps/cli/tests/fixtures/next/take.js apps/cli/tests/fixtures/process.js */
/** Every board command a seat runs renews its presence, so a seat driven one short command at a time keeps its claim [B3,C7,#10873]. */
import assert from 'node:assert/strict';
import { lstatSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { captureLapsedClaims } from '../../../../../packages/health/index.js';
import { githubKeys } from '../../../../../packages/github/index.js';
import { COMMANDS } from '../../../src/io/commands/index.js';
import { fixture } from '../../fixtures/next/take.js';
import { cli } from '../../fixtures/next/take.js';
import { runCliInProcess } from '../../fixtures/process.js';

const MINUTE = 60_000;

/** The seat's presence key and an accessor for its sidecar heartbeat row. */
function presence(box, seat) {
  const identity = box.board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='board_id'").get().meta_value;
  const key = JSON.stringify([identity, seat.id]);
  const open = () => new DatabaseSync(`${box.file}.presence.sqlite`);
  return {
    at() { const db = open(); try { return db.prepare('SELECT at FROM heartbeat WHERE seat=?').get(key)?.at ?? null; } finally { db.close(); } },
    /** The seat's last beat was `ms` ago: the gap since its previous command. */
    ago(ms, from = Date.now()) {
      const db = open();
      try { db.prepare('INSERT INTO heartbeat(seat,at) VALUES (?,?) ON CONFLICT(seat) DO UPDATE SET at=excluded.at').run(key, new Date(from - ms).toISOString()); }
      finally { db.close(); }
    },
  };
}

/** Age every file of the seat's checkout and its HEAD reflog, so file activity never holds the claim and only presence can. */
function ageCheckout(path) {
  const old = new Date(Date.now() - 30 * MINUTE);
  const pointer = /^gitdir: (.+)\s*$/u.exec(readFileSync(join(path, '.git'), 'utf8'));
  utimesSync(join(resolve(path, pointer[1].trim()), 'logs', 'HEAD'), old, old);
  const pending = [path];
  while (pending.length) {
    for (const entry of readdirSync(pending.pop(), { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const file = join(entry.parentPath, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (!lstatSync(file).isSymbolicLink()) utimesSync(file, old, old);
    }
  }
}

/** One whole board command from the seat's checkout through the production main(); a read starts no beater, so nothing outlives it. */
async function command(seat, ...args) {
  const ran = await runCliInProcess(args, { cwd: seat.path, env: process.env });
  assert.equal(ran.status, 0, `pullboard ${args.join(' ')}: ${ran.stderr}`);
}

/** The ids the real seat-gone sweep would return, read at `at`. */
function swept(box, at) {
  box.advance(at - box.clock.now().getTime());
  const snapshot = captureLapsedClaims({ clock: box.clock, config: box.config, info: { root: box.root }, keepClaimWhileRunning: false }, box.board, 'coordinator');
  return snapshot ? snapshot.claims.map(claim => ({ id: claim.id, idle: claim.idle ?? null })) : [];
}

/** A seat that claimed five minutes ago and has written no board event since. */
async function claimedSeat(t) {
  const box = await fixture(t);
  const seat = box.seats.actor;
  box.advance(Date.now() - 5 * MINUTE - box.clock.now().getTime());
  const id = box.add('Held by short commands');
  box.claim(id, seat);
  return { box, seat, id, beat: presence(box, seat) };
}

test('cli.io-cli-main-run.short-commands-keep-claim: clause 1: separate short read commands from a claimed seat each renew its presence, and with one command every 60 s the seat-gone sweep keeps the claim [B3,C7,#10873]', async t => {
  const { box, seat, id, beat } = await claimedSeat(t);
  for (const args of [['show', String(id)], ['list'], ['whoami']]) {
    beat.ago(MINUTE);
    const before = Date.now();
    await command(seat, ...args);
    const at = Date.parse(beat.at());
    assert.ok(at >= before, `pullboard ${args[0]} renewed the seat's presence (beat ${beat.at()})`);
    ageCheckout(seat.path);
    assert.deepEqual(swept(box, at + 90_000), [], `90 s after pullboard ${args[0]} the sweep keeps #${id}`);
  }
});

test('cli.io-cli-main-run.quiet-seat-loses-claim: clause 2: with no command for 3 minutes the same sweep returns the claim as seat-gone [B3,C7,#10873]', async t => {
  const { box, seat, id, beat } = await claimedSeat(t);
  beat.ago(MINUTE);
  ageCheckout(seat.path);
  assert.deepEqual(swept(box, Date.now() + 2 * MINUTE), [{ id, idle: 'seat-gone' }], 'a seat silent for 3 minutes loses its claim');
});

test('cli.io-cli-main-run.beat-reads-command-clock: clause 3: a command run through main() with an injected clock records the seat presence at that clock\'s time, not the wall clock\'s [C7,#10899]', async t => {
  const box = await fixture(t);
  const seat = box.seats.actor;
  const beat = presence(box, seat);
  // The fixture clock sits weeks before the wall clock; the seat's last beat is two fake minutes old, so the throttle lets the next beat through.
  box.advance(Date.parse('2026-01-05T10:00:00.000Z') - box.clock.now().getTime());
  beat.ago(2 * MINUTE, box.clock.now().getTime());
  const ran = await cli(box, seat.path, ['whoami']);
  assert.equal(ran.code, 0, ran.out + ran.err);
  assert.equal(beat.at(), box.clock.now().toISOString(), 'the beat carries the injected clock\'s time');
});

test('cli.io-cli-main-run.io-carries-github-keys: clause 1: the io object that run.js builds carries io.githubKeys beside io.checkpointInBackground, and it reads a member\'s keys exactly as the github front door\'s githubKeys does [C7,#12428]', async t => {
  const box = await fixture(t);
  const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOnlyATestKeyForTheCarryingCase';
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url === '/users/carrier/keys' ? [{ id: 1, key }, { id: 2, key: 'not a key' }] : []));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const seen = {};
  const original = COMMANDS.version;
  const previousApi = process.env.PULLBOARD_GITHUB_API;
  COMMANDS.version = async () => ({ run: async io => { seen.io = io; return 0; } });
  process.env.PULLBOARD_GITHUB_API = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    COMMANDS.version = original;
    if (previousApi === undefined) delete process.env.PULLBOARD_GITHUB_API; else process.env.PULLBOARD_GITHUB_API = previousApi;
    server.close();
  });
  const ran = await cli(box, box.seats.actor.path, ['version']);
  assert.equal(ran.code, 0, ran.out + ran.err);
  assert.equal(typeof seen.io.githubKeys, 'function', 'run.js puts githubKeys on the io object');
  assert.ok('checkpointInBackground' in seen.io, 'beside io.checkpointInBackground');
  assert.deepEqual(await seen.io.githubKeys('carrier'), [key]);
  assert.deepEqual(await seen.io.githubKeys('carrier'), await githubKeys('carrier'), 'the same answer the github front door gives');
});
