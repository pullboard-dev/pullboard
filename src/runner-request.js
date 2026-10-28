/** Build one pinned, credential-free runner request from the admitted source [C7]. */
import { configFromSource } from './config.js';
import { runnerSource } from './gate-policy-load.js';
import { validateRunner } from './gate-policy-load.js';
import { repoInfo } from './git.js';
import { secretsIn } from './hooks.js';
import { machineSettingsFile } from './machine-home.js';
import { carriedBrowserByLaunch } from './queue-settings.js';
import { readMachineSettingsFile } from './queue-settings.js';
import { Refused } from './refused.js';
import { anonymousOrigin } from './runner-history-pack.js';
import { candidateTags } from './runner-history-pack.js';
import { originAncestor } from './runner-history-pack.js';
import { validRunnerTrunk } from './runner-policy.js';
import { remoteWorkerCommand } from './runner-remote-tooling.js';
import { sshEnvironment } from './runner-remote-tooling.js';
import { trustedTooling } from './runner-remote-tooling.js';
import { protectHistory } from './runner-source-scan.js';
import { protectionAt } from './runner-source-scan.js';
import { sourceGit } from './runner-source-scan.js';
import { sourceObjects } from './runner-source-scan.js';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';

/** Prepare the pinned request before negotiating history; cleanup owns only its scratch directory. */
export async function requestFor(root, command, { runner, source, browser = false, byLaunch, pipefail = false, stages = false, waivers = [], metadata = {}, privateCheck, checkedSource, rawOutputPath }, { privateCheckEnvelope }) {
  runner = validateRunner(runner);
  const current = runnerSource(root);
  if (!current || (source && (current.commit !== source.commit || current.tree !== source.tree))) {
    throw new Refused('RUNNER_SOURCE_CHANGED', 'the queued source changed; restore the committed tree and retry the run');
  }
  const trustedMode = privateCheck ? privateCheckEnvelope(privateCheck) : null;
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
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-runner-send-'));
  try {
    // A caller that opted out of reuse (a test's own fixture runner) sends no exchange, so its worker runs every file.
    const reuse = process.env.PULLBOARD_TEST_REUSE !== '0';
    // Loaded on demand: read commands that import this module never pay for the key analyzer.
    const exchange = reuse ? await (await import('./test-action-transfer.js')).prepareTestResultExchange(root, command, selected.commit) : null;
    const { worker, tooling, runtime } = trustedTooling();
    const projection = metadata.landing === true && Array.isArray(waivers) ? waivers.filter(entry => ['file', 'name'].includes(entry?.kind) && typeof entry.test === 'string' && entry.test).map(({ kind, test }) => ({ kind, test })) : [];
    if (secretsIn([{ path: 'runner continuation', line: 1, text: JSON.stringify(projection) }]).length) throw new Refused('RUNNER_SECRET', 'the continuation projection contains a possible secret; keep this run local');
    const stage = /^[a-z][a-z0-9-]{0,63}$/u.test(metadata.testStage ?? '') ? metadata.testStage : metadata.landing ? 'land' : 'focused';
    const id = randomUUID();
    const spec = { version: 1, id, recovery: { version: 1, launchFence: 1, request: id, nonce: randomUUID(), tooling: tooling.sha256 }, repoId, ...(originBase ? { origin, originBase } : {}), runtime, tooling, tags, commit: selected.commit, tree: selected.tree, command, pipefail, slots: runner.slots,
      ...(reuse ? { testResults: { inputKeys: exchange?.inputKeys ?? [], packet: exchange?.packet ?? null, stage, origin: runner.host } } : {}),
      ...(trustedMode ? { trustedMode } : {}),
      ...(!trustedMode && metadata.trunk ? { trunk: { ...metadata.trunk } } : {}),
      browser: runner.browser, browserRequired: browser, guiRequired: metadata.gui === true, landing: metadata.landing === true, auditCoverage: metadata.auditCoverage === true,
      ...(typeof metadata.timingRunId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(metadata.timingRunId) ? { timingRunId: metadata.timingRunId } : {}),
      ...(metadata.landing === true && metadata.timeoutMs ? { timeoutMs: metadata.timeoutMs } : {}),
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
    const remote = remoteWorkerCommand(runner, worker, tooling, runtime, '', spec.recovery);
    // These are transport hang ceilings, independent of the command's execution budget.
    return { spec, runner, exchange, args: ['-T', '-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
      '-o', 'SendEnv=-*', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
      '--', runner.host, remote], root, source: selected, ...(trustedMode ? { rawOutputPath } : {}), directory, frame: Buffer.concat([Buffer.from(`${encodedSpec.length}\n`), encodedSpec]), env: sshEnvironment(),
    cleanup() { rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
