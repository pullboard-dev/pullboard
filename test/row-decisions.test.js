/** Person-authored row decisions stay on the board until a coordinator applies them [B26,S18,S19,C7]. */
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { parseSpec } from '../src/spec.js';
import { AGENT_SHELL_MARKERS, SSH_SHELL_MARKERS } from '../src/person.js';
import { fetchFresh } from './http-fixture.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const SPEC_FILE = 'SPEC.md';
const DOCTRINE_FILE = 'DOCTRINE.md';
const TEMP_DIRS = [];
const BASE_SPEC = `# Row decision fixture

## G · Goals
- G1 [draft, must] Approve this row. | gate: true | serves: G3
- G2 [draft, aim] Decline this row. | gate: true
- G3 [approved, must] Keep this unaffected row. | gate: true
`;
const BASE_DOCTRINE = `# Repo doctrine

## L · Local
- L1 [draft] Approve this doctrine row. | gate: true
`;
const FIXTURE_GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Row decision fixture',
  GIT_AUTHOR_EMAIL: 'row-decision@example.invalid',
  GIT_COMMITTER_NAME: 'Row decision fixture',
  GIT_COMMITTER_EMAIL: 'row-decision@example.invalid',
};

/** Remove each private fixture after child processes have been stopped. */
function cleanup() {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
}

after(cleanup);

/** Remove inherited Git selectors and every recognized agent-shell marker from a copy. */
function personEnvironment(source) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') || AGENT_SHELL_MARKERS.includes(key) || SSH_SHELL_MARKERS.includes(key)) delete env[key];
  }
  return env;
}

/** Quote one shell word for the private Pullboard hook shim. */
function shellWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Build a private real-Git fixture with isolated user and machine homes. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-row-decisions-'));
  TEMP_DIRS.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = personEnvironment({
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: join(dir, 'home'),
    PULLBOARD_HOME: join(dir, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
  });
  Object.assign(env, FIXTURE_GIT_ENV);
  /** Run Git with the fixture's private identity and configuration. */
  function git(cwd, ...args) {
    return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  }
  /** Run the real CLI with a clean person environment and optional explicit markers. */
  function run(cwd, args, extraEnv = {}) {
    return spawnSync(process.execPath, [BIN, ...args], {
      cwd, env: { ...personEnvironment(env), ...FIXTURE_GIT_ENV, ...extraEnv }, encoding: 'utf8', timeout: 15_000,
    });
  }
  return { dir, env, git, run };
}

