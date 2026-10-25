/** pullboard watch follows the board's live event stream, from a real CLI on a real board [A2,N26]. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, loadavg, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { openBoard, reserveReview } from '../src/board.js';
import { runFixtureChild, runFixtureGit, startFixtureChild } from './fixture-child.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
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
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Watch Test', GIT_AUTHOR_EMAIL: 'watch@example.invalid',
    GIT_COMMITTER_NAME: 'Watch Test', GIT_COMMITTER_EMAIL: 'watch@example.invalid',
  };
}

/** A private Git repo with an initialized board, two lanes and a gate that passes. */
function project() {
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
  const run = (cwd, ...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
  /** Run one CLI command with --json and return its document. */
  const cli = (cwd, ...args) => {
    const result = run(cwd, ...args, '--json');
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}${result.stdout}`);
    return JSON.parse(result.stdout);
  };
  git('init', '-q', '-b', 'main');
  cli(root, 'init');
  const configFile = join(root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, gate: 'true', spec: 'SPEC.md', practice: 'DOCTRINE.md',
    lanes: { app: { owns: ['app/'], specs: ['G1'] }, docs: { owns: ['docs/'], specs: ['G1'] } }, shared: [] }, null, 2) + '\n');
  writeFileSync(join(root, 'SPEC.md'), '# Watch fixture\n\n## Goals\n- G1 [approved, must] Keep the board. | gate: true\n');
  writeFileSync(join(root, 'DOCTRINE.md'), '');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: watch fixture');
  return { dir, root, home, env, git, run, cli };
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

test('pullboard watch prints a move as it happens [A2,N26]', async (t) => {
  const box = project();
  assert.equal(readdirSync(box.home).some((name) => /^view(?:-\d+)?\.json$/u.test(name)), false, 'no view runs for this board');
  const before = events(box).length;
  const watch = startWatch(box, []);
  t.after(() => watch.stop('SIGKILL'));
  await watch.note((line) => /following the board directly/u.test(line), 10_000, 'note that it follows the board directly'); // budget: hang ceiling for CLI startup, not a latency claim.

  const added = box.cli(box.root, 'add', 'app', 'Live watch item', '--criterion', 'arrives on the live stream', '--specs', 'G1').item;
  const moved = Date.now();
  const event = events(box).at(-1);
  assert.equal(event.item_id, added.item_id);
  const printed = await watch.line((line) => line.startsWith(`${event.event_id} `), 2_000, 'line for the add'); // budget: declared by #544's frozen criterion (within two seconds); a hang ceiling for one line.
  assert.ok(printed.at - moved <= 2_000, 'the line arrives within two seconds of the move'); // budget: declared by #544's frozen criterion (within two seconds).
  assert.equal(printed.line, `${event.event_id} add #${added.item_id} ${event.event_by} Live watch item (lane app, route strong)`,
    'one line: sequence, kind, item, actor and a short detail');

  const stopped = await watch.stop('SIGINT');
  assert.deepEqual(stopped, { code: 0, signal: null }, 'Ctrl-C stops watch cleanly');
  assert.equal(watch.out.lines.length, 1, 'one line per event, and nothing else on stdout');
  assert.equal(events(box).length, before + 1, 'watch wrote no event: the only new one is the add');
});

