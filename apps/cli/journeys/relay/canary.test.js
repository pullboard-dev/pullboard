/** Real relay round trips, durable local health, and the existing client outbox projection [H5,H16,H17]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import { delimiter } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';
import { apiBoardOpeners } from '../../tests/fixtures/board.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { repoInfo } from '../../../../packages/git/index.js';
import { loadMachineSettings } from '../../../../packages/config/index.js';
import { machineSettingsFile } from '../../../../packages/config/index.js';
import { probeRelayCanary } from '../../../../packages/link/index.js';
import { observeRelayHealth } from '../../../../packages/link/index.js';
import { readRelayHealth } from '../../../../packages/link/index.js';
import { runRelayCanary } from '../../../../packages/link/index.js';

/** Return the link cell's canary and health surface, checking each export is a function. */
function canaryApi() {
  assert.equal(typeof probeRelayCanary, 'function', 'the real relay canary probe is exported');
  assert.equal(typeof observeRelayHealth, 'function', 'the durable relay health observer is exported');
  assert.equal(typeof readRelayHealth, 'function', 'the keyless relay health reader is exported');
  return { probeRelayCanary, observeRelayHealth, readRelayHealth };
}

/** Install the isolated Pullboard entry point; commit configuration only when the case changes it (the fixture already committed the rest). */
function commitConfiguration(box, { outbox = false } = {}) {
  const cli = fileURLToPath(new URL('../../pullboard.js', import.meta.url));
  const privateBin = box.env.PATH.split(delimiter)[0];
  const pullboard = join(privateBin, 'pullboard');
  assert.equal(existsSync(pullboard), false, 'the fixture has no preexisting private Pullboard wrapper to overwrite');
  writeFileSync(pullboard, `#!/bin/sh\nexec node "${cli}" "$@"\n`, { mode: 0o700 });
  if (!outbox) return;
  const file = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, relay: { ...config.relay, outbox: true } }, null, 2) + '\n');
  runFixtureGit(['add', 'pullboard.json'], { cwd: box.root, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'chore(config): prepare the canary project'], { cwd: box.root, env: box.env });
}

/** Create an ordinary registered seat in a real fixture worktree, sharing its linked board. */
function canarySeat(box) {
  const root = join(dirname(box.root), 'canary-seat');
  runFixtureGit(['worktree', 'add', '-q', '-b', 'agent/canary', root], { cwd: box.root, env: box.env });
  // The worktree and its Git metadata both live under this fixture's scratch directory.
  return root;
}

/** Give the direct probe only this fixture's private machine paths and restore the parent process afterward. */
async function withFixtureEnvironment(env, action) {
  const names = ['HOME', 'PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME', 'PULLBOARD_RELAY_KEY', 'PULLBOARD_RELAY_TOKEN',
    'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'PATH'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) {
    if (Object.hasOwn(env, name)) process.env[name] = env[name];
    else delete process.env[name];
  }
  try { return await action(); }
  finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

/** Convert a structured health result into searchable display text without assuming its object layout. */
function displayText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(displayText).join('\n');
  if (value && typeof value === 'object') return Object.values(value).map(displayText).join('\n');
  return '';
}

