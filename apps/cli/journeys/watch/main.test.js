/** pullboard watch follows the board's live event stream, from a real CLI on a real board [A2,N26]. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { loadavg } from 'node:os';
import { tmpdir } from 'node:os';
import { delimiter } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after } from 'node:test';
import { test } from 'node:test';
import { reserveReview } from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { followBoard } from '../../../../packages/shouts/index.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { startFixtureChild } from '../../tests/fixtures/child.js';
import { waitForCondition } from '../../tests/fixtures/runner/holders.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { HOST } from '../../tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../tests/fixtures/runner/ssh.js';
import { fixtureJoinRoute } from '../../tests/fixtures/testkit.js';
import { VERIFICATION_COMPARISON_PREFIX } from '../../../../packages/verify/index.js';

const BIN = resolve(import.meta.dirname, '../../pullboard.js');
const folders = [];

after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

/** A clean environment for fixture Git and CLI children: no inherited GIT_* or relay token. */
function fixtureEnv(home, bin) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_') && !name.startsWith('PULLBOARD_')));
  return {
    ...env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: home, PATH: bin + delimiter + process.env.PATH,
    PULLBOARD_VIEW_BACKGROUND: '0', // Restore the fixture opt-out after removing inherited board identity.
    PULLBOARD_USAGE_CHECKPOINT: 'inline',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Watch Test', GIT_AUTHOR_EMAIL: 'watch@example.invalid',
    GIT_COMMITTER_NAME: 'Watch Test', GIT_COMMITTER_EMAIL: 'watch@example.invalid',
  };
}

/** A private Git repo with an initialized board, two lanes and a gate that passes. */
async function project() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-watch-')));
  folders.push(dir);
  const root = join(dir, 'repo');
  const home = join(dir, 'home');
  const bin = join(dir, 'bin');
  for (const folder of [root, home, bin]) mkdirSync(folder);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec '${process.execPath}' '${BIN}' "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = fixtureEnv(home, bin);
  const git = (...args) => runFixtureGit(args, { cwd: root, env, encoding: 'utf8', stdio: 'pipe' }).toString().trim();
  /** Run one CLI command through the production dispatch in this process; a watch stays a child process. */
  const runLocal = (cwd, ...args) => runCliInProcess(args, { cwd, env });
  /** Run one CLI command with --json and return its document. */
  const local = async (cwd, ...args) => {
    args = fixtureJoinRoute(args, env.PULLBOARD_MODEL);
    if (args[0] === 'submit') args.push('--wait');
    const result = await runLocal(cwd, ...args, '--json');
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}${result.stdout}`);
    return JSON.parse(result.stdout);
  };
  git('init', '-q', '-b', 'main');
  await local(root, 'init');
  const configFile = join(root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, gate: 'true', spec: 'SPEC.md', practice: 'DOCTRINE.md',
    landing: { perItem: false, manualOverride: true },
    lanes: { app: { owns: ['app/'], specs: ['G1'] }, docs: { owns: ['docs/'], specs: ['G1'] } }, shared: [] }, null, 2) + '\n');
  writeFileSync(join(root, 'SPEC.md'), '# Watch fixture\n\n## Goals\n- G1 [approved, must] Keep the board. | gate: true\n');
  writeFileSync(join(root, 'DOCTRINE.md'), '');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: watch fixture');
  return { dir, root, home, env, git, runLocal, local };
}

/** Read the fixture board's events straight from its SQLite file, read-only. */
function events(box) {
  const db = new DatabaseSync(join(box.root, '.git', 'pullboard', 'board.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT event_id, event_kind, item_id, event_by, event_detail FROM event ORDER BY event_id').all(); }
  finally { db.close(); }
}

/** The latest event sequence on the fixture board. */
function lastSequence(box) {
  return events(box).at(-1)?.event_id ?? 0;
}

/** Finish only this fixture's detached comparison facts before judging a quiet event interval. */
async function drainComparisons(box, t) {
  const directory = join(box.root, '.git/pullboard/review-comparisons');
  const jobs = existsSync(directory) ? readdirSync(directory) : [];
  await waitForCondition(() => jobs.every(job => existsSync(join(directory, job, 'result.json'))),
    'owned watch comparison to finish', { signal: t.signal });
}

/**
 * Start the real CLI's watch as a child. Each test waits on it with a deadline and stops it by its
 * own pid, so a watch that never prints fails the test instead of hanging it.
 */
function startWatch(box, args, { cwd = box.root } = {}) {
  const child = startFixtureChild(process.execPath, [BIN, 'watch', ...args], { cwd, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { lines: [], waiters: [], buffer: '' };
  const err = { lines: [], waiters: [], buffer: '' };
  /** Keep complete lines and hand each to the waiter whose test it passes. */
  const feed = (stream, part) => {
    stream.buffer += part;
    let end;
    while ((end = stream.buffer.indexOf('\n')) >= 0) {
      const line = stream.buffer.slice(0, end);
      stream.buffer = stream.buffer.slice(end + 1);
      stream.lines.push({ line, at: Date.now() });
      for (const waiter of [...stream.waiters]) {
        if (waiter.match(line)) { stream.waiters.splice(stream.waiters.indexOf(waiter), 1); waiter.found({ line, at: Date.now() }); }
      }
    }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (part) => feed(out, part));
  child.stderr.on('data', (part) => feed(err, part));
  const closed = once(child, 'close');
  /** Wait for the first line, already printed or still to come, that passes `match`. */
  const waitFor = (stream, match, ms, label) => {
    const seen = stream.lines.find(({ line }) => match(line));
    if (seen) return Promise.resolve(seen);
    return new Promise((found, failed) => {
      const waiter = { match, found: (value) => { clearTimeout(timer); found(value); } };
      const timer = setTimeout(() => {
        stream.waiters.splice(stream.waiters.indexOf(waiter), 1);
        failed(new Error(`watch printed no ${label} within ${ms} ms\nstdout:\n${out.lines.map((entry) => entry.line).join('\n')}\nstderr:\n${err.lines.map((entry) => entry.line).join('\n')}`));
      }, ms);
      stream.waiters.push(waiter);
    });
  };
  return {
    child,
    out,
    err,
    line: (match, ms, label) => waitFor(out, match, ms, label),
    note: (match, ms, label) => waitFor(err, match, ms, label),
    /** Stop this watch by its own pid, and kill it if it does not stop. */
    async stop(signal = 'SIGINT') {
      if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
      child.kill(signal);
      const force = setTimeout(() => child.kill('SIGKILL'), 5_000); // budget: hang ceiling for a stopping child, not a latency claim.
      try { const [code, killed] = await closed; return { code, signal: killed }; } finally { clearTimeout(force); }
    },
  };
}

test('watch uses its explicit view provider in global then scoped order before opening a direct API [A2,N26,C7]', async () => {
  for (const scoped of [false, true]) {
    const calls = [];
    const notes = [];
    const controller = new AbortController();
    const server = createServer((request, response) => {
      assert.equal(request.headers['x-pullboard-key'], 'fixture-session');
      // Without --work, watch reads events only: it asks for no changed notices, which cost the server a state revision on every write.
      assert.equal(request.url, '/api/v1/boards/fixture-board/events?signals=none');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': ready\n\n');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    const options = { work: null, since: null, kinds: null, item: null, to: null };
    const inputs = { commonDir: '/fixture/common', options, start: { id: 'fixture-board', sequence: 0 },
      config: {}, write: () => assert.fail('no event was sent'), note: (text) => { notes.push(text); controller.abort(); },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]), // budget: bound a broken private stream, not a latency claim.
      serveApi: () => assert.fail('the explicit view must prevent direct API startup') };
    try {
      await assert.rejects(followBoard(inputs), /caller-owned runningView/u);
      assert.equal(await followBoard({ ...inputs, runningView: async (requestedPort, scope) => {
        calls.push([requestedPort, scope]);
        return scoped && scope === null ? null : { port, url: `http://127.0.0.1:${port}/?k=fixture-session` };
      } }), 0);
      assert.deepEqual(calls, scoped ? [[0, null], [0, '/fixture/common']] : [[0, null]]);
      assert.deepEqual(notes, [`watch: following the view on port ${port} after sequence 0`]);
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  }
});

