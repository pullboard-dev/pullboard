/** A mark the board refuses as busy waits in the spool and is replayed with its original time by the next mark that writes, once per mark [C7,#12158]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { replaySpool } from '../../src/io/mark-spool.js';
import { spoolMark } from '../../src/io/mark-spool.js';
import { spoolPath } from '../../src/io/mark-spool.js';
import { writeBoardCommand } from '../../../../packages/store/index.js';
import { cli } from '../fixtures/next/take.js';
import { fixture } from '../fixtures/next/take.js';

const marks = (box, id) => box.board.db.prepare("SELECT event_by, event_detail FROM event WHERE item_id=? AND event_kind='mark' ORDER BY event_id").all(id).map(row => ({ by: row.event_by, ...JSON.parse(row.event_detail) }));
const spooled = box => (existsSync(spoolPath(box.file)) ? readFileSync(spoolPath(box.file), 'utf8').split('\n').filter(Boolean).map(text => JSON.parse(text)) : []);
const mark = async (box, ...args) => cli(box, box.seats.builder.path, ['mark', ...args]);

/** Hold the board's write lock from a second connection until the returned release runs, the way a busy board looks to a caller. */
function holdBusy(box) {
  const lock = new DatabaseSync(box.file);
  lock.exec('BEGIN IMMEDIATE');
  return () => { lock.exec('ROLLBACK'); lock.close(); };
}

test('cli.mark.spool-when-busy: clause 1: with the board held busy, pullboard mark exits 0, writes no event and adds one spool line carrying the original at [C7,#12158]', async t => {
  const box = await fixture(t);
  const id = box.add('Spooled item');
  const at = new Date(box.clock.now().getTime() - 120_000).toISOString();
  const release = holdBusy(box);
  try {
    const ran = await mark(box, String(id), 'smoke', '--start', '--ref', 'abc123', '--at', at);
    assert.equal(ran.code, 0, ran.out + ran.err);
  } finally { release(); }
  assert.equal(marks(box, id).length, 0, 'a busy board gets no event');
  const lines = spooled(box);
  assert.equal(lines.length, 1, 'one spool line');
  assert.deepEqual({ item: lines[0].item, stage: lines[0].stage, edge: lines[0].edge, ref: lines[0].ref, at: lines[0].at, agentId: lines[0].agentId },
    { item: id, stage: 'smoke', edge: 'start', ref: 'abc123', at: Date.parse(at), agentId: box.seats.builder.id });
  assert.equal(typeof lines[0].id, 'string');
});

test('cli.mark.replay-original-at: clause 1: the next mark after the board frees writes the spooled mark first with its original at, then its own, and leaves the spool empty [C7,#12158]', async t => {
  const box = await fixture(t);
  const id = box.add('Replayed item');
  const at = new Date(box.clock.now().getTime() - 120_000).toISOString();
  const release = holdBusy(box);
  try { assert.equal((await mark(box, String(id), 'smoke', '--start', '--at', at)).code, 0); } finally { release(); }
  const ran = await mark(box, String(id), 'smoke', '--end');
  assert.equal(ran.code, 0, ran.out + ran.err);
  const written = marks(box, id);
  assert.deepEqual(written.map(row => [row.stage, row.edge]), [['smoke', 'start'], ['smoke', 'end']], 'the spooled mark lands first, then the caller\'s own');
  assert.equal(written[0].at, Date.parse(at), 'the spooled mark keeps its original at');
  assert.equal(written[1].at, box.clock.now().getTime());
  assert.equal(readFileSync(spoolPath(box.file), 'utf8'), '', 'the spool is empty after the replay');
});

test('cli.mark.replay-no-double: clause 2: a spool replayed twice, with a crash after the first write, yields one row per mark [C7,#12158]', async t => {
  const box = await fixture(t);
  const id = box.add('Doubled item');
  const agentId = box.seats.builder.id;
  const base = box.clock.now().getTime();
  for (const [n, stage] of ['smoke', 'gate'].entries()) spoolMark(box.file, { id: `spool-${n}`, item: id, agentId, stage, edge: 'point', reason: null, ref: null, at: base - 60_000 + n });
  let writes = 0;
  const write = ({ item, id: markId, agentId: by, stage, edge, reason, ref, at }) => {
    if (writes === 1) throw new Error('crash after the first write');
    writes++;
    writeBoardCommand(box.board, 'appendMark', [item, { id: markId, agentId: by, stage, edge, reason, ref, at }], by);
  };
  await assert.rejects(replaySpool(box.file, box.board, write), /crash after the first write/u);
  assert.equal(marks(box, id).length, 1, 'the crash left one written mark');
  writes = 99;
  assert.equal(await replaySpool(box.file, box.board, write), 1, 'the second replay writes only the mark the first did not');
  assert.deepEqual(marks(box, id).map(row => row.stage), ['smoke', 'gate'], 'one row per mark');
  assert.equal(await replaySpool(box.file, box.board, write), 0, 'an empty spool writes nothing');
});