test('[C7] the private runner keeps Git identity detection disabled after fixtures strip GIT_* variables', () => {
  const box = sandbox();
  const root = join(box.dir, 'guard-repo');
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  const env = {
    ...personEnvironment(box.env),
    HOME: join(box.dir, 'empty-home'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  delete env.EMAIL;
  const result = spawnSync('git', ['var', 'GIT_AUTHOR_IDENT'], { cwd: root, env, encoding: 'utf8' });
  assert.notEqual(result.status, 0, 'the runner shim refuses Git auto-detection with a new HOME and no inherited identity');
  assert.match(result.stderr, /auto-detection is disabled/u);
});

/** Initialize and commit a real repo with SPEC, DOCTRINE, an SQLite board and private lanes. */
function project({ spec = BASE_SPEC, doctrine = BASE_DOCTRINE } = {}) {
  const box = sandbox();
  mkdirSync(join(box.dir, 'repo'));
  const root = realpathSync(join(box.dir, 'repo'));
  box.git(root, 'init', '-q', '-b', 'main');
  const initialized = box.run(root, ['init']);
  assert.equal(initialized.status, 0, `${initialized.stdout}${initialized.stderr}`);
  const configFile = join(root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, `${JSON.stringify({
    ...config,
    gate: 'true',
    spec: SPEC_FILE,
    practice: DOCTRINE_FILE,
    lanes: { web: { owns: ['web/'], specs: ['G'] }, review: { owns: [], specs: ['G'] } },
    shared: [],
  }, null, 2)}\n`);
  mkdirSync(join(root, 'web'));
  writeFileSync(join(root, SPEC_FILE), spec);
  writeFileSync(join(root, DOCTRINE_FILE), doctrine);
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', 'chore: set up row decision fixture');
  const fixture = { ...box, root };
  fixture.web = addWorktree(fixture, 'web', 'web/one');
  return fixture;
}

/** Create a real joined agent checkout so its identity cannot be inferred from a spoofable flag. */
function addWorktree(box, lane, branch) {
  const path = join(box.dir, lane);
  box.git(box.root, 'worktree', 'add', '-q', path, '-b', branch);
  const joined = box.run(path, ['join', lane]);
  assert.equal(joined.status, 0, `${joined.stdout}${joined.stderr}`);
  return path;
}

/** Run an ordinary terminal or agent CLI command with optional environment markers. */
function command(box, cwd, ...args) {
  const { extraEnv = {} } = args.at(-1) ?? {};
  const actualArgs = args.at(-1)?.extraEnv ? args.slice(0, -1) : args;
  return box.run(cwd, actualArgs, extraEnv);
}

/** Read the event count from the private SQLite file without opening or migrating the board. */
function eventCount(box) {
  const db = new DatabaseSync(join(box.root, '.git', 'pullboard', 'board.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT COUNT(*) AS count FROM event').get().count; }
  finally { db.close(); }
}

/** Read and parse a row from the real project source file. */
function sourceRow(box, file, id) {
  const parsed = parseSpec(readFileSync(join(box.root, file), 'utf8'));
  const row = parsed.rows.find((entry) => entry.id === id);
  assert.ok(row, `${id} remains in ${file}`);
  return row;
}

/** Start the private real view with clean person credentials and expose authenticated requests. */
async function startView(t, box, extraEnv = {}) {
  const child = spawn(process.execPath, [BIN, 'view', '--no-open', '--port', '0', '--json'], {
    cwd: box.root, env: { ...personEnvironment(box.env), ...extraEnv, CODEX_SHELL: 'private-agent-view-host' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderrTail = [];
  let stderrPartial = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8').on('data', (part) => {
    const lines = (stderrPartial + part).split(/\r?\n/);
    stderrPartial = lines.pop() ?? '';
    if (stderrPartial.length > 2048) stderrPartial = `[truncated stderr line] ${stderrPartial.slice(-2048)}`;
    stderrTail.push(...lines.map((line) => line.length > 2048 ? `[truncated stderr line] ${line.slice(-2048)}` : line));
    if (stderrTail.length > 20) stderrTail = stderrTail.slice(-20);
  });
  let spawnError = null;
  const closed = new Promise((resolveClose) => {
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, signal) => resolveClose({ code, signal, error: spawnError }));
  });
  /** Wait for the child process to close, including when it was stopped by a signal. */
  function waitForClose() {
    return closed;
  }
  /** Stop the view once and wait until its exit status is available. */
  async function stopView(signal = 'SIGTERM') {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    return waitForClose();
  }
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    let timer;
    await Promise.race([stopView('SIGTERM'), new Promise((done) => {
      timer = setTimeout(() => done(false), 5000);
    })]);
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) await stopView('SIGKILL');
  });
  const document = await new Promise((resolveDocument, rejectDocument) => {
    const timer = setTimeout(() => rejectDocument(new Error(`view did not start: ${stderrTail.join('\n')}\n${stderrPartial}`)), 10_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      try { resolveDocument(JSON.parse(stdout)); clearTimeout(timer); }
      catch { /* Wait until the one JSON document is complete. */ }
    });
    child.once('error', rejectDocument);
    child.once('close', () => rejectDocument(new Error(`view exited early: ${stderrTail.join('\n')}\n${stderrPartial}`)));
  });
  const address = new URL(document.url);
  const key = address.searchParams.get('k');
  assert.ok(key, 'the private view URL includes its one-use request credential');
  /** Send a bounded authenticated request to the live view adapter. */
  async function request(path, options = {}) {
    try {
      return await fetchFresh(new URL(path, address.origin), {
        ...options,
        headers: { 'x-pullboard-key': key, ...options.headers },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      let timer;
      await Promise.race([closed, new Promise((resolveStatus) => { timer = setTimeout(resolveStatus, 500); })]);
      clearTimeout(timer);
      const causeCode = error?.cause?.cause?.code ?? error?.cause?.code ?? error?.code ?? 'no-code';
      const causeChain = [];
      for (let current = error; current !== undefined && current !== null && causeChain.length < 8; current = current.cause) {
        causeChain.push([current.code ?? current.name, current.message].filter(Boolean).join(': '));
      }
      const processStatus = child.exitCode !== null
        ? `exit code=${child.exitCode}`
        : child.signalCode !== null ? `signal=${child.signalCode}`
          : spawnError ? `spawn error code=${spawnError.code ?? spawnError.name}` : 'still running';
      const stderr = [...stderrTail, ...(stderrPartial ? [stderrPartial] : [])].slice(-20);
      const lines = stderr.length ? stderr.join('\n') : '<no stderr output>';
      throw new Error(`view request failed after 1 attempt (no retry): fetch cause code=${causeCode}; cause chain ${causeChain.join(' <- ')}; child ${processStatus}; stderr last 20 lines:\n${lines}`, { cause: error });
    }
  }
  request.stopView = stopView;
  request.waitForClose = waitForClose;
  return request;
}

/** Find this fixture's board in the actual view API and return its stable route prefix. */
async function viewBoardPath(request, root) {
  const response = await request('/api/v1/boards');
  assert.equal(response.status, 200);
  const document = await response.json();
  const board = document.boards.find((entry) => entry.root === root);
  assert.ok(board, 'the initialized fixture appears in the actual view API');
  return `/api/v1/boards/${board.id}`;
}

/** Send one spec decision through the authenticated view move adapter. */
async function viewDecision(request, boardPath, verb, args) {
  const response = await request(`${boardPath}/moves`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ verb, agent: 'coordinator', args }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

test('[B26] failed view request names its cause', async (t) => {
  const box = project();
  const preload = join(box.dir, 'stderr-preload.mjs');
  writeFileSync(preload, [
    ...Array.from({ length: 25 }, (_, index) => `process.stderr.write('stderr-tail-${String(index + 1).padStart(2, '0')}\\n');`),
    'process.stderr.write("stderr-split-");',
    'await new Promise((resolveWait) => setTimeout(resolveWait, 25));',
    'process.stderr.write("line\\n");',
  ].join('\n'));
  const request = await startView(t, box, { NODE_OPTIONS: `--import=file://${preload}` });
  await request.stopView('SIGKILL');
  let failure;
  try {
    await request('/api/v1/boards');
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, 'requesting a stopped view rejects');
  const fetchError = failure.cause;
  const causeCode = fetchError?.cause?.code ?? fetchError?.code;
  assert.equal(typeof causeCode, 'string', 'the failed fetch provides a cause code');
  assert.ok(failure.message.includes(`fetch cause code=${causeCode}`));
  assert.match(failure.message, /child (?:exit code=\d+|signal=\w+)/);
  assert.match(failure.message, /view request failed after 1 attempt \(no retry\)/, 'the request is not retried');
  const stderr = failure.message.split('stderr last 20 lines:\n')[1];
  assert.ok(stderr, 'the diagnostic includes the stderr tail');
  assert.equal(stderr.split('\n').length, 20, 'the stderr diagnostic contains exactly the last 20 lines');
  for (const line of Array.from({ length: 6 }, (_, index) => `stderr-tail-${String(index + 20).padStart(2, '0')}`)) {
    assert.ok(stderr.includes(line), `${line} appears in the last 20 stderr lines`);
  }
  assert.ok(stderr.includes('stderr-split-line'), 'stderr text split across writes is reconstructed');
  assert.ok(!stderr.includes('stderr-tail-01'), 'stderr older than the last 20 lines is omitted');
});

test('[B26,S18,S19] person decisions wait on the board until one apply preserves every other field', async function pendingThenApply(t) {
  const box = project();
  const specPath = join(box.root, SPEC_FILE);
  const doctrinePath = join(box.root, DOCTRINE_FILE);
  const beforeSpec = readFileSync(specPath, 'utf8');
  const beforeDoctrine = readFileSync(doctrinePath, 'utf8');
  const beforeEvents = eventCount(box);

  const request = await startView(t, box);
  const boardPath = await viewBoardPath(request, box.root);
  const identity = command(box, box.web, 'whoami', '--json');
  assert.equal(identity.status, 0, identity.stderr);
  const agentDecision = await request(`${boardPath}/moves`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ verb: 'spec-approve', agent: JSON.parse(identity.stdout).id, args: { ids: 'G1' } }),
  });
  assert.equal(agentDecision.status, 409, 'a named API agent cannot become the person');
  assert.equal((await agentDecision.json()).error.code, 'B26_PERSON_APPROVAL');
  await viewDecision(request, boardPath, 'spec-approve', { ids: 'G1' });
  const declined = command(box, box.root, 'spec', 'decline', 'G2', '--reason', 'not needed', '--json');
  assert.equal(declined.status, 0, `${declined.stdout}${declined.stderr}`);
  const doctrineApproval = command(box, box.root, 'spec', 'approve', 'doctrine:L1', '--json');
  assert.equal(doctrineApproval.status, 0, `${doctrineApproval.stdout}${doctrineApproval.stderr}`);
  assert.equal(readFileSync(specPath, 'utf8'), beforeSpec, 'approve and decline only append board decisions');
  assert.equal(readFileSync(doctrinePath, 'utf8'), beforeDoctrine, 'the doctrine source also waits for coordinator apply');
  assert.equal(eventCount(box), beforeEvents + 3, 'each decision is recorded as a board event');

  for (const [key, stage] of [['G1', 'approved, pending apply'], ['G2', 'declined, pending apply'], ['doctrine:L1', 'approved, pending apply']]) {
    const shown = command(box, box.root, 'spec', 'show', key, '--json');
    assert.equal(shown.status, 0, `${shown.stdout}${shown.stderr}`);
    const row = JSON.parse(shown.stdout).row;
    assert.ok(row.decision, `${key} includes the recorded decision`);
    assert.equal(row.stage, stage);
  }
  const stateResponse = await request(`${boardPath}/state`);
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.state.spec.find((row) => row.id === 'G1').stage, 'approved, pending apply');
  assert.equal(state.state.spec.find((row) => row.id === 'G2').stage, 'declined, pending apply');
  assert.equal(state.state.practice.find((row) => row.id === 'L1').stage, 'approved, pending apply');

  const applied = command(box, box.root, 'spec', 'apply', '--json');
  assert.equal(applied.status, 0, `${applied.stdout}${applied.stderr}`);
  const g1 = sourceRow(box, SPEC_FILE, 'G1');
  const g2 = sourceRow(box, SPEC_FILE, 'G2');
  const g3 = sourceRow(box, SPEC_FILE, 'G3');
  const l1 = sourceRow(box, DOCTRINE_FILE, 'L1');
  assert.equal(g1.status, 'approved');
  assert.equal(g1.tier, 'must');
  assert.equal(g1.gate, 'true');
  assert.deepEqual(g1.serves, ['G3']);
  assert.equal(g2.status, 'wont');
  assert.equal(g2.tier, 'aim');
  assert.equal(g2.gate, 'true');
  assert.match(g2.text, /not needed/u, 'the decline reason is recorded in the row text');
  assert.deepEqual(g3, { ...parseSpec(beforeSpec).rows.find((row) => row.id === 'G3') }, 'an unaffected row keeps every parsed field');
  assert.equal(l1.status, 'approved', 'coordinator apply also handles the repo doctrine file');
  const afterEvents = eventCount(box);
  const again = command(box, box.root, 'spec', 'apply', '--json');
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout).applied, []);
  assert.equal(eventCount(box), afterEvents, 'a second apply does not duplicate the receipt');
});