test('a dropped watch resumes from its last event [A2,N26]', async (t) => {
  const box = project();
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

  box.cli(box.root, 'shout', 'app', 'first, through the view');
  const first = events(box).at(-1);
  await watch.line((line) => JSON.parse(line).sequence === first.event_id, 5_000, 'first shout'); // budget: hang ceiling for one line, not a latency claim.

  // Stop the view by its own pid: its stream ends, and watch must carry on from its last event.
  view.kill('SIGTERM');
  await viewClosed;
  box.cli(box.root, 'shout', 'app', 'second, while the stream was down');
  const second = events(box).at(-1);
  await watch.note((line) => /following the board directly/u.test(line), 10_000, 'note that it follows the board directly'); // budget: hang ceiling for reconnecting, not a latency claim.
  box.cli(box.root, 'shout', 'all', 'third, after the stream came back');
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
  const box = project();
  const builder = box.cli(box.root, 'worktree', 'app', '--model', 'watch-builder');
  const waiting = box.cli(box.root, 'add', 'app', 'Waits on another item', '--criterion', 'waits', '--specs', 'G1', '--check', 'true', '--wait').item;
  box.cli(box.root, 'check', 'accept', String(waiting.item_id)); // #728 holds a check already green on main until the person accepts it.
  const before = events(box).length;
  const watch = startWatch(box, ['--json', '--work', 'app', '--review-wait', '0.02']);
  t.after(() => watch.stop('SIGKILL'));
  await watch.note((line) => /following the board directly/u.test(line), 10_000, 'note that it follows the board directly'); // budget: hang ceiling for CLI startup, not a latency claim.
  assert.equal(watch.out.lines.length, 0, 'work already claimable when watch starts is its baseline, so it prints nothing');

  // A newly opened item in the lane is claimable.
  const added = box.cli(box.root, 'add', 'app', 'Fresh app work', '--criterion', 'claimable', '--specs', 'G1', '--check', 'true', '--wait').item;
  const notice = JSON.parse((await watch.line((line) => JSON.parse(line).kind === 'claimable', 5_000, 'claimable notice')).line); // budget: hang ceiling for one line, not a latency claim.
  assert.equal(notice.item, added.item_id);
  assert.equal(notice.notice, true);
  assert.equal(notice.detail, 'app: Fresh app work');
  const noticed = events(box).find(event => event.event_id === notice.sequence);
  assert.equal(noticed.item_id, added.item_id, 'the notice follows its new item');
  assert.ok(['add', 'check-baseline'].includes(noticed.event_kind), 'the notice follows the add or its actual baseline observation');
  assert.equal(added.item_check_baseline.result, 'green', 'the baseline is finished before later move assertions');
  const blocked = box.cli(box.root, 'add', 'app', 'Waits for the fresh work', '--criterion', 'after', '--specs', 'G1', '--after', String(added.item_id)).item;

  // A released claim makes the item claimable again.
  box.cli(builder.path, 'claim', String(waiting.item_id));
  // A later existing event acknowledges the preceding claim's work check, not merely its printed raw line.
  box.cli(box.root, 'check', 'accept', String(added.item_id)); // #728's person acceptance also supplies the ordered barrier.
  const claimObserved = lastSequence(box);
  await watch.line((line) => JSON.parse(line).sequence === claimObserved && JSON.parse(line).kind === 'check_accept',
    5_000, 'event after the claim work check'); // budget: hang ceiling for an exact event, not a latency claim.
  box.cli(builder.path, 'release', String(waiting.item_id));
  const releaseSequence = lastSequence(box);
  await watch.line((line) => JSON.parse(line).kind === 'release' && JSON.parse(line).sequence === releaseSequence,
    5_000, 'release event'); // budget: hang ceiling for an exact event, not a latency claim.
  // A work check may see the new board state while processing the preceding barrier event.
  const released = JSON.parse((await watch.line((line) => JSON.parse(line).kind === 'claimable' && JSON.parse(line).item === waiting.item_id
    && JSON.parse(line).sequence >= claimObserved && JSON.parse(line).sequence <= releaseSequence,
    5_000, 'claimable notice after release')).line); // budget: hang ceiling for one line, not a latency claim.
  assert.equal(released.detail, 'app: Waits on another item');

  // A submission nobody reserves is announced once it has waited past --review-wait (1.2 s here).
  box.cli(builder.path, 'claim', String(added.item_id));
  mkdirSync(join(builder.path, 'app'), { recursive: true });
  writeFileSync(join(builder.path, 'app', 'work.txt'), 'built\n');
  runFixtureGit(['add', '-A'], { cwd: builder.path, env: box.env, stdio: 'pipe' });
  runFixtureGit(['commit', '-q', '-m', 'feat(app): fresh work [G1]'], { cwd: builder.path, env: box.env, stdio: 'pipe' });
  const firstSubmission = box.cli(builder.path, 'submit', String(added.item_id));
  const firstCommit = firstSubmission.commit;
  const submitted = lastSequence(box);
  const review = JSON.parse((await watch.line((line) => JSON.parse(line).kind === 'review-wait', 10_000, 'review-wait notice')).line); // budget: hang ceiling for a 1.2 s review threshold, not a latency claim.
  assert.equal(review.item, added.item_id);
  assert.match(review.detail, /^app: Fresh app work, waiting for review since /u);
  assert.equal(lastSequence(box), submitted, 'the threshold woke watch with no new board event');

  // Accepting the work an item waits on makes that item claimable.
  const reviewer = join(box.dir, 'reviewer');
  box.git('worktree', 'add', '-q', '--detach', reviewer, firstCommit);
  box.cli(reviewer, 'join', 'docs', '--model', 'watch-reviewer');
  box.cli(reviewer, 'next', '--verify', String(added.item_id));
  box.cli(reviewer, 'verify', String(added.item_id), 'accept', '--note', 'read the fixture file');
  const unblocked = JSON.parse((await watch.line((line) => JSON.parse(line).kind === 'claimable' && JSON.parse(line).item === blocked.item_id, 5_000, 'claimable notice after its wait was verified')).line); // budget: hang ceiling for one line, not a latency claim.
  assert.equal(unblocked.detail, 'app: Waits for the fresh work');

  // A rejected submission is claimable again.
  box.cli(builder.path, 'claim', String(waiting.item_id));
  writeFileSync(join(builder.path, 'app', 'waiting.txt'), 'built\n');
  runFixtureGit(['add', '-A'], { cwd: builder.path, env: box.env, stdio: 'pipe' });
  runFixtureGit(['commit', '-q', '-m', 'feat(app): waiting work [G1]'], { cwd: builder.path, env: box.env, stdio: 'pipe' });
  const secondSubmission = box.cli(builder.path, 'submit', String(waiting.item_id));
  const secondCommit = secondSubmission.commit;
  runFixtureGit(['switch', '-q', '--detach', secondCommit], { cwd: reviewer, env: box.env, stdio: 'pipe' });
  box.cli(reviewer, 'next', '--verify', String(waiting.item_id));
  // The reserve line follows the submit work check while the item is still submitted, before reject reopens it.
  const submissionObserved = lastSequence(box);
  await watch.line((line) => JSON.parse(line).sequence === submissionObserved && JSON.parse(line).kind === 'reserve',
    5_000, 'event after the submit work check'); // budget: hang ceiling for an exact event, not a latency claim.
  box.cli(reviewer, 'verify', String(waiting.item_id), 'reject', '--reason', 'TEST_FAILURE', '--note', 'the fixture sends it back');
  const rejectSequence = lastSequence(box);
  await watch.line((line) => JSON.parse(line).kind === 'reject' && JSON.parse(line).sequence === rejectSequence, 5_000, 'reject line'); // budget: hang ceiling for one line, not a latency claim.
  const again = await watch.line((line) => JSON.parse(line).kind === 'claimable' && JSON.parse(line).item === waiting.item_id
    && JSON.parse(line).sequence >= submissionObserved && JSON.parse(line).sequence <= rejectSequence,
    5_000, 'claimable notice after reject'); // budget: hang ceiling for one line, not a latency claim.
  assert.equal(JSON.parse(again.line).detail, 'app: Waits on another item');

  // Main moving is a notice too.
  box.git('commit', '-q', '--allow-empty', '-m', 'chore: move main');
  const head = box.git('rev-parse', 'HEAD');
  const main = JSON.parse((await watch.line((line) => JSON.parse(line).kind === 'main', 5_000, 'main notice')).line); // budget: hang ceiling for one line, not a latency claim.
  assert.equal(main.commit, head);
  assert.equal(main.detail, `main moved to ${head}`);

  assert.deepEqual(await watch.stop('SIGINT'), { code: 0, signal: null });
  const kinds = watch.out.lines.map(({ line }) => JSON.parse(line).kind);
  assert.equal(watch.out.lines.filter(({ line }) => JSON.parse(line).kind === 'review-wait' && JSON.parse(line).item === added.item_id).length, 1,
    'a waiting review is announced once');
  assert.ok(kinds.includes('accept') && kinds.includes('reject'), 'the verdicts print as events too');
  const recorded = events(box).slice(before);
  assert.deepEqual(recorded.map(event => event.event_kind), [
    'add', 'add', 'claim', 'check_accept', 'release', 'claim', 'proof-run', 'proof-run',
    'submit', ...(firstSubmission.activity.digests.length ? ['activity-delivered'] : []), 'join', 'reserve', 'proof-run', 'accept', 'claim', 'proof-run', 'proof-run',
    'submit', ...(secondSubmission.activity.digests.length ? ['activity-delivered'] : []), 'reserve', 'reject',
  ], 'watch wrote no event: only the explicit moves and their native proof receipts were recorded');
  const proofs = recorded.filter(event => event.event_kind === 'proof-run');
  const receipts = proofs.map(event => JSON.parse(event.event_detail).receipt);
  assert.deepEqual(receipts.map(receipt => [receipt.item, receipt.commit]), [
    [added.item_id, firstCommit], [added.item_id, firstCommit], [added.item_id, firstCommit],
    [waiting.item_id, secondCommit], [waiting.item_id, secondCommit],
  ], 'only the two submits and the executed accept check recorded native proofs');
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
  const box = project();
  const other = box.cli(box.root, 'add', 'docs', 'Docs item', '--criterion', 'docs', '--specs', 'G1').item;
  const watch = startWatch(box, ['--json', '--to', 'app']);
  t.after(() => watch.stop('SIGKILL'));
  const items = startWatch(box, ['--kinds', 'edit', '--item', String(other.item_id)]);
  t.after(() => items.stop('SIGKILL'));
  await watch.note((line) => /following/u.test(line), 10_000, 'start note'); // budget: hang ceiling for CLI startup, not a latency claim.
  await items.note((line) => /following/u.test(line), 10_000, 'start note'); // budget: hang ceiling for CLI startup, not a latency claim.

  box.cli(box.root, 'shout', 'docs', 'for docs only');
  const app = box.cli(box.root, 'add', 'app', 'App item', '--criterion', 'app', '--specs', 'G1').item;
  box.cli(box.root, 'shout', 'app', 'for app');
  box.cli(box.root, 'edit', String(app.item_id), '--brief', 'App brief');
  box.cli(box.root, 'fact', String(other.item_id), 'note', 'a fact on the docs item');
  box.cli(box.root, 'edit', String(other.item_id), '--brief', 'Docs brief');
  box.cli(box.root, 'shout', 'all', 'for everyone');
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
    const refused = box.run(box.root, 'watch', ...args, '--json');
    assert.equal(refused.status, 1, `${args.join(' ')}: ${refused.stdout}${refused.stderr}`);
    const { error } = JSON.parse(refused.stdout);
    assert.equal(error.code, 'USAGE');
    assert.match(error.message, pattern);
    assert.ok(error.next, 'the refusal names a next step');
  }
});

