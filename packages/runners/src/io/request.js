/** Build one pinned, credential-free runner request from the admitted source [C7]. */
import { configFromSource } from '../../../config/index.js';
import { runnerSource } from '../../../gate/light.js';
import { validateRunner } from '../../../config/index.js';
import { repoInfo } from '../../../git/index.js';
import { secretsIn } from '../../../commits/index.js';
import { machineSettingsFile } from '../../../resources/index.js';
import { carriedBrowserByLaunch } from '../../../queue/index.js';
import { readMachineSettingsFile } from '../../../queue/index.js';
import { Refused } from '../../../kernel/index.js';
import { anonymousOrigin } from './pack.js';
import { candidateTags } from './pack.js';
import { originAncestor } from './pack.js';
import { validRunnerTrunk } from './policy.js';
import { remoteWorkerLaunch } from './tooling/remote.js';
import { runtimeHeld } from './runtime.js';
import { sshEnvironment } from './tooling/remote.js';
import { trustedTooling } from './tooling/remote.js';
import { protectHistory } from './source/scan.js';
import { protectionAt } from './source/scan.js';
import { sourceGit } from './source/scan.js';
import { sourceObjects } from './source/scan.js';
import { readAnalysisArtifact } from '../../../resources/index.js';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { scratchFolder } from '../../../config/index.js';

/**
 * Name the runtime by digest and file names; its bytes already travel gzipped in the stdin capsule.
 * Why: inlining the sources too put the spec past its 1 MiB frame once the worker code reached 1 MB (#3884).
 */
export function runtimeReference(runtime) {
  return { entry: runtime.entry, sha256: runtime.sha256, names: Object.keys(runtime.files) };
}
/**
 * The exact commit and tree a pinned source names, read from the repository's object store in place; null unless that
 * commit holds exactly that tree. Why: a main comparison cloned main into a temporary repository whose cache id was new
 * every time, so each one shipped the whole history to a cold runner cache (584 s median, #3323) [C7].
 */
function pinnedSource(root, source) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(source.commit ?? '') || typeof source.tree !== 'string') return null;
  try { return sourceGit(root, ['rev-parse', '--verify', `${source.commit}^{tree}`]).trim() === source.tree ? { commit: source.commit, tree: source.tree } : null; }
  catch { return null; }
}

/**
 * The commit and tree a queued run executes: its captured source when it names one, read from the object store if the
 * checkout's HEAD moved since it queued, else the clean checkout's HEAD; null when neither can be proved.
 * Why: runs queued from the main checkout were refused RUNNER_SOURCE_CHANGED whenever main landed under them; a queued
 * run is tied to the commit it captured, not to whatever the checkout holds later (#3928).
 *
 * @param {string} root
 * @param {{ commit?: string, tree?: string, pinned?: boolean } | undefined} source
 * @returns {{ commit: string, tree: string } | null}
 */
export function queuedSource(root, source) {
  const current = source?.pinned === true ? pinnedSource(root, source) : runnerSource(root);
  if (!source || current && current.commit === source.commit && current.tree === source.tree) return current;
  return pinnedSource(root, source) ?? current;
}

/** The test-result store a request's exchange wrote to, rebuilt by the later short process that finishes a pulled job [C7,#5465]. */
export async function exchangeStore(root) { return (await import('../../../gate/index.js')).testResultStore(root); }