test('[B26] agent markers and agent worktrees cannot decide rows; only the coordinator applies them', function guardPersonAndCoordinatorActions() {
  const box = project();
  const original = readFileSync(join(box.root, SPEC_FILE), 'utf8');
  const before = eventCount(box);
  for (const marker of AGENT_SHELL_MARKERS) {
    const refused = box.run(box.root, ['spec', 'approve', 'G1', '--json'], { [marker]: 'agent-fixture' });
    assert.equal(refused.status, 1, `${marker}: ${refused.stdout}${refused.stderr}`);
    assert.equal(JSON.parse(refused.stdout).error.code, 'B26_PERSON_CHANNEL', marker);
    assert.equal(readFileSync(join(box.root, SPEC_FILE), 'utf8'), original, `${marker} cannot edit SPEC.md`);
    assert.equal(eventCount(box), before, `${marker} cannot append a board decision`);
  }
  const fromWorktree = box.run(box.web, ['spec', 'approve', 'G1', '--json']);
  assert.equal(fromWorktree.status, 1, `${fromWorktree.stdout}${fromWorktree.stderr}`);
  assert.equal(JSON.parse(fromWorktree.stdout).error.code, 'B26_PERSON_APPROVAL');
  assert.equal(eventCount(box), before, 'an agent worktree cannot act as the person without a shell marker');

  const approved = command(box, box.root, 'spec', 'approve', 'G1', '--json');
  assert.equal(approved.status, 0, `${approved.stdout}${approved.stderr}`);
  const pending = readFileSync(join(box.root, SPEC_FILE), 'utf8');
  const agentApply = box.run(box.web, ['spec', 'apply', '--json']);
  assert.equal(agentApply.status, 1, `${agentApply.stdout}${agentApply.stderr}`);
  assert.equal(readFileSync(join(box.root, SPEC_FILE), 'utf8'), pending, 'an agent cannot apply a pending decision');
  const applied = command(box, box.root, 'spec', 'apply', '--json');
  assert.equal(applied.status, 0, `${applied.stdout}${applied.stderr}`);
  assert.equal(sourceRow(box, SPEC_FILE, 'G1').status, 'approved');
});

