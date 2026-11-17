/** An idle watcher with watch.quietReads on is measured for CPU over 100 s in this process, and the percent is printed [C7,#9845,#9618]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { followBoard } from '../../../../packages/shouts/index.js';
import { watchOptions } from '../../../../packages/shouts/index.js';
import { watchStart } from '../../../../packages/shouts/index.js';

const QUIET_READS = true;
const SECONDS = 100;

test('clause 1: followBoard on a quiet board with watch.quietReads on for 100 s prints this process\'s CPU percent as a number from 0 to 100 [C7,#9845]', { timeout: 170_000 }, async (t) => { // budget: a fixed 100 s idle measurement plus fixture setup; the ceiling is a hang bound, not a speed target.
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const waiting = [];
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    waiting.push(response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { for (const response of waiting) response.destroy(); server.closeAllConnections(); server.close(); });
  const abort = new AbortController();
  const start = watchStart(file);
  const options = { ...watchOptions({ work: 'core' }, { config: { lanes: { core: {} } }, agents: start.agents }), since: 0 };
  const port = server.address().port;
  const done = followBoard({
    file, mainRoot: box.repo, commonDir: box.repo, config: { lanes: { core: {} } }, isMain: true,
    runCommand: () => assert.fail('a view is running, so no private API is needed'), serveApi: () => assert.fail('no private API'),
    refusalDocument: () => ({}), boardOpeners: {}, viewPorts: {}, options, start, signal: abort.signal,
    runningView: async () => ({ url: `http://127.0.0.1:${port}/?k=secret`, port }),
    quietReads: QUIET_READS, readHead: async () => 'aaa', write: () => {}, note: () => {},
  });
  // The measurement is real elapsed time by definition: CPU percent is CPU time over wall time, so no injected clock can stand in for it.
  const settled = Promise.withResolvers();
  const quiet = Promise.withResolvers();
  const warm = setTimeout(settled.resolve, 1000);
  t.after(() => clearTimeout(warm));
  await settled.promise;
  const cpu = process.cpuUsage();
  const began = process.hrtime.bigint();
  const window = setTimeout(quiet.resolve, SECONDS * 1000);
  // A line every 20 s tells the runner the file is alive, not idle-hung; one tiny write costs no measurable CPU.
  let beat;
  const alive = () => { console.log('idle watcher measurement running'); beat = setTimeout(alive, 20_000); };
  beat = setTimeout(alive, 20_000);
  t.after(() => { clearTimeout(window); clearTimeout(beat); });
  await quiet.promise;
  clearTimeout(beat);
  const used = process.cpuUsage(cpu);
  const wallMicros = Number(process.hrtime.bigint() - began) / 1000;
  abort.abort();
  assert.equal(await done, 0);
  const percent = (used.user + used.system) / wallMicros * 100;
  console.log(`idle watcher CPU, watch.quietReads on: ${percent.toFixed(2)} percent of one core over ${(wallMicros / 1e6).toFixed(1)} s (user ${(used.user / 1000).toFixed(0)} ms, system ${(used.system / 1000).toFixed(0)} ms)`);
  assert.ok(Number.isFinite(percent) && percent >= 0 && percent <= 100, `CPU percent is a number from 0 to 100, got ${percent}`);
});
