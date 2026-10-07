/** Opaque relay transport ordering, independent of the pending record interpretation [A4,H7]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRelayJournal } from '../relay/journal.js';

const ID = 'a'.repeat(32);
const AGENT = { kind: 'agent', userId: '101', agent: 'client-one' };
const PERSON = { kind: 'person', userId: '101' };

/** Give each test a private directory and close every journal before deleting its files. */
function fixture(t, options = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-relay-order-')));
  const opened = [];
  t.after(() => { for (const journal of opened) journal.close(); rmSync(directory, { recursive: true, force: true }); });
  /** Open the same durable journal through its public interface. */
  function open(overrides = {}) {
    const raw = createRelayJournal({ directory, boardId: ID, ...options, ...overrides });
    /** Supply the synthetic authenticated agent for this transport-only fixture. */
    function append(sequence, bytes, kind = 'move', principal = AGENT) { return raw.append(sequence, bytes, kind, principal); }
    /** Supply the synthetic authenticated agent when the server allocates a position. */
    function appendNext(bytes, kind = 'move', principal = AGENT) { return raw.appendNext(bytes, kind, principal); }
    /** Only the fixture's signed-in person may replace a compacted snapshot. */
    function saveSnapshot(sequence, bytes, principal = PERSON) { return raw.saveSnapshot(sequence, bytes, principal); }
    const journal = { ...raw, append, appendNext, saveSnapshot };
    opened.push(journal);
    return journal;
  }
  return { directory, open, journal: open() };
}

test('[A4,H7] ordered opaque bytes survive restart without parsing or aliasing', (t) => {
  const box = fixture(t, { now: () => new Date('2026-10-07T00:00:00Z') });
  assert.equal(box.journal.latest(), 0);
  const bytes = Buffer.from([0, 255, 1, 128, 0]);
  const first = box.journal.append(1, bytes);
  assert.equal(first.sequence, 1);
  assert.equal(first.receivedAt, '2026-10-07T00:00:00.000Z');
  assert.deepEqual(first.bytes, bytes);
  assert.deepEqual(first.sender, AGENT);
  first.sender.agent = 'forged';
  assert.deepEqual(box.journal.after()[0].sender, AGENT, 'returned sender objects never alias stored attribution');
  bytes.fill(0);
  first.bytes.fill(0);
  assert.deepEqual(box.journal.after()[0].bytes, Buffer.from([0, 255, 1, 128, 0]));
  box.journal.append(2, Buffer.from('an uninterpreted record'));
  assert.deepEqual(box.journal.after(1).map((row) => row.sequence), [2]);
  box.journal.close();
  const reopened = box.open();
  assert.equal(reopened.latest(), 2);
  assert.deepEqual(reopened.after().map((row) => row.sequence), [1, 2]);
  assert.equal(statSync(join(box.directory, ID + '.journal.sqlite')).mode & 0o077, 0);
});

test('[A4] gaps, repeats, invalid uploads and clock failures leave the prefix unchanged', (t) => {
  const box = fixture(t, { maxBytes: 4 });
  assert.throws(() => box.journal.append(2, Buffer.from('x')), { code: 'SEQUENCE_GAP' });
  assert.equal(box.journal.latest(), 0);
  box.journal.append(1, Buffer.from('one'));
  for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2']) {
    assert.throws(() => box.journal.append(sequence, Buffer.from('x')), { code: 'BAD_SEQUENCE' });
  }
  assert.throws(() => box.journal.append(1, Buffer.from('new')), { code: 'SEQUENCE_REPEAT' });
  assert.throws(() => box.journal.append(3, Buffer.from('new')), { code: 'SEQUENCE_GAP' });
  for (const bytes of ['', Buffer.alloc(0), Buffer.from('large')]) {
    assert.throws(() => box.journal.append(2, bytes), { code: 'BAD_UPLOAD' });
  }
  assert.throws(() => box.journal.after(-1), { code: 'BAD_CURSOR' });
  assert.throws(() => box.journal.after('0'), { code: 'BAD_CURSOR' });
  assert.throws(() => box.journal.append(2, Buffer.from('x'), 'move', null), { code: 'RELAY_PRINCIPAL' });
  assert.throws(() => box.journal.saveSnapshot(0, Buffer.from('x'), AGENT), { code: 'HUMAN_REQUIRED' });
  assert.equal(box.journal.latest(), 1);
  box.journal.close();
  const badClock = box.open({ now: () => new Date(NaN) });
  assert.throws(() => badClock.append(2, Buffer.from('two')), { code: 'RELAY_CONFIG' });
  assert.equal(badClock.latest(), 1);
  assert.equal(badClock.after()[0].bytes.toString(), 'one');
});