test('[B26,S18,S19] stale row text refuses apply without changing any approved row', function staleApplyIsAtomic() {
  const box = project();
  for (const id of ['G1', 'G2']) {
    const approved = command(box, box.root, 'spec', 'approve', id, '--json');
    assert.equal(approved.status, 0, `${approved.stdout}${approved.stderr}`);
  }
  const source = join(box.root, SPEC_FILE);
  const edited = readFileSync(source, 'utf8').replace('Decline this row.', 'Someone edited this row after approval.');
  writeFileSync(source, edited);
  const beforeApply = readFileSync(source, 'utf8');
  const refused = command(box, box.root, 'spec', 'apply', '--json');
  assert.notEqual(refused.status, 0, `${refused.stdout}${refused.stderr}`);
  const document = JSON.parse(refused.stdout);
  assert.ok(document.error, 'stale decision refusal stays a structured CLI refusal');
  assert.equal(readFileSync(source, 'utf8'), beforeApply, 'the stale check prevents partial writes to SPEC.md');
  assert.equal(sourceRow(box, SPEC_FILE, 'G1').status, 'draft', 'even the earlier valid decision is not applied first');
  assert.equal(sourceRow(box, SPEC_FILE, 'G2').status, 'draft');
  assert.equal(sourceRow(box, SPEC_FILE, 'G2').text, 'Someone edited this row after approval.');
});

