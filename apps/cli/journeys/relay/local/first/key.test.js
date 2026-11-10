/** @pullboard-test-input source-tree */
/** Local-first reads retain device-key repair diagnostics without networking or taking relay locks [H17,H21]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import '../../../../tests/fixtures/native.js'; // The child exercises this public entry point; retain its affected-test dependency.
import { outboxGuardFile } from '../../../../../../packages/outbox/index.js';
import {
  runFixtureChildAsync,
  runFixtureGit,
} from '../../../../tests/fixtures/child.js';
import { relayClientFixture } from '../../../../tests/fixtures/relay/client.js';

const CLI = fileURLToPath(new URL('../../../../pullboard.js', import.meta.url));
const WORKER = fileURLToPath(new URL('../../../../src/io/sender.js', import.meta.url));
const MAIN = new URL('../../../../tests/fixtures/native.js', import.meta.url).href;

/** Read only the PID/start/command identity of this fixture's already identified worker. */
function identity(pid) {
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'lstart=,command='], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
}

/** Wait only for a private worker lifecycle condition, never to satisfy an asserted latency. */
async function waitFor(ready) {
  const deadline = Date.now() + 5000; // budget: fixture worker startup/termination hang ceiling.
  while (Date.now() < deadline) {
    if (ready()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('the private sender did not reach its lifecycle barrier');
}

/** Stop only the exact private worker observed at startup, before the fixture removes its own files. */
async function stopWorker(worker) {
  if (!worker.pid) return;
  const current = identity(worker.pid);
  if (!current) return;
  assert.equal(current, worker.identity, 'a reused PID must never be signalled');
  assert.ok(current.includes(WORKER), 'only this checkout’s private sender is eligible for cleanup');
  assert.equal(identity(worker.pid), current, 'recheck exact identity immediately before signalling');
  process.kill(worker.pid, 'SIGTERM');
  await waitFor(() => !identity(worker.pid));
}

/** Run real commands in one foreground process, with no inherited environment-token or background-disable shortcut. */
async function commands(box, env, preload, argv) {
  const source = `
    const { main } = await import(${JSON.stringify(MAIN)});
    const outcomes = [];
    for (const args of ${JSON.stringify(argv)}) {
      let output = '';
      const code = await main([...args, '--json'], { cwd: process.cwd(),
        stdout: { isTTY: false, write(value) { output += value; } }, stderr: { write() {} }, stdin: process.stdin });
      outcomes.push({ code, document: JSON.parse(output) });
    }
    process.stdout.write(JSON.stringify(outcomes));
  `;
  const result = await runFixtureChildAsync(process.execPath, ['--import', preload, '--input-type=module', '-e', source], { cwd: box.root, env });
  assert.equal(result.status, 0, result.context);
  return JSON.parse(result.stdout);
}

/** Verify the same public diagnostic contract for a missing key and a genuinely unreadable private key file. */
async function keyDiagnostic(t, mode) {
  t.diagnostic(JSON.stringify({ node: process.version, host: hostname(), execPath: process.execPath,
    binarySha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex') }));
  const worker = {};
  t.after(() => stopWorker(worker)); // Registered before the fixture’s own directory cleanup.
  const box = await relayClientFixture(t);
  const configFile = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  // Primary policy is read from Git; the fixture commits its config, so only a changed config needs a new commit.
  writeFileSync(join(box.env.PATH, 'pullboard'), `#!/bin/sh\nexec node "${CLI}" "$@"\n`, { mode: 0o700 });
  if (Object.hasOwn(config.relay ?? {}, 'outbox')) {
    delete config.relay.outbox;
    writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
    runFixtureGit(['add', 'pullboard.json'], { cwd: box.root, env: box.env });
    runFixtureGit(['commit', '-q', '-m', 'chore(config): exercise local-first default'], { cwd: box.root, env: box.env });
  }
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(configFile, 'utf8')).relay ?? {}, 'outbox'), false, 'the board uses the absent-setting default');
  await box.link();
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  assert.equal(state.baselineAccepted, true);
  assert.ok(state.agentTokens?.coordinator, 'the fixture uses its ordinary saved agent credential');
  assert.equal(Object.hasOwn(config.relay ?? {}, 'outbox'), false, 'the committed board uses the production default rather than an explicit setting');
  const env = { ...box.env };
  delete env.PULLBOARD_RELAY_SENDER_BACKGROUND;
  delete env.PULLBOARD_RELAY_TOKEN;
  delete env.PULLBOARD_RELAY_KEY;
  assert.equal(Object.hasOwn(env, 'PULLBOARD_RELAY_SENDER_BACKGROUND'), false);
  const lock = box.linkFile + '.lock';
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, 'pid'), String(process.pid));
  t.after(() => rmSync(lock, { recursive: true, force: true }));
  const warm = await runFixtureChildAsync(process.execPath, [CLI, 'status', '--json'], { cwd: box.root, env });
  assert.equal(warm.status, 0, warm.context);
  const pidFile = join(env.PULLBOARD_HOME, 'relay-sender', 'sender.pid');
  await waitFor(() => existsSync(pidFile));
  worker.pid = Number(readFileSync(pidFile, 'utf8'));
  worker.identity = identity(worker.pid);
  assert.ok(worker.identity.includes(WORKER), 'the real nudge started this fixture’s sender');
  if (mode === 'missing') rmSync(box.keyFile);
  else {
    chmodSync(box.keyFile, 0o000);
    t.after(() => { if (existsSync(box.keyFile)) chmodSync(box.keyFile, 0o600); });
    assert.throws(() => readFileSync(box.keyFile), { code: 'EACCES' }, 'the fixture key is actually unreadable');
  }
  const credentialTrace = join(dirname(box.root), 'foreground-credential-helper');
  // A private executable records attempts without contacting any real credential service or delaying the read.
  for (const helper of ['security', 'secret-tool']) {
    writeFileSync(join(box.env.PATH, helper), `#!/bin/sh\nprintf 'attempt\\n' >> '${credentialTrace}'\nexit 1\n`, { mode: 0o700 });
  }
  const trace = join(dirname(box.root), 'foreground-network');
  const preload = join(dirname(box.root), 'foreground-network.mjs');
  writeFileSync(preload, `
    import { appendFileSync } from 'node:fs';
    import http from 'node:http';
    import https from 'node:https';
    import net from 'node:net';
    import tls from 'node:tls';
    /** Record only an attempted transport kind, never a URL, body or credential. */
    const blocked = kind => { appendFileSync(${JSON.stringify(trace)}, kind + '\\n'); throw new Error('unexpected foreground network'); };
    globalThis.fetch = async () => blocked('fetch');
    http.request = () => blocked('http'); https.request = () => blocked('https');
    net.connect = () => blocked('net'); net.Socket.prototype.connect = function () { return blocked('socket'); };
    tls.connect = () => blocked('tls');
  `);
  const boardFile = join(box.root, '.git/pullboard/board.sqlite');
  /** Read immutable fixture history without opening a write-capable connection. */
  const history = () => {
    const db = new DatabaseSync(boardFile, { readOnly: true });
    try { return db.prepare('SELECT * FROM event ORDER BY event_id').all().map(row => ({ ...row })); }
    finally { db.close(); }
  };
  const before = history();
  const guard = new DatabaseSync(outboxGuardFile(box.linkFile));
  guard.exec('BEGIN EXCLUSIVE');
  let reads;
  try { reads = await commands(box, env, preload, [['status'], ['list', '--all'], ['show', '1']]); }
  finally { guard.exec('COMMIT'); guard.close(); }
  assert.equal(existsSync(credentialTrace), false, 'local-read diagnostics never invoke a credential helper');
  for (const result of reads) {
    assert.equal(result.code, 0, 'a missing device key cannot take away local reads');
    assert.equal(result.document.diagnostics?.length, 1, 'pre/post sync emits exactly one repair diagnostic per command');
    assert.match(result.document.diagnostics[0], mode === 'missing' ? /board key is missing/u : /board key is unreadable.*EACCES/u);
    assert.match(result.document.diagnostics[0], /moves are off until the key is reachable/u);
    assert.match(result.document.diagnostics[0], /run this command where the key is available, or pair this device/u);
  }
  assert.equal(existsSync(trace), false, 'no foreground HTTP, fetch, socket or TLS call was attempted');
  assert.deepEqual(history(), before, 'local reads append no native event');
  const marker = 'keyless move must never become an outbox';
  const moves = await commands(box, env, preload, [['add', box.lane, marker], ['shout', 'all', marker]]);
  for (const result of moves) {
    assert.equal(result.code, 1);
    assert.equal(result.document.error.code, 'RELAY_KEY_MISSING');
  }
  assert.deepEqual(history(), before, 'refused keyless moves append no native event');
  assert.equal(existsSync(trace), false, 'refused moves also attempt no foreground network');
  assert.equal(existsSync(join(dirname(box.linkFile), 'relay-outbox.sealed')), false, 'no encrypted outbox entry is queued without a key');
  for (const name of readdirSync(dirname(box.linkFile)).filter(name => name.startsWith('relay-outbox'))) {
    assert.equal(readFileSync(join(dirname(box.linkFile), name)).includes(marker), false, 'no plaintext outbox carries the refused move');
  }
}

test('local-first saved-credential reads report a missing fixture key once without network or relay locks [H17,H21]', t => keyDiagnostic(t, 'missing'));
test('local-first saved-credential reads report an unreadable fixture key once without network or relay locks [H17,H21]', t => keyDiagnostic(t, 'unreadable'));