test('help watch and the generated agent instructions teach seats to listen with watch [A2,I11]', async () => {
  const box = project();
  const help = box.run(box.root, 'help', 'watch');
  assert.equal(help.status, 0, help.stderr);
  const lines = help.stdout.trimEnd().split('\n');
  const example = lines.indexOf('Example:');
  assert.deepEqual(lines.slice(example + 2), [
    'Claude Code: run pullboard watch --to <your id> under the Monitor tool, and each event line wakes the seat.',
    'Any other harness: run it as a long-running command and treat each stdout line as an event.',
  ], 'two lines after the example: the Claude Code way and the way for any other harness');
  const { agentsBlock } = await import('../src/templates.js');
  const listen = agentsBlock().split('\n').find((line) => line.startsWith('**Listen.**'));
  assert.ok(listen, 'the AGENTS.md that init writes has a Listen paragraph');
  assert.match(listen, /run `pullboard watch --to <your id>` there/u);
  assert.match(listen, /read `pullboard inbox` at session start, after submit and before ending a turn/u);
  assert.match(listen, /Coordinator answers and sentinel findings arrive there/u);
  const written = readFileSync(join(box.root, 'AGENTS.md'), 'utf8');
  assert.ok(written.includes(listen), 'pullboard init wrote that paragraph into the repo');
});


