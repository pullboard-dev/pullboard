/** Bounded cleanup of the round-trip fixture's owned process group [C7]. */
import assert from 'node:assert/strict';
import { parseProcessCensus } from '../../../../../packages/kernel/light.js';
import { runFixtureChild } from '../child.js';

/** Read a complete census; failed or malformed output never proves a group empty. */
function readCensus() {
  const listed = runFixtureChild('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,stat=,comm='], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.context);
  const rows = parseProcessCensus(listed.stdout);
  assert.ok(rows, 'fixture cleanup needs a complete process census');
  return rows;
}

/** Zombies have finished; any other member still requires cleanup even after the leader closes. */
function liveMembers(census, group) {
  const rows = census();
  assert.ok(rows instanceof Map && rows.size > 0, 'fixture cleanup cannot trust an unavailable census');
  return [...rows.values()].filter(row => row.pgid === group && !/^Z/u.test(row.state));
}

/** An EPERM is harmless only when a fresh census proves no live group member remains. */
export function signalFixtureGroup(group, signal, { kill = process.kill, census = readCensus } = {}) {
  try { kill(-group, signal); }
  catch (error) {
    if (error.code === 'ESRCH') return;
    if (error.code !== 'EPERM' || liveMembers(census, group).length) throw error;
  }
}

/** TERM, then KILL if needed, await close, and prove that the owned group has drained. */
export async function stopGroup(child, closed, { kill = process.kill, census = readCensus } = {}) {
  if (!child.pid) return;
  const options = { kill, census };
  signalFixtureGroup(child.pid, 'SIGTERM', options);
  let timer;
  try {
    await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 5_000); })]);
  } finally { clearTimeout(timer); }
  if (liveMembers(census, child.pid).length) signalFixtureGroup(child.pid, 'SIGKILL', options);
  try {
    await Promise.race([closed, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('fixture group did not close after KILL')), 10_000); // budget: hang ceiling for the child-close handshake after escalation; 2 s missed on a runner at twice its cores.
    })]);
  } finally { clearTimeout(timer); }
  const deadline = Date.now() + 2_000;
  while (liveMembers(census, child.pid).length) {
    assert.ok(Date.now() < deadline, `fixture group ${child.pid} retains live members after KILL`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/** Exercise the observed zombie-only EPERM and refuse both live and unknown group states. */
export function assertFixtureGroupEpermControls() {
  /** Reproduce the operating system's denied process-group signal. */
  const kill = () => { throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' }); };
  /** Keep each census concrete while varying only whether the owned member is live. */
  const row = state => new Map([[41, { pid: 41, pgid: 40, state }]]);
  assert.doesNotThrow(() => signalFixtureGroup(40, 'SIGKILL', { kill, census: () => row('Z') }));
  assert.throws(() => signalFixtureGroup(40, 'SIGKILL', { kill, census: () => row('S') }), /kill EPERM/u);
  assert.throws(() => signalFixtureGroup(40, 'SIGKILL', { kill, census: () => null }), /unavailable census/u);
  assert.throws(() => signalFixtureGroup(40, 'SIGKILL', { kill, census: () => { throw new Error('ps failed'); } }), /ps failed/u);
}
