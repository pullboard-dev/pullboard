/** Pure state helpers for the resource queue tests: the child programs' sources and edits to a private resource database. No CLI, no hooks [Q1,Q2,Q3]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { executionServicesSource } from '../gate/execution.js';

/** Build the resource test's child programs with the importing test's absolute module URLs. */
export function resourceWorkerSources({ resourcesModule: MODULE, gateModule: GATE_MODULE, settingsModule: SETTINGS_MODULE }) {
  /** A gate run whose memory reading comes from a fixture file through the Linux reader's own parsing. */
  const MEMORY_WORKER = `
import { readFileSync } from 'node:fs';
import { withGateSlot } from ${JSON.stringify(GATE_MODULE)};
${executionServicesSource(GATE_MODULE)}
import { readMachineMemory } from ${JSON.stringify(MODULE)};
const [root, agent, source] = process.argv.slice(1);
const ps = ['  6161   512000 /bin/zsh', '  4242 25165824 /usr/bin/python3', '    77     1024 /sbin/launchd',
  '  5151  2097152 /usr/local/bin/node', '  4343 24117248 /opt/homebrew/bin/python3.12'].join('\\n');
const cwds = { '/proc/4242/cwd': '/work/journal-reader', '/proc/4343/cwd': '/work/other-reader', '/proc/5151/cwd': '/work/pullboard' };
let reads = 0;
/** Read the fixture's current machine state as Linux would present it, counting every reading. */
const readMemory = (options) => (reads += 1, source === 'win32') ? readMachineMemory({ ...options, platform: 'win32' }) : readMachineMemory({
  ...options, platform: 'linux',
  readText: async (file) => {
    const reading = JSON.parse(readFileSync(source, 'utf8'));
    if (file === '/proc/meminfo') return reading.meminfo;
    if (file === '/proc/pressure/memory') return reading.psi;
    throw new Error('unexpected file ' + file);
  },
  run: async (file) => { if (file === '/bin/ps') return ps; throw new Error('unexpected command ' + file); },
  readLink: async (path) => { if (cwds[path]) return cwds[path]; throw new Error('EACCES'); },
});
let last = '';
await withGateSlot(root, async () => {
  console.log(JSON.stringify({ acquired: agent, reads }));
  for await (const line of process.stdin) if (String(line).trim() === 'release') break;
}, { executionServices, agent, kind: 'gate', readMemory, onWait: ({ position, memory }) => {
  const state = JSON.stringify({ waiting: position, memory: memory ?? null });
  if (state !== last) { last = state; console.log(state); }
} });
`;

  const POOL_MODULE_WORKER = `
import { takeResource } from ${JSON.stringify(MODULE)};
import { loadMachineSettings } from ${JSON.stringify(SETTINGS_MODULE)};
let announced = false;
const [root, agent, browserText, item, kind, landingText] = process.argv.slice(1);
const lease = await takeResource({
  name: 'gate', capacity: 2, scope: 'machine', root, agent,
  browserCapacityProvider: () => loadMachineSettings().browserSlots,
  browser: browserText === 'true', item, kind, itemCheck: kind === 'review',
  diagnostic: kind === 'diagnostic', landing: landingText === 'true',
  onWait: (state) => {
    if (!announced) { announced = true; console.log(JSON.stringify({ queued: state })); }
  },
});
try {
  console.log(JSON.stringify({ acquired: agent }));
  for await (const line of process.stdin) {
    if (String(line).trim() === 'release') break;
  }
} finally { lease.release(); }
`;
  const SUBMIT_CHECK = `
import { runSubmitGate } from ${JSON.stringify(GATE_MODULE)};
${executionServicesSource(GATE_MODULE)}
const [root, base, check] = process.argv.slice(1);
const result = await runSubmitGate(root, { gate: 'true', affectedTests: 'node packages/gate/src/io/run/tests.js test/cpu-check.test.js' }, { executionServices,
  base, changed: ['test/cpu-check.test.js'], check, agent: 'submit-check', item: '636',
});
process.stdout.write(JSON.stringify({ green: result.isGreen, full: result.full, reason: result.reason, files: result.files, checkGreen: result.check.green }) + '\\n');
`;
  const WORKER = `
import { takeResource } from ${JSON.stringify(MODULE)};
const [name, capacity, scope, root, agent, stallMs, landingText] = process.argv.slice(1);
let lastWait = '';
const lease = await takeResource({ name, capacity: Number(capacity), scope, root, agent, landing: landingText === 'true', onWait: ({position, holders, line, rejoined}) => {
  const state = JSON.stringify({waiting:position, holders, line, rejoined:rejoined ?? false});
  if (!lastWait || rejoined) { lastWait = state; console.log(state); }
} });
console.log(JSON.stringify({acquired:agent}));
let secondLease;
if (Number(stallMs) > 0) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(stallMs));
  console.log(JSON.stringify({resumed:true}));
}
process.stdin.setEncoding('utf8');
for await (const line of process.stdin) {
  if (line.trim() === 'second') {
    takeResource({ name, capacity: Number(capacity), scope, root, agent, landing: true }).then((nextLease) => {
      secondLease = nextLease;
      console.log(JSON.stringify({secondAcquired: agent}));
    });
  }
  if (line.trim() === 'renew') {
    try { lease.renew(); console.log(JSON.stringify({renewed:true})); }
    catch (error) { console.log(JSON.stringify({renewError:error.code})); }
  }
  if (line.trim() === 'release') { lease.release(); secondLease?.release(); break; }
}
`;
  return { POOL_MODULE_WORKER, SUBMIT_CHECK, WORKER, MEMORY_WORKER };
}