test('a failed round trip alerts within two minutes and names the failed step [H2,H15,C7]', { timeout: 60_000 }, async t => { // budget: private relay startup, four real probes, and fixture cleanup; alert timing uses the injected clock.
  const drillStartedAt = new Date().toISOString();
  const { probeRelayCanary, observeRelayHealth, readRelayHealth } = canaryApi();
  const box = await relayClientFixture(t);
  commitConfiguration(box);
  await box.link();
  const root = canarySeat(box);
  const joined = await box.cliAtLocal(root, 'join', box.lane, '--model', 'canary-fixture');
  assert.equal(joined.code, 0, joined.failure);
  const agentId = joined.document.agent;
  assert.equal(typeof agentId, 'string', 'the probe uses a real registered machine seat');

  let now = 1_000;
  const probe = async ({ refusePull = false } = {}) => {
    // The fixture lets this authenticated write finish, then refuses only the probe's fresh event pull.
    if (refusePull) box.beforeNextMove(() => box.refuseReads(true));
    let result;
    try { result = await withFixtureEnvironment(box.env, () => probeRelayCanary(root, { agentId, io: { ...apiBoardOpeners }, clock: () => now })); }
    finally { if (refusePull) box.refuseReads(false); }
    if (refusePull) {
      assert.equal(result.ok, false, 'the canary reports the deliberately failed fresh pull');
      assert.equal(result.step, 'pull', 'the failure is attributed to the fresh event pull, not setup or seat registration');
    } else {
      assert.equal(result.ok, true, `a normal authenticated sealed round trip establishes the healthy baseline and recovery: ${JSON.stringify(result)}`);
      assert.equal(result.step, 'complete');
    }
    return result;
  };

  const healthy = observeRelayHealth(box.root, await probe(), { now });
  assert.equal(healthy.health.status, 'healthy', 'a real sealed round trip establishes healthy status');
  assert.equal(healthy.transition, null);
  assert.equal(healthy.finding, null);

  now += 1_000;
  const first = await probe({ refusePull: true });
  const initial = observeRelayHealth(box.root, first, { now });
  assert.equal(initial.transition, null, 'one failure degrades the relay without an alert');
  assert.equal(initial.health.status, 'degraded');

  now += 119_000;
  const second = await probe({ refusePull: true });
  const alerted = observeRelayHealth(box.root, second, { now });
  assert.equal(alerted.transition, 'alert', 'two consecutive failures alert inside the two-minute window');
  assert.equal(alerted.health.status, 'degraded');
  assert.equal(alerted.health.consecutiveFailures, 2);
  assert.ok(displayText(alerted.finding).includes(second.step), 'the health finding names the exact failed probe step');
  const read = readRelayHealth(box.root, { now });
  assert.equal(read.status, 'degraded');
  assert.equal(read.lastAt, new Date(now).toISOString());
  assert.ok(displayText(read).includes(second.step), 'the persisted health projection retains the failed step');
  const link = JSON.parse(box.readLink());
  assert.equal(JSON.stringify(read).includes(link.token), false, 'health projection never exposes the relay credential');

  now += 1_000;
  const recovered = observeRelayHealth(box.root, await probe(), { now });
  assert.equal(recovered.transition, 'recovery', 'a subsequent complete sealed round trip clears the active alert');
  assert.equal(recovered.health.status, 'healthy');
  assert.equal(recovered.health.consecutiveFailures, 0);
  assert.equal(recovered.finding, null);
  assert.equal(readRelayHealth(box.root, { now }).status, 'healthy', 'the cleared state is durable for a later status read');
  t.diagnostic(JSON.stringify({ drill: 'fixture authenticated event route blocked and restored', startedAt: drillStartedAt,
    finishedAt: new Date().toISOString(), cadence: 'injected clock; no wall-clock two-minute delivery claim',
    failedStep: second.step, alert: alerted.transition, recovery: recovered.transition, production: false }));
});

test('the health history waits for ten minutes of slow successful round-trip samples before p95 alerting [H5,H15,C7]', async t => {
  const { observeRelayHealth, readRelayHealth } = canaryApi();
  const box = await relayClientFixture(t);
  const start = Date.parse('2026-01-01T00:00:00.000Z');
  let last;
  // Use deterministic timestamps in the real private SQLite history; the primary named case proves transport success.
  for (let index = 0; index <= 10; index += 1) {
    const now = start + index * 60_000;
    last = observeRelayHealth(box.root, {
      ok: true, step: 'complete', code: 'OK', roundTripMs: 2_101, relayVersion: 1,
    }, { now });
    if (index < 10) {
      assert.equal(last.transition, null, 'a partial latency window cannot alert early');
      assert.equal(last.health.status, 'healthy');
      assert.equal(last.health.p95Ms, null);
    }
  }
  assert.equal(last.transition, 'alert', 'the first full ten-minute window applies the p95 threshold');
  assert.equal(last.health.status, 'degraded');
  assert.equal(last.health.p95Ms, 2_101);
  assert.match(last.finding.why, /ten-minute p95.*2101 ms/iu);
  assert.equal(readRelayHealth(box.root, { now: start + 600_000 }).status, 'degraded');
});

