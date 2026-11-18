/** A pull runner job whose gate was withdrawn has its process gone within 60 s, ended by the shipped runner's own lease-lost handling [C7,#9880]. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { boardJobQueueCall } from '../../../../packages/api/index.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { serveBackground } from '../../tests/fixtures/pull.js';
import { submitOne } from '../../tests/fixtures/pull.js';

const run = promisify(execFile);

/** The stand-in proof tells the test its pid over a loopback socket and holds it open: the socket closes when the proof process exits. */
const PROOF = `import { connect } from 'node:net';
const socket = connect(Number(process.env.PULLBOARD_FIXTURE_PROOF_PORT), '127.0.0.1', () => socket.write(String(process.pid) + '\\n'));
socket.on('error', () => {});
setTimeout(() => socket.destroy(), 120000);
`;

/** Whether `ps` still lists a live (not zombie) process with this pid. */
async function listed(pid) {
  const out = await run('ps', ['-o', 'stat=', '-p', String(pid)]).then(done => done.stdout.trim(), () => '');
  return out !== '' && !out.startsWith('Z');
}

test('cli.journeys-gate-pulled-withdraw-ends.withdrawn-job-process-gone-within-60s: clause 1: the process of a pull runner job whose gate was withdrawn is gone within 60 s of the withdraw, ended by the runner serve and not by the test [C7,#9880]', { timeout: 240_000 }, // budget: hang ceiling for a project, a submit, a runner serve taking the job, a 35 s worst-case lease loss and a 60 s window.
async t => {
  const box = await pullProject(t, 1, { gate: { runnerDispatch: 'pull', withdrawCancelsJob: true }, tooling: { 'bin/proof.js': PROOF } });
  const [id] = box.ids;
  const sent = submitOne(box, id);
  const { url } = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo }) });
  let told; const pidTold = new Promise(done => { told = done; });
  let ended; const proofEnded = new Promise(done => { ended = done; });
  const server = createServer(socket => {
    socket.once('data', chunk => told(Number(String(chunk).trim())));
    socket.once('close', () => ended());
    socket.on('error', () => {});
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.close(); server.closeAllConnections?.(); });
  const served = await serveBackground(box, url, 'r-withdraw', { PULLBOARD_FIXTURE_PROOF_PORT: String(server.address().port) });
  t.after(() => served.stop());
  const pid = await Promise.race([pidTold, new Promise((_, fail) => setTimeout(() => fail(new Error(`the runner never ran the proof:\n${served.output()}`)), 150_000).unref())]); // budget: hang ceiling for the runner to start, take the gate job and run its proof.
  assert.ok(Number.isInteger(pid) && pid > 0, 'the proof reported its pid');
  assert.equal(await listed(pid), true, 'the proof is running before the withdraw');
  const out = await box.runIn(sent.folder, 'gate', '--withdraw', String(id), '--json');
  assert.equal(out.code, 0, `${out.err}\n${out.out}`);
  await Promise.race([proofEnded, new Promise((_, fail) => setTimeout(() => fail(new Error(`proof process ${pid} still running 60000 ms after the withdraw:\n${served.output()}`)), 60_000).unref())]); // budget: hang ceiling at the declared 60 s from the withdraw to the job process gone (#9880).
  let still = true;
  for (let attempt = 0; attempt < 100 && still; attempt++) still = await listed(pid);
  assert.equal(still, false, `the proof process ${pid} is gone`);
  assert.equal(await Promise.race([served.closed.then(() => 'closed'), Promise.resolve('serving')]), 'serving', 'the runner serve is still serving: it ended the job, not the test');
  served.stop();
  await served.closed;
});
