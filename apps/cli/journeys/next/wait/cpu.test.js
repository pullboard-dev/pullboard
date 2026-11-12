/** Event-driven next and live gate streams remain idle and wake on real board writes [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import {
  dirname,
  join,
} from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { fileChangeWaiter } from '../../../../../packages/activity/index.js';
import { createApiHandler } from '../../../../../packages/api/index.js';
import {
  boardId,
  events,
  shout,
} from '../../../../../packages/store/index.js';
import { fixture } from '../../../tests/fixtures/next/take.js';
import { main } from '../../../tests/fixtures/native.js';

for (const kind of ['created WAL', 'atomic replacement', 'new parent']) {
  test(`file notifications retain a ${kind} change before sleeping [C7]`, async t => {
    const directory = join((await fixture(t)).root, 'file-wake');
    mkdirSync(directory);
    const file = kind === 'new parent' ? join(directory, 'nested', 'input') : join(directory, 'board.sqlite-wal');
    if (kind === 'atomic replacement') writeFileSync(file, 'old');
    const watcher = fileChangeWaiter([file]);
    t.after(() => watcher.close());
    const before = watcher.version();
    if (kind === 'atomic replacement') { writeFileSync(file + '.tmp', 'new'); renameSync(file + '.tmp', file); }
    else { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, 'new'); }
    await watcher.wait({ after: before });
    assert.equal(readFileSync(file, 'utf8'), 'new');
    assert.ok(watcher.version() > before, 'the write-to-wait gap cannot discard the change');
  });
}

test('a seat and gate event stream idle for 30 seconds below the declared CPU budget and wake on a shout [C7]', async t => {
  const box = await fixture(t);
  // The work arrives with the shout: a seat now moves to another lane's open work at once, so it cannot exist while the seat idles.
  let target;
  const actor = box.seats.actor, id = boardId(box.board);
  let notifications = 0, reads = 0, revision = 0;
  const streamWake = fileChangeWaiter([box.file, box.file + '-wal']);
  const handler = createApiHandler({
    refusalDocument: error => ({ version: 1, error: { code: error.code ?? 'SERVICE_ERROR', message: error.message } }),
    authenticate: () => ({ local: true }), board: () => ({ id }),
    events: (board, after) => { reads += 1; return events(box.board).filter(event => event.event_id > after); },
    watchRevision: () => ({ revision: () => revision,
      subscribe: listener => streamWake.subscribe(error => { notifications += 1; revision += 1; listener(error); }),
      close: () => streamWake.close() }),
  });
  const server = createServer(handler);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  let reader;
  t.after(async () => {
    try { await reader?.cancel(); }
    finally { handler.close(); await new Promise(done => { server.close(done); server.closeAllConnections(); }); }
  });
  const after = events(box.board).at(-1)?.event_id ?? 0;
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/boards/${id}/events?after=${after}`, { headers: { accept: 'text/event-stream' } });
  reader = response.body.getReader();
  await reader.read();
  let timer, cpuStart, quietCpu, quietAt, askedAt, shoutFinishedAt, outputAt, output = '', sent = false;
  let waitingReports = 0, stderrText = '', firstIdleCounts, quietCounts;
  try {
    const code = await main(['next', '--wait', '1'], { cwd: actor.path, clock: box.clock,
      stdout: { isTTY: false, write: text => {
        if (outputAt === undefined && target !== undefined && /(act on|available) #/u.test(text) && text.includes(`#${target}`)) outputAt = performance.now();
        output += text;
      } },
      stderr: { write: text => {
        stderrText += text;
        waitingReports = (stderrText.match(/next waiting/gu) ?? []).length;
        if (cpuStart || !text.includes('next waiting')) return;
        cpuStart = process.cpuUsage(); quietAt = performance.now();
        firstIdleCounts = { reads, notifications, waitingReports };
        timer = setTimeout(() => { // budget: declared #2518 fixture measures a real 30-second quiet interval.
          // End the idle sample before the real shout write and foreground wake planning.
          quietCpu = process.cpuUsage(cpuStart);
          quietCounts = { reads: reads - firstIdleCounts.reads, notifications: notifications - firstIdleCounts.notifications,
            waitingReports: waitingReports - firstIdleCounts.waitingReports };
          sent = true; askedAt = performance.now();
          target = box.add('Work arriving while the seat sleeps', { lane: 'docs' });
          shout(box.board, { from: 'coordinator', to: actor.id, text: `please build #${target} now`, lanes: ['web', 'review', 'docs'] });
          shoutFinishedAt = performance.now();
        }, 30_000);
      } } });
    const returnedAt = performance.now();
    const totalCpu = process.cpuUsage(cpuStart);
    const postCounts = { reads, notifications, waitingReports };
    assert.equal(code, 0, output);
    assert.equal(sent, true, 'the seat reached idle and received the actual timed shout: ' + output + stderrText);
    assert.ok(askedAt - quietAt >= 30_000); // budget: declared #2518 requires measurement across 30 seconds.
    assert.ok(quietCpu.user + quietCpu.system < 300_000, JSON.stringify({ quietCpu, totalCpu, quietCounts, postCounts })); // budget: declared #2518 caps CPU at 0.3 seconds across that quiet interval.
    const wakeDetails = JSON.stringify({ output,
      shoutMs: shoutFinishedAt - askedAt, outputMs: outputAt - askedAt,
      completionMs: returnedAt - askedAt });
    assert.ok(returnedAt - askedAt < 1_000, wakeDetails); // budget: declared #2518 requires return within one second of the shout.
    // The seat wakes either on the shout naming the item or on the new work itself, whichever the board change reaches first.
    assert.ok(output.includes(`act on #${target}`) || output.includes(`available #${target}`), output);
    let received = '';
    while (!received.includes('"event_kind":"shout"')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, received);
      received += new TextDecoder().decode(chunk.value);
    }
    assert.ok(reads <= notifications + 2, `${reads} reads for ${notifications} file notifications; no periodic reads`);
  } finally { clearTimeout(timer); }
});
