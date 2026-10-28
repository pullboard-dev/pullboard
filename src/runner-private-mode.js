/** Canonical controller-owned private-check policy shared by the authenticated runner endpoints [C7,V4]. */
import { createHash } from 'node:crypto';

/** Refuse unknown protocol fields rather than silently changing what the policy hash covers. */
function keys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('invalid private-check fields');
}

/** Validate immutable Git object names without interpreting them as Git revisions or arguments. */
function object(value) {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
}

/** Keep declarative guard paths inside the private checkout before the worker resolves symlinks. */
function guardPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.startsWith('/') && !/[\\\u0000-\u001f\u007f]/u.test(value) && !value.split('/').some(part => part === '..' || part === '' || part === '.');
}

/** Normalize only the two existing frozen guard forms, never an executable callback or arbitrary patch command. */
export function privateGuard(value) {
  if (value == null) return null;
  if (typeof value.patch === 'string') {
    keys(value, ['text', 'patch']);
    if (!guardPath(value.patch) || value.text !== `patch ${value.patch}`) throw new Error('invalid private-check guard');
    return { text: value.text, patch: value.patch };
  }
  keys(value, ['text', 'path', 'from', 'to']);
  if (!guardPath(value.path) || !Number.isSafeInteger(value.from) || value.from < 1 || !Number.isSafeInteger(value.to) || value.to < value.from || value.text !== `${value.path}:${value.from}-${value.to}`) throw new Error('invalid private-check guard');
  return { text: value.text, path: value.path, from: value.from, to: value.to };
}

/** Bind every controller-selected policy input in one canonical envelope; checked source is separately receipt-bound. */
export function privateCheckEnvelope(value) {
  keys(value, ['kind', 'version', 'install', 'check', 'timeoutMs', 'policyCommit', 'trunk', 'guard', 'sha256']);
  if (value.kind !== 'private-check' || value.version !== 1 || typeof value.install !== 'string' || typeof value.check !== 'string' || !value.check.trim() || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 2147483647 || !object(value.policyCommit)) throw new Error('invalid private-check policy');
  keys(value.trunk, ['ref', 'commit']);
  if (typeof value.trunk.ref !== 'string' || !value.trunk.ref.startsWith('refs/heads/') || /[\s\u0000-\u001f\u007f]/u.test(value.trunk.ref) || !object(value.trunk.commit) || value.policyCommit.length !== value.trunk.commit.length) throw new Error('invalid private-check trunk');
  const policy = { kind: 'private-check', version: 1, install: value.install, check: value.check, timeoutMs: value.timeoutMs, policyCommit: value.policyCommit, trunk: { ref: value.trunk.ref, commit: value.trunk.commit }, guard: privateGuard(value.guard) };
  const sha256 = createHash('sha256').update(JSON.stringify(policy)).digest('hex');
  if (value.sha256 !== undefined && value.sha256 !== sha256) throw new Error('private-check policy digest does not match');
  return { ...policy, sha256 };
}

/** Authenticate the complete phase layout before the controller copies any bytes into a named phase artifact. */
export function privateCheckPhases(mode, receipt, totalBytes) {
  keys(receipt, ['kind', 'version', 'requestSha256', 'phases', 'guard', 'sourceUnchanged', 'problem']);
  if (receipt.kind !== 'private-check' || receipt.version !== 1 || receipt.requestSha256 !== mode.sha256 || typeof receipt.sourceUnchanged !== 'boolean' || !Number.isSafeInteger(totalBytes) || totalBytes < 0) throw new Error('invalid private-check receipt');
  keys(receipt.phases, ['install', 'check']);
  let offset = 0;
  for (const name of ['install', 'check']) {
    const phase = receipt.phases[name];
    if (phase == null) continue;
    keys(phase, ['offset', 'length', 'sha256', 'code', 'signal', 'timedOut']);
    if (phase.offset !== offset || !Number.isSafeInteger(phase.length) || phase.length < 0 || !/^[a-f0-9]{64}$/u.test(phase.sha256 ?? '') || !Number.isInteger(phase.code) || phase.code < 0 || phase.code > 255 || phase.signal !== null && typeof phase.signal !== 'string' || typeof phase.timedOut !== 'boolean') throw new Error('invalid private-check phase');
    offset += phase.length;
    if (!Number.isSafeInteger(offset) || offset > totalBytes) throw new Error('private-check phase exceeds its output');
  }
  if (offset !== totalBytes || !mode.install && receipt.phases.install != null || mode.install && !receipt.phases.install && !receipt.problem) throw new Error('incomplete private-check phases');
  if (receipt.problem != null) {
    keys(receipt.problem, ['stage', 'message']);
    if (!['guard', 'install', 'check'].includes(receipt.problem.stage) || typeof receipt.problem.message !== 'string' || !receipt.problem.message || receipt.problem.message.length > 4096) throw new Error('invalid private-check problem');
  }
  if (mode.guard) {
    keys(receipt.guard, ['applied', 'problem']);
    if (typeof receipt.guard.applied !== 'boolean' || typeof receipt.guard.problem !== 'string' || receipt.guard.problem.length > 4096 || receipt.guard.applied && receipt.guard.problem || !receipt.guard.applied && !receipt.guard.problem || receipt.guard.applied && receipt.sourceUnchanged) throw new Error('invalid private-check guard receipt');
  } else if (receipt.guard != null) throw new Error('unexpected private-check guard receipt');
  const install = receipt.phases.install;
  const check = receipt.phases.check;
  if (install && (install.code !== 0 || install.signal || install.timedOut) && check) throw new Error('private check ran after a failed install');
  if (receipt.problem) return { state: 'unverified', stage: receipt.problem.message };
  if (mode.guard && !receipt.guard.applied) return { state: 'unverified', stage: 'guard could not be reverted' };
  if (install && (install.code !== 0 || install.signal || install.timedOut)) return { state: 'unverified', stage: install.timedOut ? 'install timed out' : 'install failed' };
  if (!check) throw new Error('missing private-check completion');
  if (check.timedOut || check.signal) return { state: 'unverified', stage: check.timedOut ? `check timed out after ${(mode.timeoutMs / 1000).toFixed(1)} seconds against its ${(mode.timeoutMs / 1000).toFixed(1)} second ceiling` : 'check could not complete' };
  return { state: check.code === 0 ? 'pass' : 'red', stage: check.code === 0 ? 'check' : `check failed (exit ${check.code})` };
}
