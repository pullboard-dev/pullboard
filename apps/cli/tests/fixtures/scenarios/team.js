/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js src/person-signing.js apps/relay/src/io/passkeys.js */
import {
  nativeBoardPorts as relayPresentationNativePorts,
  openBoard,
} from '../../../../lib/index.js';
import { request as boardLinkRequest } from '../../../../../packages/link/index.js';
import {
  personSigningCase,
} from '../person/signing.js';
import {
  submitFixture as submitBoardStateFixture,
} from '../board/submit.js';
/** Two independent Git/SQLite replicas derive verdict freshness without rewriting proof [E8]. */
import {
  memberHandoverCase,
} from '../membership.js';
import {
  signedBoard,
  consent,
  linkRelay,
} from '../board/link.js';
import {
  submitFixture,
  staleVerdictCheckFixture,
} from '../board/submit.js';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {
  syncBuiltinESMExports,
} from 'node:module';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
  lstatSync,
  renameSync,
  symlinkSync,
} from 'node:fs';
import {
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import {
  join,
  resolve,
} from 'node:path';
import {
  pathToFileURL,
} from 'node:url';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import {
  fixtureBoard,
} from '../board.js';
import {
  exportBoard,
  importBoard,
} from '../../../../../packages/store/index.js';
import {
  applyEngineMove,
  prepareEngineMove,
} from '../../../../../packages/state/index.js';
import {
  relayClientFixture as sessionRelay,
  relayFixtureChild as sessionChild,
  relayClientFixture,
  relayFixtureChild,
} from '../relay/client.js';
import {
  runFixtureChild,
  runFixtureGit as sessionGit,
  runFixtureGit,
} from '../child.js';
import {
  grantChallenge,
  softwarePasskey,
} from '../person/passkey.js';
import {
  optionalPasskeyApply,
  optionalPasskeyApplyThroughCli,
  rejectFabricatedPasskeyMetadata,
  rejectSyntheticPasskeyEvent,
} from '../person/apply.js';
import {
  rejectConsumedOffReplay,
} from '../person/replay.js';
import {
  firstPinNeedsBuiltInRelay,
  firstUnpairedAuthorityInsertion,
} from '../person/pin.js';
import {
  refuseNamedSigners,
} from '../../../../../packages/person/index.js';
import {
  createE2eHelpers,
  JOURNEY_MODE,
  parityRecord,
} from '../e2e.js';
import { appendFileSync } from 'node:fs';
import { settleLand } from '../land/settle.js';
import { settleSubmit } from '../submit/settle.js';
import {
  executeMove,
  serveApi,
} from '../../../../../packages/api/index.js';
import { refusalDocument } from '../../../index.js';
import {
  main,
} from '../../../index.js';
import {
  fetchFresh,
} from '../http.js';
import {
  relaySnapshot,
  presentationDigest,
} from '../../../../../packages/pages/index.js';
import {
  snapshotState,
} from '../../../../relay/index.js';
import {
  unpackRelease,
} from '../../../../../packages/gate/tests/fixtures/release/archive.js';
import {
  decodeBoardKey,
  seal,
} from '../../../../../packages/kernel/index.js';
import {
  ENGINE_VERSION as PEOPLE_VERSION,
} from '../../../../../packages/state/index.js';
import {
  relayWorkBudgetMs,
} from '../relay/budget.js';
import {
  hostname,
  tmpdir,
} from 'node:os';
import {
  assertMatchingLandingHost,
  assertNoCulpritTrunkHold,
  assertTrunkHoldCorrection,
} from '../landing/environment.js';
import {
  landingQueueCase,
} from '../landing/queue.js';
import {
  privateBoardPath,
} from '../../../../../packages/seats/index.js';
import {
  checkoutSessionFile,
} from '../../../../../packages/seats/index.js';
import { repoInfo } from '../../../../../packages/git/index.js';
import {
  privateBoardMoves,
} from '../move.js';
import {
  DatabaseSync,
} from 'node:sqlite';
import {
  prepareKeylessInbox,
  readKeylessInbox,
  finishKeylessInbox,
} from '../key.js';

/** Bind the real canonical presentation providers once for this fixture module. */
const RELAY_PRESENTATION_PORTS = relayPresentationNativePorts().presentation;

const CLI = join(import.meta.dirname, '../../../pullboard.js');
/** The shipped command run with an explicit trusted fixture relay; test-only, never published (#408). */
const TRUSTED_CLI = join(import.meta.dirname, '../person/trusted.js');

const helpers = createE2eHelpers();
after(helpers.cleanup);







/** Open a fixture's independent board and always close it after its observation or public move. */
function withBoard(root, action) {
  // @pullboard-board-file persistence: observe the linked fixture board after real CLI and device moves.
  const board = openBoard(join(root, '.git', 'pullboard', 'board.sqlite'));
  try { return action(board); }
  finally { store.closeBoard(board); }
}

/** Commands that stay a real process: they settle pulled jobs or can outlast the worker thread's 45 s wait, or the call is about argv and start-up. */
const REAL_PROCESS = new Set(['submit', 'verify', 'land', 'test', 'resume', 'tour', 'version']);

/**
 * One sync fixture call: answered by the box's warm worker thread, or a real process when the command is in REAL_PROCESS, the call
 * asks for --help, or PULLBOARD_JOURNEY_MODE=process. Appends a parity record for the call when PULLBOARD_PARITY_RECORD is set [C7,U149].
 */
function quick(box, root, ...args) {
  const real = JOURNEY_MODE === 'process' || typeof box.runSync !== 'function' || REAL_PROCESS.has(args[0]) || args.includes('--help');
  const result = real ? box.run(root, ...args) : box.runSync(root, ...args);
  if (process.env.PULLBOARD_PARITY_RECORD) appendFileSync(process.env.PULLBOARD_PARITY_RECORD, `${JSON.stringify(parityRecord({ dir: box.dir, env: box.env, cwd: root, args, result: { ...result, status: result.code, stdout: result.out, stderr: result.err } }))}\n`);
  return result;
}

/** Commands that run through the box's in-process dispatcher and settle their pulled runner job before they answer [C7,#10464]. */
const SETTLED_STEPS = new Set(['submit', 'verify', 'land']);
/** Local runners a settled submit started; stopped when the file ends, as settleSubmit's test context would. */
const startedRunners = [];
after(() => { for (const stop of startedRunners.splice(0)) stop(); });

/**
 * One submit, verify or land through the production dispatcher in this process, refused unless it exits 0.
 * Why: each as its own node process cost a start-up; a submit waits for its gate job (settleSubmit) and a land for its receipt (settleLand), as #10411 did for repair-landing [C7,#10464].
 * Returns the command's output text, with the settled document for submit and land.
 */
async function settledStep(box, root, args) {
  const json = args[0] !== 'verify' && !args.includes('--json') ? [...args, '--json'] : args;
  const result = await box.runIn(root, ...json);
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}${result.out}`);
  if (args[0] === 'verify') return result.out;
  const document = JSON.parse(result.out);
  const settled = args[0] === 'submit' ? await settleSubmit({ after: stop => startedRunners.push(stop) }, box, document) : await settleLand(box, document);
  return JSON.stringify(settled);
}

/** Run a fixture CLI command, retaining the refusal or successful document verbatim; submit, verify and land answer as a promise. */
function run(box, root, ...args) {
  if (SETTLED_STEPS.has(args[0]) && typeof box.runIn === 'function' && !args.includes('--help')) return settledStep(box, root, args);
  const result = quick(box, root, ...args);
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}${result.out}`);
  return result.out;
}


