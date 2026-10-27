/** Pure runner registration, source identity and transport-loss types shared by admission [C7,Q1]. */
import {
  isClean,
  untracked,
  headCommit,
  headTree,
} from './git.js';

/** Preserve the canonical pure registration validator without loading the full runner. */
export { validateRunner } from './runner-registration.js';

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