/** Read private resource names without changing the database used by the caller. */
export function resourceNames(home) {
  const db = new DatabaseSync(join(home, 'resources.sqlite'));
  try { return db.prepare('SELECT name FROM resource ORDER BY name').all().map(({ name }) => name); }
  finally { db.close(); }
}

/** Create the previous private queue schema so simultaneous openers exercise its migration. */
export function oldSchema(box) {
  mkdirSync(box.home, { recursive: true });
  const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    db.exec(`CREATE TABLE resource (name TEXT PRIMARY KEY, capacity INTEGER NOT NULL);
      CREATE TABLE holder (token TEXT PRIMARY KEY, name TEXT NOT NULL, pid INTEGER NOT NULL, agent TEXT NOT NULL, repo TEXT NOT NULL, since TEXT NOT NULL, heartbeat INTEGER NOT NULL);
      CREATE INDEX holder_name ON holder(name);
      CREATE TABLE waiter (ticket INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pid INTEGER NOT NULL, agent TEXT NOT NULL, repo TEXT NOT NULL, since TEXT NOT NULL, heartbeat INTEGER NOT NULL);
      CREATE INDEX waiter_name_ticket ON waiter(name, ticket);`);
  } finally { db.close(); }
}

/** Force a stale private fixture row with a mismatched process start identity. */
export function staleIdentity(box, table, agent) {
  assert.ok(['holder', 'waiter'].includes(table));
  const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    const result = db.prepare(`UPDATE ${table} SET started = ?, heartbeat = 0 WHERE agent = ?`).run('old-process-start', agent);
    assert.equal(result.changes, 1, `${agent} has a private ${table} row`);
  } finally { db.close(); }
}

/** Expire a private lease heartbeat without changing its recorded OS identity. */
export function expireHeartbeat(box, table, agent) {
  assert.ok(['holder', 'waiter'].includes(table));
  const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    const result = db.prepare(`UPDATE ${table} SET heartbeat = 0 WHERE agent = ?`).run(agent);
    assert.equal(result.changes, 1, `${agent} has a private ${table} row`);
  } finally { db.close(); }
}