/** Create a real SSH Ed25519 key pair for the required-signer decision case. */
function makeKey(path) {
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'row-decision@example.invalid', '-f', path], { stdio: 'pipe' });
  return { privateKey: path, publicKey: `${path}.pub` };
}

test('[B26,S18,S19] signer-required approval signs the exact applied row and tampering is refused', function signedRowDecision() {
  const signedSpec = `# Signed row decision fixture\n\n## G · Goals\n- G1 [draft, must] This exact row requires the person's signature. | gate: true | signers: CO\n`;
  const box = project({ spec: signedSpec });
  const key = makeKey(join(box.dir, 'co-signing-key'));
  box.git(box.root, 'config', 'user.signingkey', key.privateKey);
  const listed = command(box, box.root, 'spec', 'signers', 'add', '--key', key.publicKey, '--by', 'CO', '--json');
  assert.equal(listed.status, 0, `${listed.stdout}${listed.stderr}`);

  const approve = command(box, box.root, 'spec', 'approve', 'G1', '--by', 'CO', '--json');
  assert.equal(approve.status, 0, `${approve.stdout}${approve.stderr}`);
  assert.ok(JSON.parse(approve.stdout).decisions[0].signature, 'approval carries its signature before any source apply');
  assert.equal(sourceRow(box, SPEC_FILE, 'G1').status, 'draft');
  assert.equal(existsSync(join(box.root, '.pullboard', 'signoffs.jsonl')), false, 'signing the pending decision writes no checkout receipt');
  const applied = command(box, box.root, 'spec', 'apply', '--json');
  assert.equal(applied.status, 0, `${applied.stdout}${applied.stderr}`);
  const check = command(box, box.root, 'spec', 'check');
  assert.equal(check.status, 0, `${check.stdout}${check.stderr}`);

  const ledger = join(box.root, '.pullboard', 'signoffs.jsonl');
  const original = readFileSync(ledger, 'utf8');
  const receipt = original.split('\n').filter(Boolean).map(JSON.parse).find((entry) => entry.type === 'row-decision' && entry.id === 'G1');
  assert.ok(receipt?.signature, 'apply emits the signed receipt for the approved row');
  assert.equal(sourceRow(box, SPEC_FILE, 'G1').status, 'approved');
  for (const field of ['text', 'source', 'replacement', 'decision', 'reason', 'file']) {
    const tampered = original.split('\n').filter(Boolean).map(JSON.parse).map((entry) => (
      entry.type === 'row-decision' && entry.id === 'G1' ? { ...entry, [field]: `${entry[field]} altered` } : entry
    ));
    writeFileSync(ledger, `${tampered.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    const refused = command(box, box.root, 'spec', 'check');
    assert.notEqual(refused.status, 0, `${field} is signed`);
    assert.match(`${refused.stdout}${refused.stderr}`, /BAD_SIGNATURE/u, `${field} tampering invalidates the approval receipt`);
  }
  writeFileSync(ledger, original);
});

test('[B26,S19,V3] a view approval binds proposed wording without changing the source before apply', async function approvedRewrite(t) {
  const box = project();
  const file = join(box.root, SPEC_FILE);
  const before = readFileSync(file, 'utf8');
  const text = 'The person approved this exact revised promise.';
  const request = await startView(t, box);
  const boardPath = await viewBoardPath(request, box.root);
  const events = eventCount(box);
  for (const args of [{ ids: 'G1 G3', text }, { ids: 'G3', text: '' }, { ids: 'G3', text: 'two\nlines' }, { ids: 'G3', text: 'text | gate: changed' }]) {
    const response = await request(`${boardPath}/moves`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verb: 'spec-approve', agent: 'coordinator', args }),
    });
    assert.equal(response.status, 409, 'proposed wording needs one valid exact text and one row');
    assert.equal((await response.json()).error.code, 'ROW_DECISION');
    assert.equal(eventCount(box), events, 'invalid text writes no person-decision event');
    assert.equal(readFileSync(file, 'utf8'), before, 'invalid proposed text never changes source');
  }
  await viewDecision(request, boardPath, 'spec-approve', { ids: 'G3', text });
  assert.equal(readFileSync(file, 'utf8'), before, 'the API decision writes no source bytes');
  const state = await (await request(`${boardPath}/state`)).json();
  const row = state.state.spec.find((entry) => entry.id === 'G3');
  assert.equal(row.text, 'Keep this unaffected row.');
  assert.equal(row.decision.text, text, 'the one existing decision record binds the proposed target');
  assert.equal(row.stage, 'approved, pending apply');
  const apply = command(box, box.root, 'spec', 'apply');
  assert.equal(apply.status, 0, `${apply.stdout}${apply.stderr}`);
  assert.equal(sourceRow(box, SPEC_FILE, 'G3').text, text);
  box.git(box.root, 'add', SPEC_FILE);
  box.git(box.root, 'commit', '-q', '-m', 'docs: apply the person-approved rewrite');
  assert.ok(box.git(box.root, 'show', 'HEAD:SPEC.md').includes(text), 'the exact view-approved rewrite passes the real commit hook');
});
