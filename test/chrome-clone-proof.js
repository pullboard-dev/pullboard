/** Compare a native unflagged control with the actual test harness arguments [C7]. */
import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, watch } from 'node:fs';
import { hostname, loadavg, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromeCloneDirectories, chromeCloneSnapshot, newChromeClones } from '../packages/gate/index.js';
import { findChromeExecutable, launchChromeProcess } from './chrome-fixture.js';
import { chromeLaunchArgs } from './chrome-launch-args.js';

/** Poll one bounded native handshake; never extend a declared browser deadline. */
async function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(message);
}

/** Observe native directory creation as well as leftovers; no observation ever authorizes deletion. */
function creationMonitor(before) {
  const known = new Set(before);
  const created = new Set();
  const directories = chromeCloneDirectories();
  const watchers = new Map();
  const errors = [];
  /** Capture the native event's specific directory without repeatedly statting every historical clone. */
  const capture = (directory, name) => {
    if (!/^code_sign_clone\.[A-Za-z0-9._-]{6}$/u.test(name)) return;
    try {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        const identity = `${realpathSync(directory)}/${name}:${stat.dev}:${stat.ino}`;
        if (!known.has(identity)) created.add(identity);
      }
    } catch (error) { if (error.code !== 'ENOENT') errors.push(error.code ?? 'unknown'); }
  };
  /** A platform without an event filename still receives a conservative complete scan. */
  const scan = directory => {
    try { for (const name of readdirSync(directory)) capture(directory, name); }
    catch (error) { if (error.code !== 'ENOENT') errors.push(error.code ?? 'unknown'); }
  };
  /** A first launch may create its namespace after the initial empty snapshot. */
  const install = () => {
    for (const directory of directories) {
      if (watchers.has(directory) || !existsSync(directory)) continue;
      const observer = watch(directory, { persistent: false }, (_event, name) => name ? capture(directory, String(name)) : scan(directory));
      observer.on('error', error => errors.push(error.code ?? 'unknown'));
      watchers.set(directory, observer);
    }
  };
  install();
  const parent = watch(dirname(directories[0]), { persistent: false }, install);
  parent.on('error', error => errors.push(error.code ?? 'unknown'));
  return { created, errors, close() { parent.close(); for (const observer of watchers.values()) observer.close(); } };
}

/** Ask only this private profile's browser to exit gracefully, preserving Chromium's own cleanup. */
async function gracefulClose(profile, launched) {
  if (launched.child.exitCode !== null || launched.child.signalCode !== null) return;
  const [port, browserPath] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').trim().split('\n');
  assert.match(port, /^\d+$/u);
  assert.match(browserPath, /^\/devtools\/browser\/[A-Za-z0-9-]+$/u);
  // Chrome publishes the owned browser endpoint here; a second HTTP discovery is unnecessary.
  let requestError;
  let opened = false;
  const errors = channel('undici:request:error');
  /** Keep only transport failure codes and messages, never headers or private browser URLs. */
  const observeError = ({ error }) => { requestError = { code: error.code, message: error.message, cause: error.cause?.message }; };
  errors.subscribe(observeError);
  const socket = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`);
  try { await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('private Chrome graceful close timed out')); }, 3_000); // budget: hang ceiling for this private browser's graceful shutdown.
    socket.addEventListener('open', () => { opened = true; socket.send(JSON.stringify({ id: 1, method: 'Browser.close' })); }, { once: true });
    socket.addEventListener('error', event => {
      clearTimeout(timer);
      // Browser.close can end the transport without a close frame; a clean process exit below is still required.
      if (opened) resolve();
      else reject(new Error(`private Chrome close connection failed: ${JSON.stringify({ opened, state: socket.readyState, requestError, message: event.error?.message })}`, { cause: event.error }));
    }, { once: true });
    socket.addEventListener('close', () => { clearTimeout(timer); if (opened) resolve(); else reject(new Error('private Chrome closed before Browser.close could be sent')); }, { once: true });
  }); } finally { errors.unsubscribe(observeError); }
  await waitUntil(() => launched.child.exitCode !== null || launched.child.signalCode !== null, 3_000, 'native Chrome did not exit after Browser.close');
  assert.equal(launched.child.exitCode, 0, 'the native control must exit cleanly after Browser.close');
  assert.equal(launched.child.signalCode, null, 'the native control must not be terminated by a signal');
}

/** Run a real control and SIGKILL the test launch; no code deletes any clone directory. */
export async function assertNoKilledChromeClone(t) {
  t.diagnostic(JSON.stringify({ host: hostname(), node: process.version, load: loadavg(), chrome: findChromeExecutable() }));
  const initial = chromeCloneSnapshot();
  t.diagnostic(JSON.stringify({ initialCloneCount: initial.length, directories: chromeCloneDirectories() }));
  for (const control of [true, false]) {
    const profile = mkdtempSync(join(tmpdir(), 'pullboard-clone-proof-'));
    const before = chromeCloneSnapshot();
    const monitor = creationMonitor(before);
    const args = chromeLaunchArgs(profile).filter(arg => !control || arg !== '--disable-features=MacAppCodeSignClone');
    // Force the native feature on in both arms; the harness disable switch must take precedence.
    args.unshift('--enable-features=MacAppCodeSignClone');
    const launched = launchChromeProcess({ executable: findChromeExecutable(), args });
    try {
      await waitUntil(() => existsSync(join(profile, 'DevToolsActivePort')), 15_000, 'real Chrome did not publish its private DevTools port');
      if (control) {
        await new Promise(resolve => setTimeout(resolve, 1_000)); // budget: let the native background clone task start before graceful shutdown drains it.
        await gracefulClose(profile, launched);
        await waitUntil(() => monitor.created.size > 0, 5_000, 'unflagged native Chrome must create a clone for the control');
        assert.deepEqual(monitor.errors, []);
        t.diagnostic(JSON.stringify({ phase: 'unflagged-control', createdClones: monitor.created.size, remainingClones: newChromeClones(before).length }));
        await waitUntil(() => newChromeClones(before).length === 0, 5_000, 'Chromium must clean its own control clone after graceful shutdown');
      } else {
        // Give the same native startup path time to create the clone that the positive control demonstrated.
        await new Promise(resolve => setTimeout(resolve, 1_000)); // budget: observe the native clone after DevTools readiness, before deliberate SIGKILL.
        launched.child.kill('SIGKILL');
        await launched.close();
        assert.deepEqual(monitor.errors, []);
        assert.equal(monitor.created.size, 0, 'the harness must prevent native clone creation');
        assert.deepEqual(newChromeClones(before), [], 'the harness must prevent clones even when its Chrome is SIGKILLed');
      }
    } catch (error) {
      t.diagnostic(JSON.stringify({ phase: control ? 'unflagged-control' : 'harness', args, stderr: launched.stderr.slice(-2_000), createdClones: monitor.created.size, newClones: newChromeClones(before).length, observerErrors: monitor.errors, error: String(error), cause: String(error.cause ?? '') }));
      throw error;
    } finally {
      // A failed close is not retried: retain its first transport error and drain the owned group.
      monitor.close();
      try { await launched.close(); }
      finally { rmSync(profile, { recursive: true, force: true }); }
    }
  }
  assert.deepEqual(newChromeClones(initial), [], 'the native control and killed test launch leave no new clone');
}
