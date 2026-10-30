/** @pullboard-test-loads src/board.js src/engine.js src/exchange.js src/person-signing.js relay/passkeys.js */
import { nativeBoardPorts as relayPresentationNativePorts } from '../src/native-board.js';
import { request as boardLinkRequest } from '../src/relay.js';
import {
  personSigningCase,
} from './person-signing-case.js';
import {
  submitFixture as submitBoardStateFixture,
} from './board-submit-fixture.js';
/** Two independent Git/SQLite replicas derive verdict freshness without rewriting proof [E8]. */
import {
  memberHandoverCase,
} from './handover-membership-case.js';
import {
  signedBoard,
  consent,
  linkRelay,
} from './board-link-fixture.js';
import {
  submitFixture,
  staleVerdictCheckFixture,
} from './board-submit-fixture.js';
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
import * as store from '../src/board.js';
import {
  fixtureBoard,
} from './board-fixture.js';
import {
  exportBoard,
  importBoard,
} from '../src/exchange.js';
import {
  applyEngineMove,
  prepareEngineMove,
} from '../src/engine.js';
import {
  relayClientFixture as sessionRelay,
  relayFixtureChild as sessionChild,
  relayClientFixture,
  relayFixtureChild,
} from './relay-client-fixture.js';
import {
  runFixtureChild,
  runFixtureGit as sessionGit,
  runFixtureGit,
} from './fixture-child.js';
import {
  grantChallenge,
  softwarePasskey,
} from './person-passkey-fixture.js';
import {
  optionalPasskeyApply,
  optionalPasskeyApplyThroughCli,
  rejectFabricatedPasskeyMetadata,
  rejectSyntheticPasskeyEvent,
} from './person-optional-apply-fixture.js';
import {
  rejectConsumedOffReplay,
} from './person-off-replay-fixture.js';
import {
  firstPinNeedsBuiltInRelay,
  firstUnpairedAuthorityInsertion,
} from './person-first-pin-fixture.js';
import {
  refuseNamedSigners,
} from '../src/person-signing-cli.js';
import {
  createE2eHelpers,
} from './e2e-helpers.js';
import {
  executeMove,
  serveApi,
} from '../src/api.js';
import { refusalDocument } from '../src/next-step-words.js';
import {
  main,
} from '../src/cli.js';
import {
  fetchFresh,
} from './http-fixture.js';
import {
  relaySnapshot,
  presentationDigest,
} from '../src/relay-presentation.js';
import {
  snapshotState,
} from '../relay/browser-model.js';
import {
  unpackRelease,
} from './release-archive.js';
import {
  decodeBoardKey,
  seal,
} from '../packages/kernel/src/core/seal.js';
import {
  ENGINE_VERSION as PEOPLE_VERSION,
} from '../src/machine.js';
import {
  relayWorkBudgetMs,
} from './relay-budget.js';
import {
  hostname,
  tmpdir,
} from 'node:os';
import {
  assertMatchingLandingHost,
  assertNoCulpritTrunkHold,
} from './landing-environment-fixture.js';
import {
  landingQueueCase,
} from './landing-queue-fixture.js';
import {
  privateBoardPath,
} from '../src/projects.js';
import {
  checkoutSessionFile,
} from '../src/agent-session.js';
import {
  repoInfo,
} from '../src/git.js';
import {
  privateBoardMoves,
} from './private-board-move-fixture.js';
import {
  DatabaseSync,
} from 'node:sqlite';
import {
  prepareKeylessInbox,
  readKeylessInbox,
  finishKeylessInbox,
} from './inbox-key-fixture.js';

/** Bind the real canonical presentation providers once for this fixture module. */
const RELAY_PRESENTATION_PORTS = relayPresentationNativePorts().presentation;

const CLI = join(import.meta.dirname, '..', 'bin', 'pullboard.js');
/** The shipped command run with an explicit trusted fixture relay; test-only, never published (#408). */
const TRUSTED_CLI = join(import.meta.dirname, 'person-trusted-cli.js');

const helpers = createE2eHelpers();
after(helpers.cleanup);







/** Open a fixture's independent board and always close it after its observation or public move. */
function withBoard(root, action) {
  const board = store.openBoard(join(root, '.git', 'pullboard', 'board.sqlite'));
  try { return action(board); }
  finally { store.closeBoard(board); }
}

/** Run a real fixture CLI command, retaining the refusal or successful document verbatim. */
function run(box, root, ...args) {
  const result = box.run(root, ...args);
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
} from ${JSON.stringify(new URL('../src/resources.js', import.meta.url).href)};
import {loadMachineSettings} from ${JSON.stringify(new URL('../src/settings.js', import.meta.url).href)};
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

/** Send one sealed person request with its passkey presence, returning the relay's answer. */
async function passkeyRequest(box, session, document, presence) {
  const link = JSON.parse(box.readLink());
  const head = await relayCall(box, session, 'GET', '/api/v2/boards/' + link.board + '/state');
  const events = await relayCall(box, session, 'GET', `/api/v1/boards/${link.board}/events?after=${head.document.state.sequence}`);
  const sequence = Math.max(head.document.state.sequence, ...(events.document.events ?? []).map((event) => event.event_id)) + 1;
  const key = decodeBoardKey(box.readKey().trim());
  const sealed = Buffer.from(await seal(key, new TextEncoder().encode(JSON.stringify(document)), { boardId: link.board, kind: 'request', sequence })).toString('base64url');
  return relayCall(box, session, 'POST', `/api/v1/boards/${link.board}/requests`, { sequence, sealed, ...(presence ? { presence } : {}) });
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
  assert.equal(box.run(repo, 'init').code, 0);
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
