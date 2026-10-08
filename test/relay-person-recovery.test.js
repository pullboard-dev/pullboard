/** A second linked native device safely takes over an expired person request [H12,H16]. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { preparePersonRequest } from '../src/person-request.js';
import { personRequestRecords, personRequestStatuses } from '../src/relay-requests.js';
import { decodeBoardKey, seal } from '../src/seal.js';
import { relayClientFixture } from './relay-client-fixture.js';

const CLI = resolve(import.meta.dirname, '../bin/pullboard.js');
const BOARD_MODULE = pathToFileURL(resolve(import.meta.dirname, '../src/board.js')).href;
const EXCHANGE_MODULE = pathToFileURL(resolve(import.meta.dirname, '../src/exchange.js')).href;
const RELAY_MODULE = pathToFileURL(resolve(import.meta.dirname, '../src/relay.js')).href;
const CONFIG_MODULE = pathToFileURL(resolve(import.meta.dirname, '../src/config.js')).href;
const LANES_MODULE = pathToFileURL(resolve(import.meta.dirname, '../src/lanes.js')).href;

/** Run an isolated fixture child without copying its private output into assertion diagnostics. */
function child(cwd, env, argv) {
  return new Promise((done, fail) => {
    const processChild = spawn(process.execPath, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    const timer = setTimeout(() => processChild.kill('SIGKILL'), 25000);
    processChild.stdout.setEncoding('utf8').on('data', part => { stdout += part; });
    processChild.stderr.resume();
    processChild.once('error', error => { clearTimeout(timer); fail(error); });
    processChild.once('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) return fail(new Error('private request recovery child exceeded its deadline'));
      try { done({ code, document: JSON.parse(stdout) }); }
      catch { fail(new Error('private request recovery child did not return its result')); }
    });
  });
}

/** Invoke the production CLI in a chosen private checkout and home. */
function cli(root, env, ...args) { return child(root, env, [CLI, ...args, '--json']); }

/** Receive the browser-format request, elect one executor, and stop immediately after its claim. */
function claimOnly(root, env, requestId) {
  const source = `
    const root = process.cwd();
    const { syncRelay, relayRequestDevice, relayOperation } = await import(${JSON.stringify(RELAY_MODULE)});
    const { loadConfig } = await import(${JSON.stringify(CONFIG_MODULE)});
    const { laneNames } = await import(${JSON.stringify(LANES_MODULE)});
    const sink = { isTTY: false, write() {} };
    const io = { cwd: root, stdout: sink, stderr: sink, say() {}, err() {}, onEvent() {} };
    await syncRelay(root, io);
    const executor = await relayRequestDevice(root);
    const message = { from: 'person', to: 'coordinator', text: ${JSON.stringify(`View request ${requestId}: Received a request from the paired view.`)}, lanes: laneNames(loadConfig(root)) };
    const result = await relayOperation(root, 'shout', [message], {
      ...io,
      personRequest: { id: ${JSON.stringify(requestId)}, executor, phase: 'claim' },
      personRequestMoveId: 'recovery-' + ${JSON.stringify(requestId)} + '-' + executor,
    });
    process.stdout.write(JSON.stringify({ executor, result: Number.isSafeInteger(result) }));
  `;
  return child(root, env, ['--input-type=module', '-e', source]);
}

/** Export the private board directly so inspection cannot trigger another request-processing pass. */
async function privateExport(root, env) {
  const source = `
    const { openBoard, closeBoard } = await import(${JSON.stringify(BOARD_MODULE)});
    const { exportBoard } = await import(${JSON.stringify(EXCHANGE_MODULE)});
    const board = openBoard(${JSON.stringify(join(root, '.git', 'pullboard', 'board.sqlite'))});
    try { process.stdout.write(JSON.stringify(exportBoard(board))); } finally { closeBoard(board); }
  `;
  return (await child(root, env, ['--input-type=module', '-e', source])).document;
}