test('[A4,H7] two real processes cannot publish the same next sequence', async (t) => {
  const box = fixture(t);
  box.journal.close();
  const worker = join(box.directory, 'worker.mjs');
  const module = new URL('../relay/journal.js', import.meta.url).href;
  writeFileSync(worker, [
    'import { createRelayJournal } from ' + JSON.stringify(module) + ';',
    'const journal = createRelayJournal({ directory: process.argv[2], boardId: process.argv[3] });',
    'const sender = {kind:"agent",userId:"101",agent:"worker"};',
    'try {',
    '  const row = process.argv[4].startsWith("auto ") ? journal.appendNext(Buffer.from(process.argv[4]),"move",sender) : journal.append(1, Buffer.from(process.argv[4]),"move",sender);',
    '  process.stdout.write(JSON.stringify({ sequence: row.sequence }));',
    '} catch (error) { process.stdout.write(JSON.stringify({ code: error.code })); }',
    'finally { journal.close(); }',
  ].join('\n'));
  /** Capture only the synthetic sequence/refusal result of one owned worker. */
  function run(label) {
    return new Promise((done, fail) => {
      const child = spawn(process.execPath, [worker, box.directory, ID, label], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let diagnostics = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { diagnostics += chunk; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new Error('journal worker timed out')); }, 10_000);
      child.once('error', (error) => { clearTimeout(timer); fail(error); });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) return fail(new Error('journal worker failed: ' + diagnostics));
        try { done(JSON.parse(out)); } catch (error) { fail(error); }
      });
    });
  }
  const results = await Promise.all([run('first record'), run('second record')]);
  assert.equal(results.filter((row) => row.sequence === 1).length, 1);
  assert.equal(results.filter((row) => row.code === 'SEQUENCE_REPEAT').length, 1);
  const journal = box.open();
  assert.equal(journal.latest(), 1);
  assert.equal(journal.after().length, 1);
  assert.ok(['first record', 'second record'].includes(journal.after()[0].bytes.toString()));
  journal.close();
  const allocated = await Promise.all([run('auto first'), run('auto second')]);
  assert.deepEqual(allocated.map((row) => row.sequence).sort(), [2, 3]);
  const ordered = box.open();
  assert.deepEqual(ordered.after().map((row) => row.sequence), [1, 2, 3]);
});

test('[H7] board identities isolate journals and cannot follow a symlink', (t) => {
  const box = fixture(t);
  box.journal.append(1, Buffer.from('first board'));
  const other = box.open({ boardId: 'b'.repeat(32) });
  assert.equal(other.latest(), 0);
  other.append(1, Buffer.from('second board'));
  assert.equal(box.journal.after()[0].bytes.toString(), 'first board');
  assert.equal(other.after()[0].bytes.toString(), 'second board');
  assert.throws(() => box.open({ boardId: '../outside' }), { code: 'BAD_BOARD' });
  symlinkSync(join(box.directory, ID + '.journal.sqlite'), join(box.directory, 'c'.repeat(32) + '.journal.sqlite'));
  assert.throws(() => box.open({ boardId: 'c'.repeat(32) }), { code: 'RELAY_STORAGE' });
  box.journal.close();
  assert.throws(() => box.journal.latest(), { code: 'RELAY_CLOSED' });
});


test('[A4,H7] a sealed snapshot compacts its prefix without reusing sequence numbers', (t) => {
  const box = fixture(t);
  assert.equal(box.journal.snapshot(), null);
  box.journal.saveSnapshot(0, Buffer.from('initial opaque snapshot'));
  box.journal.appendNext(Buffer.from('opaque move one'));
  box.journal.appendNext(Buffer.from('opaque move two'));
  box.journal.appendNext(Buffer.from('opaque move three'));
  box.journal.saveSnapshot(2, Buffer.from('snapshot through two'));
  assert.equal(box.journal.snapshot().sequence, 2);
  assert.deepEqual(box.journal.snapshot().sender, PERSON);
  assert.equal(box.journal.snapshot().bytes.toString(), 'snapshot through two');
  assert.deepEqual(box.journal.after().map((row) => row.sequence), [3]);
  assert.equal(box.journal.latest(), 3);
  assert.throws(() => box.journal.saveSnapshot(1, Buffer.from('stale')), { code: 'SNAPSHOT_STALE' });
  assert.throws(() => box.journal.saveSnapshot(4, Buffer.from('gap')), { code: 'SEQUENCE_GAP' });
  assert.equal(box.journal.snapshot().sequence, 2);
  assert.deepEqual(box.journal.after().map((row) => row.sequence), [3]);
  box.journal.saveSnapshot(3, Buffer.from('snapshot through three'));
  assert.deepEqual(box.journal.after(), []);
  box.journal.close();
  const restarted = box.open();
  assert.equal(restarted.latest(), 3);
  assert.equal(restarted.snapshot().sequence, 3);
  assert.equal(restarted.appendNext(Buffer.from('move after compaction')).sequence, 4);
  assert.throws(() => restarted.append(2, Buffer.from('retry old prefix')), { code: 'SEQUENCE_REPEAT' });
});