test('the client shows queued moves while the relay is degraded [H16,H17,C7]', { timeout: 60_000 }, async t => { // budget: linked fixture setup, two queued moves, two real probes, and cleanup.
  const { probeRelayCanary, observeRelayHealth } = canaryApi();
  const box = await relayClientFixture(t);
  commitConfiguration(box, { outbox: true });
  await box.link();
  const root = canarySeat(box);
  const joined = await box.cliAtLocal(root, 'join', box.lane, '--model', 'canary-outbox-fixture');
  assert.equal(joined.code, 0, joined.failure);
  await box.stopRelay();

  for (const text of ['First move waits while the relay canary is degraded', 'Second move waits while the relay canary is degraded']) {
    const queued = await box.cliLocal('shout', 'all', text);
    assert.equal(queued.code, 0, queued.failure);
  }
  for (let index = 0; index < 2; index += 1) {
    const failure = await withFixtureEnvironment(box.env, () => probeRelayCanary(root, { agentId: joined.document.agent, io: { ...apiBoardOpeners } }));
    assert.equal(failure.ok, false, 'the real canary observes the stopped relay');
    observeRelayHealth(box.root, failure);
  }
  const status = await box.cli('status');
  assert.equal(status.code, 0, status.failure);
  const moveCount = status.document.relay.outbox.length;
  assert.equal(moveCount, 2, 'status reads both real moves saved in the local outbox');
  assert.equal(status.document.relay.health.status, 'degraded');
  assert.equal(status.document.relay.health.queued, moveCount, 'health reports the count from the actual outbox');
  assert.ok(status.document.relay.outbox.length > 0, 'status keeps the queued move details visible during degradation');
  const textStatus = box.startCli(['status'], {}, { json: false });
  const rendered = await textStatus.closed;
  assert.equal(rendered.code, 0, rendered.stderr);
  assert.match(rendered.stdout, /relay outbox: .*move waits|relay outbox: .*moves wait/iu, 'the normal client output names its queued moves');
  assert.match(rendered.stdout, new RegExp(`relay degraded since .+; your moves are queued locally \\(${moveCount}\\)`, 'u'), 'the normal client says moves remain queued while health is degraded');
});


/** Configure an ordinary seat using only that paired host's real repository and private machine settings. */
async function independentCanaryHost(host, lane, name) {
  const root = join(host.root, '..', name);
  runFixtureGit(['worktree', 'add', '-q', '-b', 'agent/' + name, root], { cwd: host.root, env: host.env });
  const joined = await host.cliAt(root, 'join', lane, '--model', 'canary-fixture');
  assert.equal(joined.code, 0, joined.failure);
  const enabled = await host.cliAt(root, 'relay', 'canary', 'on', '--timeout', '5000');
  assert.equal(enabled.code, 0, enabled.failure);
  const saved = await withFixtureEnvironment(host.env, () => ({
    config: loadMachineSettings().relay?.canary,
    settingsFile: machineSettingsFile(),
    commonDir: repoInfo(root).commonDir,
  }));
  assert.deepEqual(saved.config, enabled.document.config, 'the CLI saves this host’s actual canary configuration');
  assert.equal(saved.config.root, root);
  assert.equal(saved.config.agentId, joined.document.agent);
  assert.equal(saved.config.enabled, true);
  const healthFile = join(saved.commonDir, 'pullboard', 'relay-health.sqlite');
  /** Retain the exact saved host-health bytes for the independent-host noninterference assertions. */
  function readHealth() {
    return readFileSync(healthFile);
  }
  return { ...host, ...saved, root, healthFile, readHealth };
}

