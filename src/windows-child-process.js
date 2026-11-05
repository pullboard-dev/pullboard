import * as native from 'node:child_process';
import { promisify } from 'node:util';

const wrappedProcesses = new WeakMap();

/** Detached views have no console to inherit, so even Git reads can create visible windows. */
export function hideConsoleWindow(run, platform = process.platform) {
  if (platform !== 'win32') return run;
  if (wrappedProcesses.has(run)) return wrappedProcesses.get(run);
  const wrapped = function (...args) {
    const index =
      Array.isArray(args[1]) ||
      (args[1] == null && args.length >= 3 && typeof args[2] !== 'function')
        ? 2
        : 1;
    const options = args[index];
    if (typeof options === 'function') args.splice(index, 0, { windowsHide: true });
    else if (options == null || (typeof options === 'object' && !Array.isArray(options))) {
      args[index] = { ...options, windowsHide: true };
    }
    return Reflect.apply(run, this, args);
  };
  wrappedProcesses.set(run, wrapped);
  if (typeof run[promisify.custom] === 'function') {
    Object.defineProperty(wrapped, promisify.custom, {
      configurable: true,
      value: hideConsoleWindow(run[promisify.custom], platform),
    });
  }
  return wrapped;
}

/** Native guards replace these methods after imports, so dispatch must observe their live bindings. */
function liveProcess(method) {
  const run = function (...args) {
    return Reflect.apply(hideConsoleWindow(native[method]), this, args);
  };
  Object.defineProperty(run, promisify.custom, {
    configurable: true,
    get() {
      const custom = native[method][promisify.custom];
      return typeof custom === 'function' ? hideConsoleWindow(custom) : undefined;
    },
  });
  return run;
}

export const spawn = liveProcess('spawn');
export const spawnSync = liveProcess('spawnSync');
export const execFile = liveProcess('execFile');
export const execFileSync = liveProcess('execFileSync');