/** Prepare the pinned request before negotiating history; cleanup owns only its scratch directory. */
export async function requestFor(root, command, { runner, source, browser = false, byLaunch, pipefail = false, stages = false, waivers = [], metadata = {}, privateCheck, checkedSource, rawOutputPath, analysisArtifact }, { privateCheckEnvelope }) {
  runner = validateRunner(runner);
  // A pinned source runs an exact commit from this repository's objects whatever its checkout holds; the cache id below
  // is still this repository's, so the runner reuses the cache its submits fill [C7,#3323].
  const current = queuedSource(root, source);
  if (!current || (source && (current.commit !== source.commit || current.tree !== source.tree))) {
    throw new Refused('RUNNER_SOURCE_CHANGED', 'the queued source changed; restore the committed tree and retry the run');
  }
  const trustedMode = privateCheck ? privateCheckEnvelope(privateCheck) : null;
  const artifact = analysisArtifact === undefined ? null : readAnalysisArtifact(analysisArtifact, trustedMode?.sha256);
  let selected = current;
  if (!trustedMode && metadata.trunk !== undefined) {
    if (!validRunnerTrunk(metadata.trunk, current.commit)) throw new Refused('NO_POLICY', 'the admitted runner policy is invalid; rerun through the controller with its pinned coordinator policy');
    selected = { ...current, extraCommits: [metadata.trunk.commit] };
  }
  if (trustedMode) {
    if (!checkedSource || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(checkedSource.commit ?? '')
      || sourceGit(root, ['rev-parse', `${checkedSource.commit}^{tree}`]).trim() !== checkedSource.tree
      || command !== trustedMode.check || typeof rawOutputPath !== 'string' || !isAbsolute(rawOutputPath)) {
      throw new Refused('RUNNER_SOURCE_CHANGED', 'the trusted private check source or output capture is invalid; restore its pinned commit and retry');
    }
    const owner = configFromSource(sourceGit(root, ['show', `${trustedMode.policyCommit}:pullboard.json`]));
    selected = { commit: checkedSource.commit, tree: checkedSource.tree,
      extraCommits: [...new Set([trustedMode.policyCommit, trustedMode.trunk.commit])], protect: owner.protect };
  }
  if (secretsIn([command, trustedMode?.install ?? ''].flatMap(value => value.split('\n')).map((text, index) => ({ path: 'run command', line: index + 1, text }))).length) {
    throw new Refused('RUNNER_SECRET', 'the run command contains a possible secret; use a command that does not transfer credentials');
  }
  const protection = [sourceObjects(root, selected)];
  if (!trustedMode && metadata.trunk) protection.push(protectionAt(root, metadata.trunk.commit));
  for (const commit of [selected.commit, ...(selected.extraCommits ?? [])]) protectHistory(root, { commit }, protection);
  const origin = anonymousOrigin(root);
  const originBase = origin ? originAncestor(root, selected) : undefined;
  const tags = candidateTags(root, selected);
  const repoId = createHash('sha256').update(realpathSync(repoInfo(root).commonDir)).digest('hex');
  const directory = scratchFolder('pullboard-runner-send-');
  try {
    // A caller that opted out of reuse (a test's own fixture runner) sends no exchange, so its worker runs every file.
    // A pinned main comparison never reuses or exports results, as it did from its throwaway clone's empty store.
    // A pinned record-only comparison (census, compare-main) is the exception: it exports its greens, never imports any.
    const reuse = process.env.PULLBOARD_TEST_REUSE !== '0' && (source?.pinned !== true || command.startsWith('PULLBOARD_TEST_REUSE=record '));
    // Loaded on demand: read commands that import this module never pay for the key analyzer.
    const exchange = reuse ? await (await import('../../../gate/index.js')).prepareTestResultExchange(root, command, selected.commit) : null;
    const { worker, tooling, runtime } = trustedTooling();
    // A private check or probe taken under a landing lease is never itself the landing run: the worker refuses a trusted check marked landing.
    const landing = metadata.landing === true && !trustedMode;
    const projection = landing && Array.isArray(waivers) ? waivers.filter(entry => ['file', 'name', 'case'].includes(entry?.kind) && typeof entry.test === 'string' && entry.test).filter(entry => entry.kind !== 'case' || typeof entry.file === 'string' && entry.file && !entry.file.startsWith('/')
      && !/[\\\r\n\0]/u.test(entry.file) && entry.file.split('/').every(part => part && part !== '.' && part !== '..'))
      .map(({ kind, test, file }) => ({ kind, test, ...(kind === 'case' ? { file } : {}) })) : [];
    if (secretsIn([{ path: 'runner continuation', line: 1, text: JSON.stringify(projection) }]).length) throw new Refused('RUNNER_SECRET', 'the continuation projection contains a possible secret; keep this run local');
    const stage = /^[a-z][a-z0-9-]{0,63}$/u.test(metadata.testStage ?? '') ? metadata.testStage : landing ? 'land' : 'focused';
    const id = randomUUID();
    const spec = { version: 1, id, recovery: { version: 1, launchFence: 1, request: id, nonce: randomUUID(), tooling: tooling.sha256 }, repoId, ...(originBase ? { origin, originBase } : {}), runtime: runtimeReference(runtime), tooling, tags, commit: selected.commit, tree: selected.tree, command, pipefail, slots: runner.slots,
      ...(runner.publicKey ? { runnerPublicKey: runner.publicKey } : {}),
      ...(reuse ? { testResults: { inputKeys: exchange?.inputKeys ?? [], packet: exchange?.packet ?? null, stage, origin: runner.host } } : {}),
      ...(trustedMode ? { trustedMode } : {}),
      ...(artifact ? { analysisArtifact: artifact.descriptor } : {}),
      ...(!trustedMode && metadata.trunk ? { trunk: { ...metadata.trunk } } : {}),
      browser: runner.browser, browserRequired: browser, guiRequired: metadata.gui === true, landing, auditCoverage: metadata.auditCoverage === true,
      ...(typeof metadata.timingRunId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(metadata.timingRunId) ? { timingRunId: metadata.timingRunId } : {}),
      ...(landing && metadata.timeoutMs ? { timeoutMs: metadata.timeoutMs } : {}),
      // The classification this controller used, so the runner never reclassifies by its own settings (#1043).
      browserByLaunch: byLaunch ?? carriedBrowserByLaunch() ?? readMachineSettingsFile(machineSettingsFile())?.gate?.browserByLaunch === true,
      ...(stages ? { stageMarker: `PULLBOARD_STAGE_${randomUUID().replaceAll('-', '')}` } : {}), waivers: projection,
      itemCheck: metadata.itemCheck === true, diagnostic: metadata.diagnostic === true, timing: metadata.timing === true,
      item: String(metadata.item ?? ''), kind: String(metadata.kind ?? ''), ...(runner.root ? { root: runner.root } : {}),
      ...(typeof metadata.main === 'string' && /^[0-9a-f]{40,64}$/u.test(metadata.main) ? { main: metadata.main } : {}) };
    let encodedSpec = Buffer.from(JSON.stringify(spec));
    // Optional cache bytes cannot make an otherwise valid runner request fail its existing bound.
    if (encodedSpec.length > 1024 ** 2 && spec.testResults) {
      spec.testResults.packet = null;
      encodedSpec = Buffer.from(JSON.stringify(spec));
    }
    if (encodedSpec.length > 1024 ** 2 && spec.testResults) {
      spec.testResults.inputKeys = [];
      encodedSpec = Buffer.from(JSON.stringify(spec));
    }
    if (encodedSpec.length > 1024 ** 2) throw new Refused('RUNNER_REQUEST_LIMIT', 'runner tooling request exceeds its safe transfer limit; keep this run local');
    const reusedRuntime = runtimeHeld(runner.host, tooling.sha256);
    const { command: remote, input: capsule } = remoteWorkerLaunch(runner, worker, tooling, runtime, '', spec.recovery, { reuse: reusedRuntime });
    // These are transport hang ceilings, independent of the command's execution budget.
    return { spec, runner, exchange, reusedRuntime, args: ['-T', '-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
      '-o', 'SendEnv=-*', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
      '--', runner.host, remote], root, source: selected, ...(trustedMode ? { rawOutputPath } : {}), directory, frame: Buffer.concat([capsule, Buffer.from(`${encodedSpec.length}\n`), encodedSpec, ...(artifact ? [artifact.bytes] : [])]), env: sshEnvironment(),
    cleanup() { rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
