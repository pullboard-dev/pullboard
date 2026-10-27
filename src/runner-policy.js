/** Pure runner registration, source identity and transport-loss types shared by admission [C7,Q1]. */
import { Refused } from './refused.js';
import {
  isClean,
  untracked,
  headCommit,
  headTree,
} from './git.js';

/** Validate an SSH destination as one argument, never a command or an SSH option. */
export function validateRunner(value) {
  if (!value || typeof value.host !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.@:\[\]-]{0,254}$/u.test(value.host)
    || !Number.isSafeInteger(value.slots) || value.slots < 1
    || !Number.isSafeInteger(value.browser) || value.browser < 0 || value.browser > value.slots) {
    throw new Refused('BAD_RUNNER', 'use an SSH host or alias, positive --slots, and --browser from zero through slots');
  }
  if (value.gui !== undefined && value.gui !== null && typeof value.gui !== 'boolean') throw new Refused('BAD_RUNNER', 'runner gui must be true, false, or unknown');
  for (const key of ['node', 'root']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || /[\u0000-\u001f\u007f]/u.test(value[key])
      || !(value[key].startsWith('/') && value[key].length > 1 || key === 'node' && value[key] === 'node'))) {
      throw new Refused('BAD_RUNNER', `runner ${key} must be an absolute remote path${key === 'node' ? ' or node' : ''}`);
    }
  }
  return { host: value.host, slots: value.slots, browser: value.browser, ...(value.gui !== undefined ? { gui: value.gui } : {}),
    ...(value.node ? { node: value.node } : {}), ...(value.root ? { root: value.root } : {}) };
}

/** Dirty or non-repository commands cannot claim to execute an exact committed source remotely. */
export function runnerSource(root) {
  try {
    if (!isClean(root) || untracked(root).length) return null;
    return { commit: headCommit(root), tree: headTree(root) };
  } catch { return null; }
}

/** A missing authenticated completion receipt is a transport loss, never a passing test result. */
export class RunnerDropped extends Error {
  constructor(host) {
    super(`runner ${host} disconnected before a complete result; the run returns to the queue`);
    this.name = 'RunnerDropped';
    this.host = host;
  }
}