test('a shout about an item reaches only the people on it [B7,A2,N19]', async (t) => {
  const box = project();
  const builder = box.cli(box.root, 'worktree', 'app', '--model', 'item-message-builder');
  const reviewer = box.cli(box.root, 'worktree', 'docs', '--model', 'item-message-reviewer');
  const outsider = box.cli(box.root, 'worktree', 'app', '--model', 'item-message-outsider');
  const item = box.cli(box.root, 'add', 'app', 'Directed item message', '--criterion', 'a private item thread', '--specs', 'G1').item;
  box.cli(builder.path, 'claim', String(item.item_id));
  mkdirSync(join(builder.path, 'app'), { recursive: true });
  writeFileSync(join(builder.path, 'app', 'message.txt'), 'built\n');
  runFixtureGit(['add', '-A'], { cwd: builder.path, env: box.env, stdio: 'pipe' });
  runFixtureGit(['commit', '-q', '-m', 'feat(app): directed message fixture [G1]'], { cwd: builder.path, env: box.env, stdio: 'pipe' });
  box.cli(builder.path, 'submit', String(item.item_id));
  // Fixture setup uses the public board API: routing needs a reviewer role, not a second runtime session's verdict.
  const board = openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  try { reserveReview(board, item.item_id, { agentId: reviewer.agent, leaseMs: 30 * 60_000, policy: 'any' }); }
  finally { board.db.close(); }
  for (const seat of [builder, reviewer, outsider]) box.cli(seat.path, 'inbox');
  const watches = [builder, reviewer, outsider].map((seat, index) => startWatch(box,
    ['--json', '--kinds', 'shout', ...(index < 2 ? ['--to', seat.agent] : [])], { cwd: seat.path }));
  t.after(async () => { for (const watch of watches) await watch.stop(); });
  for (const watch of watches) await watch.note((line) => /following/u.test(line), 10_000, 'directed watch startup'); // budget: startup hang ceiling, not a latency claim.
  box.cli(box.root, 'shout', 'app', 'only this item needs the message', '--item', String(item.item_id));
  const directed = lastSequence(box);
  assert.equal(events(box).find((event) => event.event_id === directed).item_id, item.item_id,
    'the message is an event in the item thread, rather than an unbound lane broadcast');
  assert.ok(box.cli(box.root, 'show', String(item.item_id)).thread.some((entry) => entry.kind === 'shout'
    && entry.detail.text === 'only this item needs the message'), 'show exposes the item message in its append-only thread');
  box.cli(box.root, 'shout', 'all', 'ordered delivery barrier');
  const barrier = lastSequence(box);
  for (const watch of watches) await watch.line((line) => JSON.parse(line).sequence === barrier, 5_000, 'ordered barrier after directed message'); // budget: stream hang ceiling, not a latency claim.
  for (const [index, watch] of watches.entries()) {
    const records = watch.out.lines.map(({ line }) => JSON.parse(line));
    assert.equal(records.some((record) => record.sequence === directed), index < 2,
      'the builder and cross-lane reviewer receive the item message; the same-lane outsider does not');
  }
  for (const [index, seat] of [builder, reviewer, outsider].entries()) {
    const card = box.cli(seat.path, 'resume');
    assert.equal(card.unread, index < 2 ? 2 : 1, 'resume counts only the item participants plus the public barrier');
    const inbox = box.cli(seat.path, 'inbox').shouts;
    assert.equal(inbox.some((shout) => shout.shout_text === 'only this item needs the message'), index < 2,
      'inbox uses the same item audience as watch and resume');
  }
  const coordinatorWatch = startWatch(box, ['--json', '--kinds', 'shout', '--to', 'coordinator']);
  const personWatch = startWatch(box, ['--json', '--kinds', 'shout', '--to', 'person']);
  t.after(async () => { await coordinatorWatch.stop(); await personWatch.stop(); });
  for (const watch of [coordinatorWatch, personWatch]) await watch.note((line) => /following/u.test(line), 10_000, 'coordination audience startup'); // budget: startup hang ceiling, not a latency claim.
  const sent = box.run(outsider.path, 'shout', 'all', 'a seat reports only to coordination', '--json');
  assert.equal(sent.status, 0, 'a seat shout to all is accepted under the corrected bar');
  const privateSequence = lastSequence(box);
  box.cli(box.root, 'shout', 'all', 'coordinator global delivery barrier');
  const publicSequence = lastSequence(box);
  for (const watch of [...watches, coordinatorWatch, personWatch]) await watch.line((line) => JSON.parse(line).sequence === publicSequence, 5_000, 'global barrier after coordination-only shout'); // budget: stream hang ceiling, not a latency claim.
  for (const watch of watches) assert.equal(watch.out.lines.some(({ line }) => JSON.parse(line).sequence === privateSequence), false,
    'a seat shout to all is not delivered to any of the three seats');
  for (const watch of [coordinatorWatch, personWatch]) assert.equal(watch.out.lines.some(({ line }) => JSON.parse(line).sequence === privateSequence), true,
    'the coordinator and person both receive the accepted seat report');
  for (const seat of [builder, reviewer, outsider]) {
    assert.equal(box.cli(seat.path, 'resume').unread, 1, 'only the coordinator global barrier is unread');
    const inbox = box.cli(seat.path, 'inbox').shouts;
    assert.equal(inbox.some((shout) => shout.shout_text === 'a seat reports only to coordination'), false);
    assert.equal(inbox.some((shout) => shout.shout_text === 'coordinator global delivery barrier'), true);
  }
  assert.equal(box.cli(box.root, 'inbox').shouts.some((shout) => shout.shout_text === 'a seat reports only to coordination'), true);
});


test('watch follows typed news by native kind and canonical addressee [A2,N26,H16]', async (t) => {
  const box = project();
  const before = events(box).length;
  const watch = startWatch(box, ['--json', '--kinds', 'shout_news', '--to', 'app']);
  t.after(() => watch.stop('SIGKILL'));
  await watch.note(line => /following the board directly/u.test(line), 10_000, 'typed-news watch startup'); // budget: startup hang ceiling, not a latency claim.
  box.cli(box.root, 'shout', 'all', 'The first private release is ready', '--news');
  const first = events(box).at(-1);
  assert.equal(first.event_kind, 'shout_news');
  await watch.line(line => JSON.parse(line).sequence === first.event_id, 5_000, 'first typed news'); // budget: stream hang ceiling, not a latency claim.
  box.cli(box.root, 'shout', 'all', 'An ordinary governing message keeps its original kind');
  const ordinary = events(box).at(-1);
  assert.equal(ordinary.event_kind, 'shout');
  box.cli(box.root, 'shout', 'all', 'The second private release is ready', '--news');
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
