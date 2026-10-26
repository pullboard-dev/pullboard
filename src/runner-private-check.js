/** Controller-side private-check artifact custody; worker framing never comes from command text [C7,V4]. */
import { createHash } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { runOnRunner } from './runners.js';
import { privateCheckEnvelope } from './runner-private-mode.js';
import {
  policyGit,
  trunkRef,
} from './trusted-policy-read.js';
import {
  timingFromLog,
  timingRunner,
} from './timing.js';

/** Copy one authenticated phase without buffering the full command output into controller memory. */
function phaseCopy(raw, phase, path) {
  const input = openSync(raw, 'r');
  const output = openSync(path, 'wx', 0o600);
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  const captures = [];
  let captureBytes = 0;
  try {
    while (offset < phase.length) {
      const count = readSync(input, buffer, 0, Math.min(buffer.length, phase.length - offset), phase.offset + offset);
      if (!count) throw new Error('private-check phase capture is incomplete');
      const bytes = buffer.subarray(0, count);
      hash.update(bytes);
      let written = 0;
      while (written < count) {
        const progress = writeSync(output, bytes, written, count - written);
        if (!progress) throw new Error('private-check artifact write made no progress');
        written += progress;
      }
      captures.push(Buffer.from(bytes));
      captureBytes += count;
      while (captureBytes > 8 * 1024 * 1024) {
        const excess = captureBytes - 8 * 1024 * 1024;
        if (captures[0].length <= excess) captureBytes -= captures.shift().length;
        else { captures[0] = captures[0].subarray(excess); captureBytes -= excess; }
      }
      offset += count;
    }
    if (hash.digest('hex') !== phase.sha256) throw new Error('private-check phase digest does not match');
    return Buffer.concat(captures, captureBytes).toString('utf8');
  } finally { closeSync(input); closeSync(output); }
}

/** Run only under an actual runner lease, preserving raw evidence even when formatting or transport fails. */
export function runnerPrivateCheck(root, item, command, policy, lease, guard, waitMs, format) {
  const common = policyGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  const artifactRoot = join(common, 'pullboard', 'check-output');
  mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(artifactRoot, 'private-runner-'));
  const ref = trunkRef(root);
  const mode = privateCheckEnvelope({ kind: 'private-check', version: 1, install: policy.config.check.install,
    check: command, timeoutMs: policy.config.check.timeoutMs, policyCommit: policy.commit,
    trunk: { ref, commit: policyGit(root, ['rev-parse', `${ref}^{commit}`]).trim() }, guard });
  const checkedSource = { commit: item.item_commit, tree: policyGit(root, ['rev-parse', `${item.item_commit}^{tree}`]).trim() };
  const started = Date.now();
  lease.tracker?.mark('runAt');
  const result = runOnRunner(root, command, { runner: lease.runner, source: lease.source, runnerWaitDeadline: lease.runnerWaitDeadline, browser: lease.browser,
    metadata: lease.runMetadata, checkedSource, privateCheck: mode, rawOutputPath: join(directory, 'raw.log') });
  lease.tracker?.mark('ranAt');
  lease.environment = result.environment ?? null;
  lease.gui = result.executionCapabilities?.gui ?? null;
  lease.executionAdmission = result.executionAdmission ?? null;
  let installCapture = '';
  let checkCapture = '';
  let installLogPath = '';
  let checkLogPath = '';
  let captureProblem = false;
  try {
    for (const name of ['install', 'check']) {
      const phase = result.privateCheck.receipt.phases[name];
      if (!phase) continue;
      const path = join(directory, `${name}.log`);
      const capture = phaseCopy(result.rawOutputPath, phase, path);
      if (name === 'install') { installCapture = capture; installLogPath = path; }
      else { checkCapture = capture; checkLogPath = path; }
    }
  } catch { captureProblem = true; }
  const profile = checkLogPath ? timingFromLog(checkLogPath, timingRunner(command)) : { files: [], tests: [] };
  const formatted = format(captureProblem ? 'unverified' : result.privateCheck.state, captureProblem ? `private-check output could not be authenticated or saved; raw output retained at ${result.rawOutputPath} sha256 ${result.rawOutputSha256}` : result.privateCheck.stage, installCapture, checkCapture,
    { root, item, commandRoot: result.executionRoot, installLogPath, checkLogPath, waitMs,
      timingProfile: { ...profile, wallMs: Date.now() - started, environment: result.environment, testRuntimes: result.testRuntimes,
        executionRunner: result.executionRunner, executionSource: result.executionSource, executionMain: result.executionMain,
        executionLoad: result.executionLoad, executionAdmission: result.executionAdmission,
        privateCheckPolicySha256: mode.sha256, rawOutputPath: result.rawOutputPath, rawOutputSha256: result.rawOutputSha256 },
      environment: result.environment, testRuntimes: result.testRuntimes, executionSourceUnchanged: result.privateCheck.receipt.sourceUnchanged });
  return { ...formatted, testRuntimes: result.testRuntimes ?? null, sandboxBlocked: result.sandboxBlocked ?? formatted.sandboxBlocked, executionRunner: result.executionRunner, executionSource: result.executionSource,
    executionLoad: result.executionLoad, executionMain: result.executionMain, executionAdmission: result.executionAdmission,
    rawOutputPath: result.rawOutputPath, rawOutputSha256: result.rawOutputSha256,
    guardProblem: result.privateCheck.receipt.guard?.problem ?? '',
    executionNote: `\nprivate check executed on runner ${result.executionRunner} at ${checkedSource.commit}; trusted policy ${policy.commit}; raw output ${result.rawOutputPath} sha256 ${result.rawOutputSha256}` };
}
