import { processCensus } from '../custody.js';
/** Read and strictly validate the controller's one-shot work specification [C7]. */
import { runnerPolicyRecord } from '../../../../../packages/sandbox/light.js';
import { trustedWorkerEntry } from '../../../../../packages/runners/light.js';
import { runnerPublicKeyProblem } from '../../../../../packages/runners/light.js';
import { privateCheckEnvelope } from '../private/guard.js';
import { analysisArtifactDescriptor } from '../../../../../packages/resources/light.js';
import { recoveryIdentity } from '../../../../../packages/resources/light.js';
import { claimRunnerWorker } from '../../../../../packages/runners/light.js';
import { createHash } from 'node:crypto';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';
import { environmentAdapter } from '../../../../../packages/env/index.js';
import { userInfo } from 'node:os';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const fs = fileSystemAdapter();

/**
 * Name the first top-level rule a work specification breaks, or '' when none.
 * Why: the controller records this fixed text, so a refusal says which field failed without echoing any value.
 */
function firstBrokenRule(value) {
  const rules = [
    ['work specification is not an object with version 1', () => !value || value.version !== 1],
    ['work specification id is malformed', () => !/^[A-Za-z0-9_-]{1,100}$/u.test(value.id)],
    ['work specification commit is malformed', () => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.commit)],
    ['work specification tree is malformed', () => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.tree)],
    ['work specification commit and tree lengths differ', () => value.commit.length !== value.tree.length],
    ['work specification repoId is malformed', () => !/^[a-f0-9]{64}$/u.test(value.repoId ?? '')],
    ['work specification command is empty', () => typeof value.command !== 'string' || !value.command.trim()],
    ['work specification pipefail is not boolean', () => typeof value.pipefail !== 'boolean'],
    ['work specification slots is not a positive integer', () => !Number.isSafeInteger(value.slots) || value.slots < 1],
    ['work specification browser is not a count', () => !Number.isSafeInteger(value.browser) || value.browser < 0],
    ['work specification browserRequired is not boolean', () => typeof value.browserRequired !== 'boolean'],
    ['work specification requires a browser the runner lacks', () => value.browserRequired && value.browser < 1],
    ['work specification guiRequired is not boolean', () => value.guiRequired !== undefined && typeof value.guiRequired !== 'boolean'],
    ['work specification timing is not boolean', () => value.timing !== undefined && typeof value.timing !== 'boolean'],
    ['work specification browserByLaunch is not boolean', () => value.browserByLaunch !== undefined && typeof value.browserByLaunch !== 'boolean'],
    ['work specification runtime files are missing', () => !value.runtime || typeof value.runtime !== 'object' || !value.runtime.files || typeof value.runtime.files !== 'object'],
    ['work specification runtime digest is missing', () => typeof value.runtime.sha256 !== 'string'],
  ];
  for (const [message, broken] of rules) if (broken()) return message;
  return '';
}

/**
 * Fill a runtime the controller named by digest and file names from the capsule this worker was just installed from.
 * Why: the same bytes already arrive gzipped in the stdin capsule, and inlining them as well put the spec past its
 * 1 MiB frame (#3884). The rebuilt files then pass the same digest and tooling checks as inline ones; a name that is
 * unsafe, missing or unreadable refuses the job.
 */
function hydrateRuntime(value, S) {
  const runtime = value?.runtime;
  if (!runtime || typeof runtime !== 'object' || runtime.files !== undefined || runtime.names === undefined) return;
  const { names } = runtime;
  if (!Array.isArray(names) || names.length > 4096 || names.some(name => typeof name !== 'string' || !name || name.startsWith('/')
    || name.split('/').some(part => !part || part === '.' || part === '..') || /[\\\u0000-\u001f\u007f]/u.test(name))) {
    throw new Error('invalid trusted runtime paths');
  }
  // The runtime root sits six levels above the entry, apps/runner/src/io/scripts/worker.js [V32].
  const root = dirname(dirname(dirname(dirname(dirname(dirname(fileURLToPath(S.entryUrl)))))));
  const files = {};
  for (const name of names) {
    try { files[name] = fs.readFile(join(root, name), 'utf8'); }
    catch { throw new Error('trusted runtime cache does not match the request'); }
  }
  value.runtime = { entry: runtime.entry, files, sha256: runtime.sha256 };
}

