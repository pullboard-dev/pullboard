/** Runner source identity and transport-loss types: the part of gate-policy-load the runner worker and runners need without the config package [C7,Q1]. */
import { isClean } from '../../../git/light.js';
import { untracked } from '../../../git/light.js';
import { headCommit } from '../../../git/light.js';
import { headTree } from '../../../git/light.js';

/** Dirty or non-repository commands cannot claim to execute an exact committed source remotely. */
export function runnerSource(root) {
  try {
    if (!isClean(root) || untracked(root).length) return null;
    return { commit: headCommit(root), tree: headTree(root) };
  } catch { return null; }
}

/** A missing authenticated completion receipt is a transport loss, never a passing test result. */
export class RunnerDropped extends Error {
  constructor(host, diagnostic = { reason: 'completion unavailable' }) {
    super(`runner ${host} disconnected before a complete result; the run returns to the queue`);
    this.name = 'RunnerDropped';
    this.host = host;
    this.diagnostic = diagnostic;
  }
}

