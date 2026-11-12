/** Native file notifications share one wake generation without periodic polling [C7]. */
import { existsSync } from 'node:fs';
import { statSync } from 'node:fs';
import { watch } from 'node:fs';
import { dirname } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Watch exact inputs, including files created or replaced later, and retain changes across reads and waits. */
export function fileChangeWaiter(paths) {
  let targets = [], generation = 0, closed = false, failure = null;
  const watchers = new Map(), listeners = new Set();
  let signatures = new Map();
  const fileWatchers = new Map();
  /** Identity of one input right now; a missing input is its own state. */
  function signature(target) {
    try { const stat = statSync(target); return `${stat.ino}:${stat.size}:${stat.mtimeMs}`; } catch { return 'none'; }
  }
  /** Record every input's current identity so a change the native watcher has not yet reported is still seen. */
  function snapshot() { signatures = new Map(targets.map(target => [target, signature(target)])); }
  /** One stat per input, not a poll: a watcher still starting up can miss an event, so reconcile before sleeping. */
  function reconcile() {
    if (closed || targets.some(target => signatures.get(target) !== signature(target))) { if (!closed) { snapshot(); refresh(); changed(); } }
  }
  /** Deliver a generation even when no caller is currently waiting, closing the read-to-sleep gap. */
  function changed(error = null) {
    if (closed) return;
    failure ||= error;
    generation += 1;
    for (const listener of [...listeners]) listener(failure);
  }
  /** Bind the nearest existing parent so creation and atomic replacement remain observable. */
  function refresh() {
    if (closed) return;
    const directories = new Map();
    for (const target of targets) {
      let directory = dirname(target);
      while (!existsSync(directory) && dirname(directory) !== directory) directory = dirname(directory);
      if (!directories.has(directory)) directories.set(directory, new Set());
      directories.get(directory).add(relative(directory, target).split(sep)[0]);
    }
    // macOS reports a directory watch only for entries made or renamed, not for SQLite's in-place WAL writes, so watch each existing input itself too.
    for (const [target, entry] of fileWatchers) if (!targets.includes(target)) { entry.watcher.close(); fileWatchers.delete(target); }
    for (const target of targets) {
      let ino = null;
      try { ino = statSync(target).ino; } catch { /* absent inputs are covered by their parent directory */ }
      const known = fileWatchers.get(target);
      if (known && known.ino !== ino) { known.watcher.close(); fileWatchers.delete(target); }
      if (ino === null || fileWatchers.has(target)) continue;
      const entry = { ino, watcher: watch(target, () => { try { refresh(); snapshot(); changed(); } catch (error) { changed(error); } }) };
      entry.watcher.on('error', error => changed(error));
      fileWatchers.set(target, entry);
    }
    for (const [directory, entry] of watchers) if (!directories.has(directory)) { entry.watcher.close(); watchers.delete(directory); }
    for (const [directory, names] of directories) {
      if (watchers.has(directory)) { watchers.get(directory).names = names; continue; }
      const entry = { names, watcher: null };
      entry.watcher = watch(directory, (event, filename) => {
        if (filename !== null && !entry.names.has(String(filename).split(sep)[0])) return;
        try { refresh(); snapshot(); changed(); } catch (error) { changed(error); }
      });
      entry.watcher.on('error', error => changed(error));
      watchers.set(directory, entry);
    }
  }
  /** Replace the input set after configuration or referenced boards change. */
  function update(values) {
    // An input that changed since the last snapshot must still wake the next wait: a write landing between a caller's read and this update would otherwise be absorbed when the lagging native event is lost under load [C7].
    const moved = targets.length > 0 && targets.some(target => signatures.has(target) && signatures.get(target) !== signature(target));
    targets = [...new Set(values.filter(Boolean).map(path => resolve(path instanceof URL ? fileURLToPath(path) : path)))];
    refresh();
    snapshot();
    if (moved && !closed) changed();
  }
  /** Observe future notifications and replay any change that preceded subscription. */
  function subscribe(listener) {
    listeners.add(listener);
    if (generation) queueMicrotask(() => { if (!closed && listeners.has(listener)) listener(failure); });
    return () => listeners.delete(listener);
  }
  /** Sleep until a retained generation changes or a real deadline arrives; no repeating timer is installed. */
  function wait({ after = generation, deadline = Infinity } = {}) {
    if (failure) return Promise.reject(failure);
    try { reconcile(); } catch (error) { return Promise.reject(error); }
    if (closed || generation !== after || Date.now() >= deadline) return Promise.resolve();
    return new Promise((done, reject) => {
      let timer;
      /** Release only this waiter and its deadline timer on every completion path. */
      function finish(error) { clearTimeout(timer); listeners.delete(finish); error ? reject(error) : done(); }
      listeners.add(finish);
      if (Number.isFinite(deadline)) timer = setTimeout(finish, Math.max(0, deadline - Date.now()));
    });
  }
  /** Close native handles and settle pending sleeps when their command or stream ends. */
  function close() {
    if (closed) return;
    closed = true;
    for (const entry of watchers.values()) entry.watcher.close();
    watchers.clear();
    for (const entry of fileWatchers.values()) entry.watcher.close();
    fileWatchers.clear();
    for (const listener of [...listeners]) listener();
    listeners.clear();
  }
  try { update(paths); } catch (error) { close(); throw error; }
  return { update, subscribe, wait, close, version: () => generation };
}