test('[H12,H16] an expired native executor lease transfers once and the old device cannot repeat the shout', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const key = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  const requestId = 'takeover-request-1';
  const intent = preparePersonRequest({ verb: 'shout', args: { to: 'coordinator', text: 'RECOVERY_SHOUT_ONCE' } }, requestId);
  const envelopeBytes = await seal(key, new TextEncoder().encode(JSON.stringify(intent)), {
    boardId: link.board, kind: 'request', sequence: 1,
  });
  const envelope = Buffer.from(envelopeBytes).toString('base64url');
  const posted = await fetch(box.origin + '/api/v1/boards/' + link.board + '/requests', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + link.token, 'content-type': 'application/json' },
    body: JSON.stringify({ sequence: 1, sealed: envelope }),
  });
  assert.equal(posted.status, 200, 'the relay accepts the browser-format sealed request through the fixture person session');
  assert.equal((await posted.json()).event.kind, 'request');

  const originalClaim = await claimOnly(box.root, box.env, requestId);
  assert.equal(originalClaim.code, 0);
  assert.equal(originalClaim.document.result, true);
  const originalExecutor = originalClaim.document.executor;

  // Import a real private export into a second Git repository, then provision an independent link
  // and the same board key. Removing the device id makes its first native command elect a new one.
  const secondRoot = resolve(box.root, '..', 'request-recovery-device');
  const secondHome = resolve(box.root, '..', 'request-recovery-home');
  mkdirSync(secondRoot);
  mkdirSync(secondHome, { mode: 0o700 });
  t.after(() => { rmSync(secondRoot, { recursive: true, force: true }); rmSync(secondHome, { recursive: true, force: true }); });
  const secondEnv = {
    ...box.env,
    HOME: secondHome,
    PULLBOARD_HOME: join(secondHome, '.pullboard'),
    PULLBOARD_MACHINE_HOME: join(secondHome, 'machine'),
  };
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: secondRoot, env: secondEnv }).status, 0);
  assert.equal((await cli(secondRoot, secondEnv, 'init')).code, 0);
  const snapshot = join(secondRoot, 'native-board.json');
  writeFileSync(snapshot, JSON.stringify(await privateExport(box.root, box.env)), { mode: 0o600 });
  assert.equal((await cli(secondRoot, secondEnv, 'import', snapshot)).code, 0);

  const secondState = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  delete secondState.requestDevice;
  const secondLinkFile = join(secondRoot, '.git', 'pullboard', 'relay.json');
  mkdirSync(join(secondRoot, '.git', 'pullboard'), { recursive: true, mode: 0o700 });
  writeFileSync(secondLinkFile, JSON.stringify(secondState) + '\n', { mode: 0o600 });
  const keyDirectory = join(secondEnv.PULLBOARD_HOME, 'relay-keys');
  mkdirSync(keyDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(keyDirectory, link.board + '.key'), readFileSync(box.keyFile), { mode: 0o600 });

  // Before the ten-minute lease expires, the independent device cannot run the request.
  assert.equal((await cli(secondRoot, secondEnv, 'status')).code, 0);
  const beforeExpiry = await privateExport(secondRoot, secondEnv);
  assert.equal(beforeExpiry.tables.shout.filter(row => row.shout_text === 'RECOVERY_SHOUT_ONCE').length, 0);
  let board = store.openBoard(join(secondRoot, '.git', 'pullboard', 'board.sqlite'));
  try { assert.equal(personRequestStatuses(board).find(record => record.id === requestId).status, 'waiting'); }
  finally { store.closeBoard(board); }

  box.advance(11 / 1440);
  assert.equal((await cli(secondRoot, secondEnv, 'status')).code, 0,
    'the next native command after expiry claims and executes through the production CLI');
  const afterTakeover = await privateExport(secondRoot, secondEnv);
  assert.equal(afterTakeover.tables.shout.filter(row => row.shout_text === 'RECOVERY_SHOUT_ONCE').length, 1);
  const secondExecutor = JSON.parse(readFileSync(secondLinkFile, 'utf8')).requestDevice;
  assert.ok(secondExecutor);
  assert.notEqual(secondExecutor, originalExecutor, 'the copied device link elects an independent native executor');
  board = store.openBoard(join(secondRoot, '.git', 'pullboard', 'board.sqlite'));
  try {
    const status = personRequestStatuses(board).find(record => record.id === requestId);
    assert.equal(status.status, 'done');
    assert.notEqual(personRequestRecords(board).find(record => record.id === requestId).executor, originalExecutor);
  } finally { store.closeBoard(board); }

  // The original device catches up to the committed execution, sees a terminal request, and cannot
  // emit a second person shout even though its native identity is still present in its link file.
  const late = await box.script(`
    const { main } = await import(${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../src/cli.js')).href)});
    const code = await main(['shout', 'coordinator', 'RECOVERY_SHOUT_ONCE', '--json'], {
      cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr, personChannel: 'view', skipPersonRequests: true,
      personRequest: { id: ${JSON.stringify(requestId)}, executor: ${JSON.stringify(originalExecutor)}, phase: 'execute' },
      personRequestMoveId: 'late-original-${originalExecutor}',
    });
    process.exitCode = code;
  `);
  assert.equal(late.code, 1, 'an explicitly retried late CLI stage refuses its terminal request');
  assert.equal(late.document.error.code, 'PERSON_REQUEST_CLOSED');
  assert.equal((await box.cli('status')).code, 0);
  const final = await privateExport(box.root, box.env);
  assert.equal(final.tables.shout.filter(row => row.shout_text === 'RECOVERY_SHOUT_ONCE').length, 1);
});