test('watch --work keeps the changed notices its work check needs, and every other watch drops them [A2,N26,C7]', async () => {
  const requested = [];
  const box = await project();
  const file = join(box.root, '.git', 'pullboard', 'board.sqlite');
  for (const work of ['app', null]) {
    const controller = new AbortController();
    const server = createServer((request, response) => {
      requested.push(request.url);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': ready\n\n');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    const inputs = { file, mainRoot: box.root, commonDir: '/fixture/common', options: { work, reviewWaitMs: 0, since: null, kinds: null, item: null, to: null }, start: { id: 'fixture-board', sequence: 0 },
      config: {}, write: () => assert.fail('no event was sent'), note: () => controller.abort(),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]), // budget: bound a broken private stream, not a latency claim.
      serveApi: () => assert.fail('the explicit view must prevent direct API startup'),
      runningView: async () => ({ port, url: `http://127.0.0.1:${port}/?k=fixture-session` }) };
    try {
      assert.equal(await followBoard(inputs), 0);
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  }
  assert.deepEqual(requested.map((url) => url.endsWith('?signals=none')), [false, true], '--work keeps the notices and a plain watch asks for events alone');
});

test('pullboard watch prints a move as it happens [A2,N26]', async (t) => {
  const box = await project();
  assert.equal(readdirSync(box.home).some((name) => /^view(?:-\d+)?\.json$/u.test(name)), false, 'no view runs for this board');
  const before = events(box).length;
  const watch = startWatch(box, []);
  t.after(() => watch.stop('SIGKILL'));
  await watch.note((line) => /following the board directly/u.test(line), 10_000, 'note that it follows the board directly'); // budget: hang ceiling for CLI startup, not a latency claim.

  const added = (await box.local(box.root, 'add', 'app', 'Live watch item', '--criterion', 'arrives on the live stream', '--specs', 'G1')).item;
  const moved = Date.now();
  // Adding an item also records where the roadmap placed it, so the add is followed by its placement event [N26].
  const fresh = events(box).slice(before);
  assert.deepEqual(fresh.map((entry) => entry.event_kind), ['add', 'milestone_placed'], 'the add and its placement are the only new events');
  const [event, placement] = fresh;
  assert.equal(event.item_id, added.item_id);
  const printed = await watch.line((line) => line.startsWith(`${event.event_id} `), 2_000, 'line for the add'); // budget: declared by #544's frozen criterion (within two seconds); a hang ceiling for one line.
  assert.ok(printed.at - moved <= 2_000, 'the line arrives within two seconds of the move'); // budget: declared by #544's frozen criterion (within two seconds).
  assert.equal(printed.line, `${event.event_id} add #${added.item_id} ${event.event_by} Live watch item (lane app, route strong)`,
    'one line: sequence, kind, item, actor and a short detail');
  await watch.line((line) => line.startsWith(`${placement.event_id} `), 2_000, 'line for the placement'); // budget: hang ceiling for one line.

  const stopped = await watch.stop('SIGINT');
  assert.deepEqual(stopped, { code: 0, signal: null }, 'Ctrl-C stops watch cleanly');
  assert.equal(watch.out.lines.length, 2, 'one line per event, and nothing else on stdout');
  assert.ok(watch.out.lines[1].line.startsWith(`${placement.event_id} milestone_placed #${added.item_id} `), 'the placement prints as its own line naming the item');
  assert.equal(events(box).length, before + 2, 'watch wrote no event: the only new ones are the add and its placement');
});