/** Parse and strictly validate the controller's one-shot work specification. */
export async function readSpec(S) {
  let buffered = Buffer.alloc(0);
  let expected = null;
  let headerLength = null;
  const spec = await new Promise((resolve, reject) => {
    const cleanup = () => { process.stdin.off('data', onData); process.stdin.off('end', onEnd); process.stdin.off('error', onError); };
    S.rejectPendingFrame = error => { cleanup(); reject(error); };
    const onError = error => { cleanup(); reject(error); };
    const onEnd = () => { cleanup(); reject(new Error('incomplete work specification')); };
    const onData = chunk => {
      if (S.transportLost) { cleanup(); reject(new Error('runner transport was lost')); return; }
      buffered = Buffer.concat([buffered, chunk]);
      if (expected === null) {
        const newline = buffered.indexOf(10);
        if (newline < 0) {
          if (buffered.length > 9 || !/^\d*$/u.test(buffered.toString('ascii'))) { cleanup(); reject(new Error('invalid work specification frame')); }
          return;
        }
        const header = buffered.subarray(0, newline).toString('ascii');
        if (!/^\d{1,8}$/u.test(header)) { cleanup(); reject(new Error('invalid work specification frame')); return; }
        expected = Number(header);
        headerLength = newline + 1;
        if (!expected || expected > 1_048_576) { cleanup(); reject(new Error('invalid work specification frame')); return; }
      }
      if (buffered.length < headerLength + expected) return;
      const body = buffered.subarray(headerLength, headerLength + expected);
      const rest = buffered.subarray(headerLength + expected);
      cleanup();
      S.rejectPendingFrame = null;
      process.stdin.pause();
      if (rest.length) process.stdin.unshift(rest);
      try { resolve(JSON.parse(body.toString('utf8'))); } catch (error) { reject(error); }
    };
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.once('error', onError);
    process.stdin.resume();
  });
  const value = spec;
  hydrateRuntime(value, S);
  if (Number.isSafeInteger(value?.version) && value.version >= 0 && value.version !== 1) S.workSpecVersion = value.version;
  const rule = firstBrokenRule(value);
  if (rule) throw new Error(rule);
  if (value.recovery !== undefined && (!recoveryIdentity(value.recovery) || value.recovery.request !== value.id || value.recovery.tooling !== value.tooling?.sha256)) throw new Error('invalid recovery identity');
  if (value.runnerPublicKey !== undefined && runnerPublicKeyProblem(value.runnerPublicKey)) throw new Error('invalid runner signing key identity');
  if (value.trustedMode !== undefined) {
    const mode = privateCheckEnvelope(value.trustedMode);
    if (mode.policyCommit.length !== value.commit.length || value.command !== mode.check || value.landing === true || value.stageMarker !== undefined) throw new Error('invalid trusted private-check source');
    value.trustedMode = mode;
  }
  if (value.analysisArtifact !== undefined) {
    value.analysisArtifact = analysisArtifactDescriptor(value.analysisArtifact, value.trustedMode?.sha256);
  }
  if (value.trunk !== undefined) {
    if (value.trustedMode) throw new Error('ambiguous runner policy context');
    runnerPolicyRecord(value);
  }
  if (value.timeoutMs !== undefined && (value.landing !== true || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 2_147_483_647)) throw new Error('invalid landing timeout');
  if (value.stageMarker !== undefined && !/^PULLBOARD_STAGE_[a-f0-9]{32}$/u.test(value.stageMarker)) throw new Error('invalid stage marker');
  if (value.waivers !== undefined && (!Array.isArray(value.waivers) || value.waivers.some(entry => !entry || !['file', 'name', 'case'].includes(entry.kind) || typeof entry.test !== 'string' || !entry.test || Object.keys(entry).some(key => !(entry.kind === 'case' ? ['kind', 'test', 'file'] : ['kind', 'test']).includes(key))
    || entry.kind === 'case' && (typeof entry.file !== 'string' || !entry.file || entry.file.startsWith('/')
      || /[\\\r\n\0]/u.test(entry.file) || entry.file.split('/').some(part => !part || part === '.' || part === '..'))))) throw new Error('invalid continuation projection');
  if (value.origin !== undefined) {
    if (typeof value.origin !== 'string') throw new Error('work specification origin is not a string');
    let origin;
    try { origin = new URL(value.origin); } catch { throw new Error('work specification origin is not a URL'); }
    if (origin.protocol !== 'https:' || !origin.hostname || origin.username || origin.password || origin.search || origin.hash) {
      throw new Error('work specification origin must be a plain https URL');
    }
  }
  if (value.originBase !== undefined
    && (typeof value.originBase !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.originBase)
      || value.originBase.length !== value.commit.length || !value.origin)) throw new Error('work specification originBase is malformed or has no origin');
  if (!Array.isArray(value.tags) || value.tags.length > 1_024) throw new Error('invalid tag manifest');
  const tagNames = new Set();
  for (const tag of value.tags) {
    if (!tag || typeof tag.name !== 'string' || !tag.name.startsWith('refs/tags/') || tag.name.length > 1_024
      || /[\u0000-\u001f\u007f]/u.test(tag.name) || tagNames.has(tag.name)
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(tag.object ?? '')
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(tag.peeledCommit ?? '')
      || tag.object.length !== value.commit.length || tag.peeledCommit.length !== value.commit.length
      || !Array.isArray(tag.chain) || tag.chain.length > 8
      || tag.chain.some(object => typeof object !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(object)
        || object.length !== value.commit.length)) throw new Error('invalid tag manifest');
    tagNames.add(tag.name);
    if (tag.chain.length ? tag.chain[0] !== tag.object : tag.object !== tag.peeledCommit) throw new Error('invalid tag manifest');
  }
  if (!trustedWorkerEntry(value.runtime.entry) || Object.keys(value.runtime.files).length > 4096
    || !Object.hasOwn(value.runtime.files, 'package.json')
    || Object.entries(value.runtime.files).some(([name, source]) => !name || name.startsWith('/')
      || name.split('/').some(part => !part || part === '.' || part === '..')
      || /[\\\u0000-\u001f\u007f]/u.test(name) || typeof source !== 'string'
      || name === value.runtime.entry)) throw new Error('invalid trusted runtime paths');
  if (createHash('sha256').update(JSON.stringify(value.runtime.files)).digest('hex') !== value.runtime.sha256) throw new Error('invalid trusted runtime');
  const workerSource = fs.readFile(fileURLToPath(S.entryUrl), 'utf8');
  const toolingFiles = Object.fromEntries(Object.entries({ ...value.runtime.files, [value.runtime.entry]: workerSource })
    .sort(([a], [b]) => a.localeCompare(b)));
  if (!workerSource || !value.tooling || !['git-checkout', 'installed-package'].includes(value.tooling.kind)
    || value.tooling.name !== 'pullboard' || typeof value.tooling.version !== 'string'
    || createHash('sha256').update(JSON.stringify(toolingFiles)).digest('hex') !== value.tooling.sha256) {
    throw new Error('invalid trusted tooling identity');
  }
  for (const field of ['landing', 'itemCheck', 'diagnostic', 'auditCoverage']) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean') throw new Error(`work specification ${field} is not boolean`);
  }
  if (value.handoff !== undefined && (!value.handoff || typeof value.handoff !== 'object' || Array.isArray(value.handoff) || value.landing === true || value.trustedMode)) throw new Error('invalid hand-off ticket');
  for (const field of ['item', 'kind']) {
    if (value[field] !== undefined && typeof value[field] !== 'string') throw new Error(`work specification ${field} is not a string`);
  }
  if (value.timingRunId !== undefined && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.timingRunId)) throw new Error('invalid timing invocation');
  if (value.testResults !== undefined && (!Array.isArray(value.testResults.inputKeys)
    || value.testResults.inputKeys.some(key => typeof key !== 'string' || !/^[0-9a-f]{64}$/u.test(key))
    || !(value.testResults.packet === null || typeof value.testResults.packet === 'string')
    || !/^[a-z][a-z0-9-]{0,63}$/u.test(value.testResults.stage)
    || typeof value.testResults.origin !== 'string' || /[\r\n\0]/u.test(value.testResults.origin))) throw new Error('invalid test-result exchange');
  if (value.root !== undefined && (typeof value.root !== 'string' || !isAbsolute(value.root))) throw new Error('work specification root is not an absolute path');
  if (value.recovery?.launchFence === 1) {
    const root = value.root ?? join(isAbsolute(environmentAdapter().get('HOME', '')) ? environmentAdapter().get('HOME') : userInfo().homedir, '.pullboard-runner');
    if (!claimRunnerWorker(root, value.recovery, processCensus)) throw new Error('runner launch was fenced or unclaimed');
  }
  return value;
}