/** Occupy this fixture's actual gate until its stale re-review enters the ordinary queue. */
async function holdForReviewQueue(box) {
  const ready = join(box.dir, 'review-gate-held');
  const observed = join(box.dir, 'review-was-queued');
  const source = `
import {setTimeout as pause} from 'node:timers/promises';
import {writeFileSync} from 'node:fs';
import {
  takeResource,
  listResources,
} from ${JSON.stringify(new URL('../../../../../packages/resources/index.js', import.meta.url).href)};
import {loadMachineSettings} from ${JSON.stringify(new URL('../../../../../packages/config/src/io/settings.js', import.meta.url).href)};
const [root,ready,observed]=process.argv.slice(1);
const capacity=loadMachineSettings().gateSlots;
const leases=[];
let stopping=false;
process.once('SIGTERM',()=>{stopping=true;});
try {
  for(let i=0;i<capacity;i++) leases.push(await takeResource({name:'gate',capacity,scope:'machine',root,agent:'stale-review-fixture-holder',browser:false}));
  writeFileSync(ready,'all ordinary slots really held');
  const deadline=Date.now()+30_000;
  while(!stopping) {
    const gate=listResources({root}).find(entry=>entry.name==='gate');
    if(gate?.line.some(entry=>entry.item==='1'&&entry.kind==='review')) {writeFileSync(observed,'the real review waiter was observed');break;}
    if(Date.now()>=deadline) throw Error('the stale review never entered the actual private gate queue');
    await pause(20);
  }
} finally {for(const lease of leases.reverse()) lease.release();}
`;
  const holder = helpers.launch(box, box.repo, process.execPath, ['--input-type=module', '-e', source, box.repo, ready, observed]);
  const deadline = Date.now() + 10_000;
  try {
    while (!existsSync(ready)) {
      assert.equal(holder.exitCode, null, holder.failure ?? holder.stderrText);
      assert.ok(Date.now() < deadline, 'the real private gate holder becomes ready');
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
  } catch (error) {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGTERM');
    await holder.closed;
    throw error;
  }
  return { holder, observed };
}







/** A person's own session, through the stand-in GitHub's real OAuth, signed in as `login`. */
async function personSession(box, login) {
  box.providerState.signer = login;
  try {
    const start = await fetch(box.origin + '/auth/github/start', { redirect: 'manual' });
    const binding = start.headers.getSetCookie().find((value) => value.startsWith('pb_oauth_binding=')).split(';')[0];
    const approved = await fetch(start.headers.get('location'), { redirect: 'manual' });
    const callback = await fetch(approved.headers.get('location'), { redirect: 'manual', headers: { cookie: binding } });
    assert.equal(callback.status, 303, `${login} signs in`);
    return callback.headers.getSetCookie().find((value) => value.startsWith('pb_session=')).split(';')[0].slice('pb_session='.length);
  } finally { box.providerState.signer = 'alice'; }
}

/** Call the relay as one credential, returning the status and document. */
async function relayCall(box, token, method, path, body) {
  const response = await fetch(box.origin + path, { method, headers: { authorization: 'Bearer ' + token, 'x-pullboard-engine': String(PEOPLE_VERSION),
    ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  let document = null;
  try { document = await response.json(); } catch { /* An empty answer stays null. */ }
  return { status: response.status, document };
}

/** Seal one phone request the way the paired view does and send it with this person's session. */
async function phoneRequest(box, session, move) {
  const link = JSON.parse(box.readLink());
  const head = await relayCall(box, session, 'GET', '/api/v2/boards/' + link.board + '/state');
  assert.equal(head.status, 200, `this person reads the board: ${JSON.stringify(head.document)}`);
  const events = await relayCall(box, session, 'GET', `/api/v1/boards/${link.board}/events?after=${head.document.state.sequence}`);
  const sequence = Math.max(head.document.state.sequence, ...(events.document.events ?? []).map((event) => event.event_id)) + 1;
  const document = { version: 1, type: 'person-request', id: randomUUID(), move };
  const key = decodeBoardKey(box.readKey().trim());
  const sealed = Buffer.from(await seal(key, new TextEncoder().encode(JSON.stringify(document)), { boardId: link.board, kind: 'request', sequence })).toString('base64url');
  const sent = await relayCall(box, session, 'POST', `/api/v1/boards/${link.board}/requests`, { sequence, sealed });
  assert.equal(sent.status, 200, `the relay stores the sealed request: ${JSON.stringify(sent.document)}`);
  return document.id;
}

/** The phone requests this board has received, by id, read through `run` (a test may pass its trusted command). */
async function receivedRequests(box, run = (...args) => box.cli(...args)) {
  assert.equal((await run('status')).code, 0, 'the coordinator reads the relay');
  const meta = (await run('export')).document.tables.board_meta.find((row) => row.meta_key === 'relay_person_requests');
  return Object.fromEntries((meta ? JSON.parse(meta.meta_value) : []).map((record) => [record.id, record]));
}

/** Two people with write access to the fixture repository, alice and bob, and alice's linked board. */
async function teamBoard(t, approvers) {
  const box = await relayClientFixture(t);
  Object.assign(box.providerState, { people: { alice: { id: 7, permission: 'write' }, bob: { id: 8, permission: 'write' } }, signer: 'alice' });
  if (approvers) {
    const file = join(box.root, 'pullboard.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), approvers }, null, 2) + '\n');
    runFixtureGit(['add', 'pullboard.json'], { cwd: box.root, env: box.env });
    runFixtureGit(['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'chore: name the approvers'], { cwd: box.root, env: box.env });
  }
  assert.equal((await box.link()).code, 0, 'alice links the board, signed in as herself');
  return box;
}




/** Another computer of a person: its own HOME, ~/.ssh and a fresh clone of the fixture repository. */
function memberDevice(t, box, name) {
  const home = join(box.root, '..', name + '-home');
  const root = join(box.root, '..', name + '-clone');
  mkdirSync(join(home, '.ssh'), { recursive: true, mode: 0o700 });
  runFixtureGit(['clone', '-q', box.root, root], { cwd: box.root, env: box.env });
  runFixtureGit(['remote', 'set-url', 'origin', 'git@github.com:fixture/repository.git'], { cwd: root, env: box.env });
  const env = { ...box.env, HOME: home, PULLBOARD_HOME: join(home, '.pullboard'), PULLBOARD_MACHINE_HOME: join(home, 'machine') };
  delete env.PULLBOARD_MODEL;
  delete env.PULLBOARD_SSH_KEY; // A separate computer cannot inherit Alice’s private signing-key path.
  const device = { root, env, home, cli: (...args) => relayFixtureChild(root, env, [CLI, ...args, '--json']) };
  /** Generate this device's SSH key, as ssh-keygen -t ed25519 does, and return its public line. */
  device.sshKey = () => {
    const made = childProcess.spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', join(home, '.ssh', 'id_ed25519')], { env, encoding: 'utf8' });
    assert.equal(made.status, 0, `ssh-keygen makes the device's key: ${made.stderr}`);
    return readFileSync(join(home, '.ssh', 'id_ed25519.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ');
  };
  /** Start a command that waits, and resolve said(text) once its stderr carries text. */
  device.start = (...args) => {
    const child = childProcess.spawn(process.execPath, [CLI, ...args, '--json'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const waiting = [];
    child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part; });
    child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part; for (const waiter of [...waiting]) waiter(); });
    const closed = new Promise((resolve) => child.once('close', (code) => {
      let document;
      try { document = JSON.parse(stdout); } catch { document = null; }
      for (const waiter of [...waiting]) waiter();
      resolve({ code, stderr, document });
    }));
    t.after(() => child.kill('SIGKILL'));
    /** Resolve once stderr carries the text, or the command has closed. */
    const said = (text) => new Promise((resolve) => {
      const check = () => { if (stderr.includes(text) || child.exitCode !== null) { waiting.splice(waiting.indexOf(check), 1); resolve(stderr.includes(text)); } };
      waiting.push(check);
      check();
    });
    return { closed, said };
  };
  return device;
}



/** Every file under a directory, so a test can prove no secret was written anywhere in it. */
function filesUnder(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? filesUnder(join(directory, entry.name)) : [join(directory, entry.name)]);
}


/** A file's permission bits. */
function statSyncMode(file) { return lstatSync(file).mode & 0o777; }



/** Simulate a long holder and polling waiter on an in-memory board with its injected clock. */

/** Send one sealed person request with its passkey presence, retrying only a sequence collision because another client may append between reading and posting. */
async function passkeyRequest(box, session, document, presence) {
  const link = JSON.parse(box.readLink());
  const key = decodeBoardKey(box.readKey().trim());
  let response;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const head = await relayCall(box, session, 'GET', '/api/v2/boards/' + link.board + '/state');
    const events = await relayCall(box, session, 'GET', `/api/v1/boards/${link.board}/events?after=${head.document.state.sequence}`);
    const sequence = Math.max(head.document.state.sequence, ...(events.document.events ?? []).map((event) => event.event_id)) + 1;
    const sealed = Buffer.from(await seal(key, new TextEncoder().encode(JSON.stringify(document)), { boardId: link.board, kind: 'request', sequence })).toString('base64url');
    response = await relayCall(box, session, 'POST', `/api/v1/boards/${link.board}/requests`, { sequence, sealed, ...(presence ? { presence } : {}) });
    if (!['SEQUENCE_REPEAT', 'SEQUENCE_GAP'].includes(response.document?.error?.code)) return response;
  }
  return response;
}

/** True when no regular file under a directory holds a person session or a person grant. */
function holdsNoPersonCredential(box, directory) {
  return box.privateTreeBytes(directory).every(bytes => !/(?:ps_|pg_)[A-Za-z0-9_-]{43}/u.test(bytes.toString('latin1')));
}


/** Keep the initial-unpaired local-edit clause distinct from the post-pin trigger controls. */


/** Optional SSH policy must accept a genuinely bound passkey row decision without using an SSH key. */

/** The actual CLI applies and projects the recorded passkey approval even with optional SSH enabled. */

/** Initial trust and committed execution provenance are separate signing boundaries. */

/** A local event insertion is not an authenticated execution of a different row source. */

/** Cross-repository prerequisites use real signed E32 disclosure and never a same-number local item [B24,H16]. */

/** Initialise a second repo in the first one's sandbox, so both register in the same machine home. */
function siblingRepo(box, name, project) {
  const repo = join(box.dir, name);
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  assert.equal(quick(box, repo, 'init').code, 0);
  return { repo, project };
}

/** Put a repo into a named project under its own name, committed so the board reads it. */
function nameRepo(box, repo, name, project) {
  const file = join(repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, name, project }, null, 2));
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: name the repo');
}





/** Original shared fixture bindings; no test registration is hidden in this module. */
export {
  refusalDocument,
  RELAY_PRESENTATION_PORTS,
  boardLinkRequest,
  CLI,
  TRUSTED_CLI,
  after,
  applyEngineMove,
  assert,
  assertMatchingLandingHost,
  assertNoCulpritTrunkHold,
  assertTrunkHoldCorrection,
  childProcess,
  consent,
  existsSync,
  exportBoard,
  fetchFresh,
  filesUnder,
  finishKeylessInbox,
  firstPinNeedsBuiltInRelay,
  firstUnpairedAuthorityInsertion,
  fixtureBoard,
  helpers,
  holdForReviewQueue,
  holdsNoPersonCredential,
  hostname,
  importBoard,
  landingQueueCase,
  linkRelay,
  lstatSync,
  main,
  memberDevice,
  memberHandoverCase,
  mkdirSync,
  nameRepo,
  optionalPasskeyApply,
  optionalPasskeyApplyThroughCli,
  passkeyRequest,
  pathToFileURL,
  personSession,
  personSigningCase,
  phoneRequest,
  prepareEngineMove,
  prepareKeylessInbox,
  presentationDigest,
  privateBoardMoves,
  privateBoardPath,
  randomBytes,
  randomUUID,
  readKeylessInbox,
  readdirSync,
  receivedRequests,
  rejectConsumedOffReplay,
  rejectFabricatedPasskeyMetadata,
  rejectSyntheticPasskeyEvent,
  relayCall,
  relayClientFixture,
  relayFixtureChild,
  relaySnapshot,
  relayWorkBudgetMs,
  renameSync,
  rmSync,
  run,
  runFixtureChild,
  runFixtureGit,
  serveApi,
  sessionChild,
  sessionGit,
  sessionRelay,
  siblingRepo,
  signedBoard,
  snapshotState,
  staleVerdictCheckFixture,
  statSyncMode,
  store,
  submitFixture,
  symlinkSync,
  syncBuiltinESMExports,
  teamBoard,
  test,
  unpackRelease,
  withBoard,
  writeFileSync,
};