test('two paired host configurations independently alert and recover through real configured canaries [H5,H15,H17]',
  { timeout: 180_000 }, async t => { // budget: two real private clones, ordinary seat joins, eight bounded network probes and cleanup; alert cadence uses an injected health clock.
    const startedAt = new Date().toISOString();
    const { readRelayHealth } = canaryApi();
    const box = await relayClientFixture(t);
    commitConfiguration(box);
    await box.link();
    const printed = await box.cliLocal('relay', 'pair');
    assert.equal(printed.code, 0, printed.failure);
    const paired = await box.otherDeviceJoin(printed.document.code, 'canary-host-b');
    const left = await independentCanaryHost(box, box.lane, 'canary-host-a-seat');
    const right = await independentCanaryHost(paired, box.lane, 'canary-host-b-seat');
    for (const field of ['HOME', 'PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME']) {
      assert.notEqual(left.env[field], right.env[field], `${field} belongs to an independent logical host`);
    }
    assert.notEqual(left.commonDir, right.commonDir, 'health is not shared through a sibling-worktree common directory');
    assert.notEqual(left.settingsFile, right.settingsFile, 'machine opt-ins are stored separately');
    assert.notEqual(left.config.agentId, right.config.agentId, 'each configured probe uses its own ordinary registered seat');
    const leftLink = JSON.parse(box.readLink());
    const rightLink = JSON.parse(readFileSync(join(paired.root, '.git', 'pullboard', 'relay.json'), 'utf8'));
    assert.equal(leftLink.board, rightLink.board, 'both independent hosts use the same real fixture relay board');
    assert.equal(leftLink.url, rightLink.url);
    assert.notEqual(leftLink.machine, rightLink.machine, 'ordinary pairing issues a distinct machine identity');
    assert.ok(typeof leftLink.token === 'string' && typeof rightLink.token === 'string' && leftLink.token !== rightLink.token,
      'ordinary pairing issues separate machine credentials without exposing their values');
    assert.notEqual(leftLink.tokenId, rightLink.tokenId);
    let now = Date.now();
    /** Read the machine's saved configuration for every real probe, restoring the shared process environment afterward. */
    async function run(host, fail = false) {
      if (fail) box.beforeNextMove(() => box.refuseReads(true));
      let result;
      try {
        result = await withFixtureEnvironment(host.env, async () => {
          const config = loadMachineSettings().relay?.canary;
          assert.deepEqual(config, host.config, 'the actual saved machine configuration remains selected');
          return runRelayCanary(config, { io: { ...apiBoardOpeners }, now: () => now });
        });
      } finally { if (fail) box.refuseReads(false); }
      assert.equal(result.observation.ok, !fail, JSON.stringify(result.observation));
      assert.equal(result.observation.step, fail ? 'pull' : 'complete');
      return result;
    }
    for (const host of [left, right]) {
      const healthy = await run(host);
      assert.equal(healthy.health.status, 'healthy');
      assert.equal(healthy.transition, null);
    }
    const drills = [];
    for (const [host, other] of [[left, right], [right, left]]) {
      const untouched = other.readHealth();
      now += 1_000;
      const first = await run(host, true);
      assert.equal(first.transition, null, 'one failed probe degrades without inventing an alert');
      assert.equal(first.health.status, 'degraded');
      assert.equal(first.health.consecutiveFailures, 1);
      assert.deepEqual(other.readHealth(), untouched, 'another host’s first failure cannot change this host’s health');
      now += 119_000;
      const alert = await run(host, true);
      assert.equal(alert.transition, 'alert', 'the second real failed pull alerts within the simulated two-minute window');
      assert.equal(alert.health.consecutiveFailures, 2);
      assert.equal(alert.health.status, 'degraded');
      assert.ok(displayText(alert.finding).includes('pull'), 'the persisted finding names the actual failed step');
      assert.equal(readRelayHealth(host.root, { now }).step, 'pull');
      assert.deepEqual(other.readHealth(), untouched, 'another host’s alert cannot overwrite this host’s health');
      now += 1_000;
      const recovered = await run(host);
      assert.equal(recovered.transition, 'recovery');
      assert.equal(recovered.health.status, 'healthy');
      assert.equal(recovered.health.consecutiveFailures, 0);
      assert.equal(recovered.finding, null);
      assert.equal(readRelayHealth(host.root, { now }).status, 'healthy');
      assert.deepEqual(other.readHealth(), untouched, 'recovery belongs only to the host that completed the round trip');
      drills.push({ alertAt: alert.health.lastAt, recoveryAt: recovered.health.lastAt, failedStep: alert.observation.step });
    }
    t.diagnostic(JSON.stringify({ drill: 'two independently paired machine configurations share one loopback relay',
      startedAt, finishedAt: new Date().toISOString(), hosts: drills,
      cadence: 'injected health clock; real sealed probes; no wall-clock or physical-two-machine claim', production: false }));
  });
