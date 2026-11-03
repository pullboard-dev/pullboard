/** Native file notifications share one wake generation without periodic polling [C7]. */
import { existsSync } from 'node:fs';
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
    for (const [directory, entry] of watchers) if (!directories.has(directory)) { entry.watcher.close(); watchers.delete(directory); }
    for (const [directory, names] of directories) {
      if (watchers.has(directory)) { watchers.get(directory).names = names; continue; }
      const entry = { names, watcher: null };
      entry.watcher = watch(directory, (event, filename) => {
        if (filename !== null && !entry.names.has(String(filename).split(sep)[0])) return;
        try { refresh(); changed(); } catch (error) { changed(error); }
      });
      entry.watcher.on('error', error => changed(error));
      watchers.set(directory, entry);
    }
  }
  /** Replace the input set after configuration or referenced boards change. */
  function update(values) {
    targets = [...new Set(values.filter(Boolean).map(path => resolve(path instanceof URL ? fileURLToPath(path) : path)))];
    refresh();
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
    for (const listener of [...listeners]) listener();
    listeners.clear();
  }
  try { update(paths); } catch (error) { close(); throw error; }
  return { update, subscribe, wait, close, version: () => generation };
}