test('a dropped watch resumes from its last event [A2,N26]', async (t) => {
  const box = await project();
  const view = startFixtureChild(process.execPath, [BIN, 'view', '--no-open', '--port', '0', '--json'],
    { cwd: box.root, env: { ...box.env, PULLBOARD_VIEW_FOREGROUND: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const viewClosed = once(view, 'close');
  t.after(() => { if (view.exitCode === null && view.signalCode === null) view.kill('SIGKILL'); });
  let viewOut = '';
  view.stdout.setEncoding('utf8');
  const viewReady = new Promise((ready, failed) => {
    const timer = setTimeout(() => failed(new Error(`the view did not start: ${viewOut}`)), 10_000); // budget: hang ceiling for view startup, not a latency claim.
    view.stdout.on('data', (part) => {
      viewOut += part;
      try { const document = JSON.parse(viewOut); clearTimeout(timer); ready(document); } catch { /* The document is pretty-printed; wait for the rest. */ }
    });
  });
  const { port } = await viewReady;

  const before = events(box).length;
  const watch = startWatch(box, ['--json', '--kinds', 'shout']);
  t.after(() => watch.stop('SIGKILL'));
  await watch.note((line) => line.includes(`following the view on port ${port}`), 10_000, 'note that it follows the view'); // budget: hang ceiling for CLI startup, not a latency claim.

  await box.local(box.root, 'shout', 'app', 'first, through the view');
  const first = events(box).at(-1);
  await watch.line((line) => JSON.parse(line).sequence === first.event_id, 5_000, 'first shout'); // budget: hang ceiling for one line, not a latency claim.

  // Stop the view by its own pid: its stream ends, and watch must carry on from its last event.
  view.kill('SIGTERM');
  await viewClosed;
  await box.local(box.root, 'shout', 'app', 'second, while the stream was down');
  const second = events(box).at(-1);
  await watch.note((line) => /following the board directly/u.test(line), 10_000, 'note that it follows the board directly'); // budget: hang ceiling for reconnecting, not a latency claim.
  await box.local(box.root, 'shout', 'all', 'third, after the stream came back');
  const third = events(box).at(-1);
  await watch.line((line) => JSON.parse(line).sequence === third.event_id, 5_000, 'third shout'); // budget: hang ceiling for one line, not a latency claim.

  assert.deepEqual(await watch.stop('SIGTERM'), { code: 0, signal: null });
  const printed = watch.out.lines.map(({ line }) => JSON.parse(line));
  assert.deepEqual(printed.map((record) => record.sequence), [first.event_id, second.event_id, third.event_id],
    'each shout once, in order: nothing missed while the stream was down and nothing repeated');
  assert.deepEqual(printed.map((record) => record.detail),
    ['to app: first, through the view', 'to app: second, while the stream was down', 'to all: third, after the stream came back']);
  for (const record of printed) {
    assert.equal(record.version, 1);
    assert.equal(record.kind, 'shout');
    assert.equal(record.item, null);
    assert.equal(record.actor, 'coordinator');
  }
  assert.equal(events(box).length, before + 3, 'watch wrote no event: the only new ones are the three shouts');
});

test('watch --work announces a claimable item and a review left waiting [A2,N26]', async (t) => {
  // Keep the executing host's load in the frozen check output, including when ordinary admission selects a runner.
  const samples = [];
  const sampleLoad = () => samples.push({ at: new Date().toISOString(), oneMinute: loadavg()[0] });
  sampleLoad();
  const sampling = setInterval(sampleLoad, 1_000);
  sampling.unref();
  t.after(() => {
    clearInterval(sampling);
    sampleLoad();
    t.diagnostic(JSON.stringify({ host: hostname(), node: process.version, loadSamples: samples }));
  });
  const box = await project();
  // The baseline worker needs a registered runner in this isolated machine home.
  const runnerBin = join(box.dir, 'runner-bin'), worker = join(box.dir, 'runner-worker');
  const runnerHome = join(box.dir, 'runner-home'), runnerMachine = join(runnerHome, '.pullboard');
  for (const folder of [runnerBin, worker, runnerHome, runnerMachine]) mkdirSync(folder, { recursive: true });
  installSshStandIn({ bin: runnerBin, worker, home: runnerHome, machineHome: runnerMachine,
    requests: join(box.dir, 'runner-requests.jsonl'), nodeCommand: process.execPath });
  box.env.PATH = runnerBin + delimiter + box.env.PATH;
  // In process: registering the runner is setup, not the watch under test, so it costs no CLI launch.
  const runnerAdd = ['runner', 'add', HOST, '--slots', '1', '--browser', '0'];
  const registered = await runCliInProcess(runnerAdd, { cwd: box.root, env: box.env });
  assert.equal(registered.status, 0, `runner add: ${registered.stderr}${registered.stdout}`);
  const builder = await box.local(box.root, 'worktree', 'app', '--model', 'watch-builder');
  const waiting = (await box.local(box.root, 'add', 'app', 'Waits on another item', '--criterion', 'waits', '--specs', 'G1', '--check', 'true', '--route', 'strong',
    '--brief', 'Files: app/waiting.txt\nChange: exercise waiting work in the watch fixture.\nTest: observe the claimable and rejection notices.\nOut of scope: product behavior.', '--wait')).item;
  await box.local(box.root, 'check', 'accept', String(waiting.item_id)); // #728 holds a check already green on main until the person accepts it.
  const before = events(box).length;
  const watch = startWatch(box, ['--json', '--work', 'app', '--review-wait', '0.02']);
  t.after(() => watch.stop('SIGKILL'));
  await watch.note((line) => /following the board directly/u.test(line), 10_000, 'note that it follows the board directly'); // budget: hang ceiling for CLI startup, not a latency claim.
  assert.equal(watch.out.lines.length, 0, 'work already claimable when watch starts is its baseline, so it prints nothing');

  // A newly opened item in the lane is claimable.
  const added = (await box.local(box.root, 'add', 'app', 'Fresh app work', '--criterion', 'claimable', '--specs', 'G1', '--check', 'true', '--route', 'strong',
    '--brief', 'Files: app/work.txt\nChange: exercise fresh work in the watch fixture.\nTest: observe the claimable and review-wait notices.\nOut of scope: product behavior.', '--wait')).item;
  const notice = JSON.parse((await watch.line((line) => JSON.parse(line).kind === 'claimable', 5_000, 'claimable notice')).line); // budget: hang ceiling for one line, not a latency claim.
  assert.equal(notice.item, added.item_id);
  assert.equal(notice.notice, true);
  assert.equal(notice.detail, 'app: Fresh app work');
  const noticed = events(box).find(event => event.event_id === notice.sequence);
  assert.equal(noticed.item_id, added.item_id, 'the notice follows its new item');
  assert.ok(['add', 'check-baseline'].includes(noticed.event_kind), 'the notice follows the add or its actual baseline observation');
  assert.equal(added.item_check_baseline.result, 'green', 'the baseline is finished before later move assertions');
  const blocked = (await box.local(box.root, 'add', 'app', 'Waits for the fresh work', '--criterion', 'after', '--specs', 'G1', '--after', String(added.item_id), '--route', 'strong',
    '--brief', 'Files: app/after.txt\nChange: exercise a dependency-blocked item in the watch fixture.\nTest: observe the item becoming claimable after acceptance.\nOut of scope: product behavior.')).item;

  // A released claim makes the item claimable again.
  await box.local(builder.path, 'claim', String(waiting.item_id));
  // A later existing event acknowledges the preceding claim's work check, not merely its printed raw line.
  await box.local(box.root, 'check', 'accept', String(added.item_id)); // #728's person acceptance also supplies the ordered barrier.
  const claimObserved = lastSequence(box);
  await watch.line((line) => JSON.parse(line).sequence === claimObserved && JSON.parse(line).kind === 'check_accept',
    5_000, 'event after the claim work check'); // budget: hang ceiling for an exact event, not a latency claim.
  await box.local(builder.path, 'release', String(waiting.item_id), '--reason', 'BLOCKED', '--no-next');
  // The release's usage checkpoint follows it as a separate event [N2]; watch still names the release itself.
  const releaseSequence = events(box).findLast(event => event.event_kind === 'release' && event.item_id === waiting.item_id).event_id;
  await watch.line((line) => JSON.parse(line).kind === 'release' && JSON.parse(line).sequence === releaseSequence,
    5_000, 'release event'); // budget: hang ceiling for an exact event, not a latency claim.
  // A work check may see the new board state while processing the preceding barrier event.
  const released = JSON.parse((await watch.line((line) => JSON.parse(line).kind === 'claimable' && JSON.parse(line).item === waiting.item_id
    && JSON.parse(line).sequence >= claimObserved && JSON.parse(line).sequence <= releaseSequence,
    5_000, 'claimable notice after release')).line); // budget: hang ceiling for one line, not a latency claim.
  assert.equal(released.detail, 'app: Waits on another item');

  // A submission nobody reserves is announced once it has waited past --review-wait (1.2 s here).
  await box.local(builder.path, 'claim', String(added.item_id));
  mkdirSync(join(builder.path, 'app'), { recursive: true });
  writeFileSync(join(builder.path, 'app', 'work.txt'), 'built\n');
  runFixtureGit(['add', '-A'], { cwd: builder.path, env: box.env, stdio: 'pipe' });
  runFixtureGit(['commit', '-q', '-m', 'feat(app): fresh work [G1]'], { cwd: builder.path, env: box.env, stdio: 'pipe' });
  const firstSubmission = await box.local(builder.path, 'submit', String(added.item_id), '--no-next');
  await drainComparisons(box, t);
  const firstCommit = firstSubmission.commit;
  const submitted = lastSequence(box);
  const review = JSON.parse((await watch.line((line) => JSON.parse(line).kind === 'review-wait', 10_000, 'review-wait notice')).line); // budget: hang ceiling for a 1.2 s review threshold, not a latency claim.
  assert.equal(review.item, added.item_id);
  assert.match(review.detail, /^app: Fresh app work, waiting for review since /u);
  assert.equal(lastSequence(box), submitted, 'the threshold woke watch with no new board event');

  // Accepting the work an item waits on makes that item claimable.
  const reviewer = join(box.dir, 'reviewer');
  box.git('worktree', 'add', '-q', '--detach', reviewer, firstCommit);
  await box.local(reviewer, 'join', 'docs', '--model', 'watch-reviewer');
  await box.local(reviewer, 'next', '--verify', String(added.item_id));
  await box.local(reviewer, 'verify', String(added.item_id), 'accept', '--no-next', '--note', 'read the fixture file');
  const unblocked = JSON.parse((await watch.line((line) => JSON.parse(line).kind === 'claimable' && JSON.parse(line).item === blocked.item_id, 5_000, 'claimable notice after its wait was verified')).line); // budget: hang ceiling for one line, not a latency claim.
  assert.equal(unblocked.detail, 'app: Waits for the fresh work');

  // A rejected submission is claimable again.
  await box.local(builder.path, 'claim', String(waiting.item_id));
  writeFileSync(join(builder.path, 'app', 'waiting.txt'), 'built\n');
  runFixtureGit(['add', '-A'], { cwd: builder.path, env: box.env, stdio: 'pipe' });
  runFixtureGit(['commit', '-q', '-m', 'feat(app): waiting work [G1]'], { cwd: builder.path, env: box.env, stdio: 'pipe' });
  const secondSubmission = await box.local(builder.path, 'submit', String(waiting.item_id), '--no-next');
  await drainComparisons(box, t);
  const secondCommit = secondSubmission.commit;
  runFixtureGit(['switch', '-q', '--detach', secondCommit], { cwd: reviewer, env: box.env, stdio: 'pipe' });
  await box.local(reviewer, 'next', '--verify', String(waiting.item_id));
  // The reserve line follows the submit work check while the item is still submitted, before reject reopens it.
  const submissionObserved = lastSequence(box);
  await watch.line((line) => JSON.parse(line).sequence === submissionObserved && JSON.parse(line).kind === 'reserve',
    5_000, 'event after the submit work check'); // budget: hang ceiling for an exact event, not a latency claim.
  await box.local(reviewer, 'verify', String(waiting.item_id), 'reject', '--no-next', '--reason', 'TEST_FAILURE', '--clause', 'waits', '--note', 'the fixture sends it back');
  // Rejection can immediately create a later escalation, so match the reject's own event id.
  const rejectEvent = events(box).findLast((event) => event.event_kind === 'reject' && event.item_id === waiting.item_id);
  assert.ok(rejectEvent, 'the reviewer rejection was recorded');
  const rejectSequence = rejectEvent.event_id;
  await watch.line((line) => JSON.parse(line).kind === 'reject' && JSON.parse(line).sequence === rejectSequence, 5_000, 'reject line'); // budget: hang ceiling for one line, not a latency claim.
  const again = await watch.line((line) => JSON.parse(line).kind === 'claimable' && JSON.parse(line).item === waiting.item_id
    && JSON.parse(line).sequence >= submissionObserved && JSON.parse(line).sequence <= rejectSequence,
    5_000, 'claimable notice after reject'); // budget: hang ceiling for one line, not a latency claim.
  assert.equal(JSON.parse(again.line).detail, 'app: Waits on another item');

  // Main moving is a notice too.
  box.git('commit', '-q', '--allow-empty', '-m', 'chore: move main');
  const head = box.git('rev-parse', 'HEAD');
  // Landing earlier work may also move main, so wait for the notice naming this commit.
  const main = JSON.parse((await watch.line((line) => JSON.parse(line).kind === 'main' && JSON.parse(line).commit === head, 5_000, 'main notice for the new commit')).line); // budget: hang ceiling for one line, not a latency claim.
  assert.equal(main.commit, head);
  assert.equal(main.detail, `main moved to ${head}`);

  assert.deepEqual(await watch.stop('SIGINT'), { code: 0, signal: null });
  const kinds = watch.out.lines.map(({ line }) => JSON.parse(line).kind);
  assert.equal(watch.out.lines.filter(({ line }) => JSON.parse(line).kind === 'review-wait' && JSON.parse(line).item === added.item_id).length, 1,
    'a waiting review is announced once');
  assert.ok(kinds.includes('accept') && kinds.includes('reject'), 'the verdicts print as events too');
  const recorded = events(box).slice(before);
  const observations = new Set(['fact', 'usage', 'activity-delivered']);
  // The second rejection at this route also records its automatic escalation as a distinct move.
  assert.deepEqual(recorded.filter(event => !observations.has(event.event_kind)).map(event => event.event_kind), [
    'add', 'milestone_placed', 'check-baseline', 'hold_item', 'add', 'milestone_placed', 'claim',
    'unhold_item', 'check_accept', 'release',
    'claim', 'renew', 'proof-run', 'proof-run', 'submit', 'join', 'reserve', 'accept',
    'claim', 'renew', 'proof-run', 'proof-run', 'submit', 'reserve', 'reject', 'escalate',
  ], 'only the explicit moves, rejection escalation, native placements, the baseline with the hold it sets and the acceptance that lifts it, and submit proofs were recorded');
  const allFacts = recorded.filter(event => event.event_kind === 'fact');
  const facts = allFacts.filter(event => JSON.parse(event.event_detail).text.startsWith(VERIFICATION_COMPARISON_PREFIX));
  const shadows = allFacts.filter(event => JSON.parse(event.event_detail).text.startsWith('Tier-1 shadow for gate receipt '));
  assert.equal(allFacts.length, 8, 'only comparison and tier-1 shadow facts are recorded');
  assert.equal(shadows.length, 4, 'each gate proof has a tier-1 shadow fact');
  assert.equal(new Set(shadows.map(event => JSON.parse(event.event_detail).ref?.id)).size, 4, 'shadow references are distinct');
  for (const event of shadows) {
    const fact = JSON.parse(event.event_detail);
    assert.equal(fact.kind, 'measurement');
    assert.equal(fact.ref?.kind, 'proof-run');
    assert.ok(recorded.some(proof => proof.event_kind === 'proof-run' && proof.item_id === event.item_id
      && JSON.parse(proof.event_detail).receipt?.id === fact.ref.id), 'the shadow names a real proof on its item');
  }
  assert.equal(facts.length, 4, 'each submission records exactly pending and completed comparison facts');
  for (const [item, source] of [[added.item_id, firstCommit], [waiting.item_id, secondCommit]]) {
    const comparisons = facts.filter(event => event.item_id === item).map(event => {
      const fact = JSON.parse(event.event_detail);
      assert.equal(fact.kind, 'measurement');
      assert.ok(fact.text.startsWith(VERIFICATION_COMPARISON_PREFIX));
      assert.equal(event.event_by, builder.agent, 'the comparison belongs to the submitting seat');
      return JSON.parse(fact.text.slice(VERIFICATION_COMPARISON_PREFIX.length));
    });
    assert.deepEqual(comparisons.map(row => [row.item, row.source, row.status]),
      [[item, source, 'pending'], [item, source, 'complete']], 'each observational account names its exact submitted source');
  }
  const usage = recorded.filter(event => event.event_kind === 'usage');
  assert.equal(usage.length, 3, 'only release and the two submissions checkpoint usage');
  assert.ok(usage.every(event => event.event_by === builder.agent));
  assert.equal(recorded.filter(event => event.event_kind === 'activity-delivered').length,
    Number(firstSubmission.activity.digests.length > 0) + Number(secondSubmission.activity.digests.length > 0));
  assert.deepEqual(watch.out.lines.map(({ line }) => JSON.parse(line)).filter(row => !row.notice)
    .map(row => [row.sequence, row.kind, row.item, row.actor]),
  recorded.map(event => [event.event_id, event.event_kind, event.item_id, event.event_by]),
  'watch prints every actual event exactly once, in order, including placements and observations');
  const acceptance = recorded.find(event => event.event_kind === 'accept');
  assert.match(JSON.parse(acceptance.event_detail).note, /reused submit proof/u);
  const proofs = recorded.filter(event => event.event_kind === 'proof-run');
  const receipts = proofs.map(event => JSON.parse(event.event_detail).receipt);
  assert.deepEqual(receipts.map(receipt => [receipt.item, receipt.commit]), [
    [added.item_id, firstCommit], [added.item_id, firstCommit],
    [waiting.item_id, secondCommit], [waiting.item_id, secondCommit],
  ], 'only the two submits record native proofs; accept reuses its sealed submit proof');
  for (let index = 0; index < proofs.length; index++) {
    assert.equal(proofs[index].event_by, receipts[index].seat, 'each proof belongs to its executing seat');
    assert.equal(proofs[index].item_id, receipts[index].item, 'each proof belongs to its checked item');
  }
  for (const event of recorded.filter(event => event.event_kind === 'activity-delivered')) {
    assert.equal(event.event_by, builder.agent, 'the submitting recipient records its digest, not watch');
    assert.deepEqual(JSON.parse(event.event_detail).interrupts, [], 'these submit receipts delivered a digest, not an invented interrupt');

  }
});

test('watch filters by kind, item and addressee, and refuses a flag it cannot follow [A2]', async (t) => {
  const box = await project();
  const other = (await box.local(box.root, 'add', 'docs', 'Docs item', '--criterion', 'docs', '--specs', 'G1')).item;
  const watch = startWatch(box, ['--json', '--to', 'app']);
  t.after(() => watch.stop('SIGKILL'));
  const items = startWatch(box, ['--kinds', 'edit', '--item', String(other.item_id)]);
  t.after(() => items.stop('SIGKILL'));
  await watch.note((line) => /following/u.test(line), 10_000, 'start note'); // budget: hang ceiling for CLI startup, not a latency claim.
  await items.note((line) => /following/u.test(line), 10_000, 'start note'); // budget: hang ceiling for CLI startup, not a latency claim.

  await box.local(box.root, 'shout', 'docs', 'for docs only');
  const app = (await box.local(box.root, 'add', 'app', 'App item', '--criterion', 'app', '--specs', 'G1')).item;
  await box.local(box.root, 'shout', 'app', 'for app');
  await box.local(box.root, 'edit', String(app.item_id), '--brief', 'App brief');
  await box.local(box.root, 'fact', String(other.item_id), 'note', 'a fact on the docs item');
  await box.local(box.root, 'edit', String(other.item_id), '--brief', 'Docs brief');
  await box.local(box.root, 'shout', 'all', 'for everyone');
  const last = lastSequence(box);
  await watch.line((line) => JSON.parse(line).sequence === last, 5_000, 'shout to all'); // budget: hang ceiling for one line, not a latency claim.
  const edit = events(box).filter((event) => event.event_kind === 'edit').at(-1);
  await items.line((line) => line.startsWith(`${edit.event_id} edit #${other.item_id} `), 5_000, 'edit line'); // budget: hang ceiling for one line, not a latency claim.
  assert.deepEqual(await watch.stop(), { code: 0, signal: null });
  assert.deepEqual(await items.stop(), { code: 0, signal: null });
  assert.deepEqual(watch.out.lines.map(({ line }) => JSON.parse(line).detail), ['to app: for app', 'to all: for everyone'],
    '--to app takes shouts to app and to all, and nothing else');
  assert.deepEqual(watch.out.lines.map(({ line }) => JSON.parse(line).to), ['app', 'all']);
  assert.deepEqual(items.out.lines.map(({ line }) => line.split(' ').slice(0, 3).join(' ')), [`${edit.event_id} edit #${other.item_id}`],
    '--kinds and --item keep only that item\'s edits: not its fact, and not the other item\'s edit');
  assert.ok(events(box).some((event) => event.event_kind === 'fact' && event.item_id === other.item_id), 'the docs item has a fact to filter out');

  for (const [args, pattern] of [[['--to', 'nobody'], /--to needs an agent id, a lane or all/u], [['--work', 'nowhere'], /--work needs a lane/u],
    [['--review-wait', '5'], /--review-wait goes with --work/u], [['--since', 'later'], /--since needs the last sequence/u], [['extra'], /takes flags only/u]]) {
    const refused = await box.runLocal(box.root, 'watch', ...args, '--json');
    assert.equal(refused.status, 1, `${args.join(' ')}: ${refused.stdout}${refused.stderr}`);
    const { error } = JSON.parse(refused.stdout);
    assert.equal(error.code, 'USAGE');
    assert.match(error.message, pattern);
    assert.ok(error.next, 'the refusal names a next step');
  }
});

test('help watch and the generated agent instructions teach seats to listen with watch [A2,I11]', async () => {
  const box = await project();
  const help = await box.runLocal(box.root, 'help', 'watch');
  assert.equal(help.status, 0, help.stderr);
  const lines = help.stdout.trimEnd().split('\n');
  const example = lines.indexOf('Example:');
  assert.deepEqual(lines.slice(example + 2), [
    'Claude Code: run pullboard watch --to <your id> under the Monitor tool, and each event line wakes the seat.',
    'Any other harness: run it as a long-running command and treat each stdout line as an event.',
  ], 'the two harness instructions end the help: one command\'s help adds no next line after its example [N37]');
  const { agentsBlock } = await import('../../../../packages/doctrine/light.js');
  const listen = agentsBlock().split('\n').find((line) => line.startsWith('**Listen.**'));
  assert.ok(listen, 'the AGENTS.md that init writes has a Listen paragraph');
  assert.match(listen, /run `pullboard watch --to <your id>` there/u);
  assert.match(listen, /read `pullboard inbox` at session start, after submit and before ending a turn/u);
  assert.match(listen, /Coordinator answers and sentinel findings arrive there/u);
  const written = readFileSync(join(box.root, 'AGENTS.md'), 'utf8');
  assert.ok(written.includes(listen), 'pullboard init wrote that paragraph into the repo');
});


test('a shout about an item reaches only the people on it [B7,A2,N19]', async (t) => {
  const box = await project();
  const builder = await box.local(box.root, 'worktree', 'app', '--model', 'item-message-builder');
  const reviewer = await box.local(box.root, 'worktree', 'docs', '--model', 'item-message-reviewer');
  const outsider = await box.local(box.root, 'worktree', 'app', '--model', 'item-message-outsider');
  const item = (await box.local(box.root, 'add', 'app', 'Directed item message', '--criterion', 'a private item thread', '--specs', 'G1')).item;
  await box.local(builder.path, 'claim', String(item.item_id));
  mkdirSync(join(builder.path, 'app'), { recursive: true });
  writeFileSync(join(builder.path, 'app', 'message.txt'), 'built\n');
  runFixtureGit(['add', '-A'], { cwd: builder.path, env: box.env, stdio: 'pipe' });
  runFixtureGit(['commit', '-q', '-m', 'feat(app): directed message fixture [G1]'], { cwd: builder.path, env: box.env, stdio: 'pipe' });
  await box.local(builder.path, 'submit', String(item.item_id));
  // Fixture setup uses the public board API: routing needs a reviewer role, not a second runtime session's verdict.
  // @pullboard-board-file journey: seed the persisted reservation read by later independent CLI watch processes.
  const board = openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  try { reserveReview(board, item.item_id, { agentId: reviewer.agent, leaseMs: 30 * 60_000, policy: 'any' }); }
  finally { board.db.close(); }
  for (const seat of [builder, reviewer, outsider]) await box.local(seat.path, 'inbox');
  const watches = [builder, reviewer, outsider].map((seat, index) => startWatch(box,
    ['--json', '--kinds', 'shout', ...(index < 2 ? ['--to', seat.agent] : [])], { cwd: seat.path }));
  t.after(async () => { for (const watch of watches) await watch.stop(); });
  for (const watch of watches) await watch.note((line) => /following/u.test(line), 10_000, 'directed watch startup'); // budget: startup hang ceiling, not a latency claim.
  await box.local(box.root, 'shout', 'app', 'only this item needs the message', '--item', String(item.item_id));
  const directed = lastSequence(box);
  assert.equal(events(box).find((event) => event.event_id === directed).item_id, item.item_id,
    'the message is an event in the item thread, rather than an unbound lane broadcast');
  assert.ok((await box.local(box.root, 'show', String(item.item_id))).thread.some((entry) => entry.kind === 'shout'
    && entry.detail.text === 'only this item needs the message'), 'show exposes the item message in its append-only thread');
  await box.local(box.root, 'shout', 'all', 'ordered delivery barrier');
  const barrier = lastSequence(box);
  for (const watch of watches) await watch.line((line) => JSON.parse(line).sequence === barrier, 5_000, 'ordered barrier after directed message'); // budget: stream hang ceiling, not a latency claim.
  for (const [index, watch] of watches.entries()) {
    const records = watch.out.lines.map(({ line }) => JSON.parse(line));
    assert.equal(records.some((record) => record.sequence === directed), index < 2,
      'the builder and cross-lane reviewer receive the item message; the same-lane outsider does not');
  }
  for (const [index, seat] of [builder, reviewer, outsider].entries()) {
    const card = await box.local(seat.path, 'resume');
    assert.equal(card.unread, index < 2 ? 2 : 1, 'resume counts only the item participants plus the public barrier');
    const inbox = (await box.local(seat.path, 'inbox')).shouts;
    assert.equal(inbox.some((shout) => shout.shout_text === 'only this item needs the message'), index < 2,
      'inbox uses the same item audience as watch and resume');
  }
  const coordinatorWatch = startWatch(box, ['--json', '--kinds', 'shout', '--to', 'coordinator']);
  const personWatch = startWatch(box, ['--json', '--kinds', 'shout', '--to', 'person']);
  t.after(async () => { await coordinatorWatch.stop(); await personWatch.stop(); });
  for (const watch of [coordinatorWatch, personWatch]) await watch.note((line) => /following/u.test(line), 10_000, 'coordination audience startup'); // budget: startup hang ceiling, not a latency claim.
  const sent = await box.runLocal(outsider.path, 'shout', 'all', 'a seat reports only to coordination', '--json');
  assert.equal(sent.status, 0, 'a seat shout to all is accepted under the corrected bar');
  const privateSequence = lastSequence(box);
  await box.local(box.root, 'shout', 'all', 'coordinator global delivery barrier');
  const publicSequence = lastSequence(box);
  for (const watch of [...watches, coordinatorWatch, personWatch]) await watch.line((line) => JSON.parse(line).sequence === publicSequence, 5_000, 'global barrier after coordination-only shout'); // budget: stream hang ceiling, not a latency claim.
  for (const watch of watches) assert.equal(watch.out.lines.some(({ line }) => JSON.parse(line).sequence === privateSequence), false,
    'a seat shout to all is not delivered to any of the three seats');
  for (const watch of [coordinatorWatch, personWatch]) assert.equal(watch.out.lines.some(({ line }) => JSON.parse(line).sequence === privateSequence), true,
    'the coordinator and person both receive the accepted seat report');
  for (const seat of [builder, reviewer, outsider]) {
    assert.equal((await box.local(seat.path, 'resume')).unread, 1, 'only the coordinator global barrier is unread');
    const inbox = (await box.local(seat.path, 'inbox')).shouts;
    assert.equal(inbox.some((shout) => shout.shout_text === 'a seat reports only to coordination'), false);
    assert.equal(inbox.some((shout) => shout.shout_text === 'coordinator global delivery barrier'), true);
  }
  assert.equal((await box.local(box.root, 'inbox')).shouts.some((shout) => shout.shout_text === 'a seat reports only to coordination'), true);
});


test('watch follows typed news by native kind and canonical addressee [A2,N26,H16]', async (t) => {
  const box = await project();
  const before = events(box).length;
  const watch = startWatch(box, ['--json', '--kinds', 'shout_news', '--to', 'app']);
  t.after(() => watch.stop('SIGKILL'));
  await watch.note(line => /following the board directly/u.test(line), 10_000, 'typed-news watch startup'); // budget: startup hang ceiling, not a latency claim.
  await box.local(box.root, 'shout', 'all', 'The first private release is ready', '--news');
  const first = events(box).at(-1);
  assert.equal(first.event_kind, 'shout_news');
  await watch.line(line => JSON.parse(line).sequence === first.event_id, 5_000, 'first typed news'); // budget: stream hang ceiling, not a latency claim.
  await box.local(box.root, 'shout', 'all', 'An ordinary governing message keeps its original kind');
  const ordinary = events(box).at(-1);
  assert.equal(ordinary.event_kind, 'shout');
  await box.local(box.root, 'shout', 'all', 'The second private release is ready', '--news');
  const second = events(box).at(-1);
  await watch.line(line => JSON.parse(line).sequence === second.event_id, 5_000, 'second typed news'); // budget: ordered-stream hang ceiling, not a latency claim.
  assert.deepEqual(await watch.stop('SIGTERM'), { code: 0, signal: null });
  const printed = watch.out.lines.map(({ line }) => JSON.parse(line));
  assert.deepEqual(printed.map(record => record.sequence), [first.event_id, second.event_id], 'kind filtering remains literal');
  assert.deepEqual(printed.map(record => record.detail),
    ['to all: The first private release is ready', 'to all: The second private release is ready'], 'news resolves the same canonical recipient and text');
  assert.ok(printed.every(record => record.kind === 'shout_news' && record.actor === 'coordinator' && record.item === null));
  assert.equal(events(box).length, before + 3, 'watch creates no native event');
});
