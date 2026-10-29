/** Read and strictly validate the controller's one-shot work specification [C7]. */
import { runnerPolicyRecord } from './runner-policy.js';
import { privateCheckEnvelope } from './runner-private-mode.js';
import { recoveryIdentity } from './runner-transport.js';
import { runnerLaunchAllowed } from './runner-transport.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  if (!value || value.version !== 1 || !/^[A-Za-z0-9_-]{1,100}$/u.test(value.id)
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.commit)
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.tree)
    || value.commit.length !== value.tree.length
    || !/^[a-f0-9]{64}$/u.test(value.repoId ?? '')
    || typeof value.command !== 'string' || !value.command.trim()
    || typeof value.pipefail !== 'boolean' || !Number.isSafeInteger(value.slots) || value.slots < 1
    || !Number.isSafeInteger(value.browser) || value.browser < 0
    || typeof value.browserRequired !== 'boolean'
    || value.browserRequired && value.browser < 1
    || value.guiRequired !== undefined && typeof value.guiRequired !== 'boolean'
    || (value.timing !== undefined && typeof value.timing !== 'boolean')
    || (value.browserByLaunch !== undefined && typeof value.browserByLaunch !== 'boolean')
    || !value.runtime || typeof value.runtime !== 'object' || !value.runtime.files || typeof value.runtime.files !== 'object'
    || typeof value.runtime.sha256 !== 'string') throw new Error('invalid work specification');
  if (value.recovery !== undefined && (!recoveryIdentity(value.recovery) || value.recovery.request !== value.id || value.recovery.tooling !== value.tooling?.sha256)) throw new Error('invalid recovery identity');
  if (value.trustedMode !== undefined) {
    const mode = privateCheckEnvelope(value.trustedMode);
    if (mode.policyCommit.length !== value.commit.length || value.command !== mode.check || value.landing === true || value.stageMarker !== undefined) throw new Error('invalid trusted private-check source');
    value.trustedMode = mode;
  }
  if (value.trunk !== undefined) {
    if (value.trustedMode) throw new Error('ambiguous runner policy context');
    runnerPolicyRecord(value);
  }
  if (value.timeoutMs !== undefined && (value.landing !== true || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 2_147_483_647)) throw new Error('invalid landing timeout');
  if (value.stageMarker !== undefined && !/^PULLBOARD_STAGE_[a-f0-9]{32}$/u.test(value.stageMarker)) throw new Error('invalid stage marker');
  if (value.waivers !== undefined && (!Array.isArray(value.waivers) || value.waivers.some(entry => !entry || !['file', 'name'].includes(entry.kind) || typeof entry.test !== 'string' || !entry.test || Object.keys(entry).some(key => !['kind', 'test'].includes(key))))) throw new Error('invalid continuation projection');
  if (value.origin !== undefined) {
    if (typeof value.origin !== 'string') throw new Error('invalid work specification');
    let origin;
    try { origin = new URL(value.origin); } catch { throw new Error('invalid work specification'); }
    if (origin.protocol !== 'https:' || !origin.hostname || origin.username || origin.password || origin.search || origin.hash) {
      throw new Error('invalid work specification');
    }
  }
  if (value.originBase !== undefined
    && (typeof value.originBase !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.originBase)
      || value.originBase.length !== value.commit.length || !value.origin)) throw new Error('invalid work specification');
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
  if (value.runtime.entry !== 'src/runner-worker.js' || Object.keys(value.runtime.files).length > 4096
    || !Object.hasOwn(value.runtime.files, 'package.json')
    || Object.entries(value.runtime.files).some(([name, source]) => !name || name.startsWith('/')
      || name.split('/').some(part => !part || part === '.' || part === '..')
      || /[\\\u0000-\u001f\u007f]/u.test(name) || typeof source !== 'string'
      || name === value.runtime.entry)) throw new Error('invalid trusted runtime paths');
  if (createHash('sha256').update(JSON.stringify(value.runtime.files)).digest('hex') !== value.runtime.sha256) throw new Error('invalid trusted runtime');
  const workerSource = readFileSync(fileURLToPath(S.entryUrl), 'utf8');
  const toolingFiles = Object.fromEntries(Object.entries({ ...value.runtime.files, [value.runtime.entry]: workerSource })
    .sort(([a], [b]) => a.localeCompare(b)));
  if (!workerSource || !value.tooling || !['git-checkout', 'installed-package'].includes(value.tooling.kind)
    || value.tooling.name !== 'pullboard' || typeof value.tooling.version !== 'string'
    || createHash('sha256').update(JSON.stringify(toolingFiles)).digest('hex') !== value.tooling.sha256) {
    throw new Error('invalid trusted tooling identity');
  }
  for (const field of ['landing', 'itemCheck', 'diagnostic', 'auditCoverage']) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean') throw new Error('invalid work specification');
  }
  for (const field of ['item', 'kind']) {
    if (value[field] !== undefined && typeof value[field] !== 'string') throw new Error('invalid work specification');
  }
  if (value.timingRunId !== undefined && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.timingRunId)) throw new Error('invalid timing invocation');
  if (value.testResults !== undefined && (!Array.isArray(value.testResults.inputKeys)
    || value.testResults.inputKeys.some(key => typeof key !== 'string' || !/^[0-9a-f]{64}$/u.test(key))
    || !(value.testResults.packet === null || typeof value.testResults.packet === 'string')
    || !/^[a-z][a-z0-9-]{0,63}$/u.test(value.testResults.stage)
    || typeof value.testResults.origin !== 'string' || /[\r\n\0]/u.test(value.testResults.origin))) throw new Error('invalid test-result exchange');
  if (value.root !== undefined && (typeof value.root !== 'string' || !isAbsolute(value.root))) throw new Error('invalid work specification');
  if (value.recovery?.launchFence === 1) {
    const root = value.root ?? join(isAbsolute(process.env.HOME || '') ? process.env.HOME : userInfo().homedir, '.pullboard-runner');
    if (!runnerLaunchAllowed(root, value.recovery)) throw new Error('runner launch was fenced or unclaimed');
  }
  return value;
}
