/** One bounded diagnostic pair under the existing admission; the original gate remains authoritative [C7,H16]. */
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  availableParallelism,
  freemem,
  loadavg,
} from 'node:os';
import {
  closeSync,
  constants,
  copyFileSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
} from 'node:path';
import {
  headCommit,
  headTree,
  invalidateGitFacts,
  isClean,
  treeUntouched,
  tryGit,
  untracked,
} from "../../../git/index.js";
import {
  mainPolicy,
} from "../../../sandbox/index.js";
import { fileURLToPath } from 'node:url';
import { runProfiledShell } from "../../../gate/index.js";
import { runFrozenProof } from "../../../gate/index.js";
import {
  committedTest,
  tapTests,
} from "../../../gate/index.js";

/** Hash immutable bytes without retaining a potentially credential-bearing command in board data. */
function digest(value) { return createHash('sha256').update(value).digest('hex'); }

/** Hash large raw evidence in bounded chunks rather than loading another complete log into memory. */
function fileDigest(file) {
  const hash = createHash('sha256');
  const descriptor = openSync(file, 'r');
  const buffer = Buffer.alloc(65536);
  try {
    let length;
    while ((length = readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, length));
  } finally { closeSync(descriptor); }
  return hash.digest('hex');
}

/** Quote one literal selector argument, preserving its bytes without shell interpolation. */
function word(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }

/** Bind the source before the original run; uncertainty is recorded rather than silently retried. */
export function flakeSource(root, { commit, main, privateCheck = false } = {}) {
  invalidateGitFacts();
  const head = commit ?? headCommit(root);
  const tree = head && tryGit(root, ['rev-parse', '--verify', head + '^{tree}']);
  let trunk = main ?? null;
  if (!trunk) { try { trunk = mainPolicy(root).commit; } catch { /* Missing main prevents classification. */ } }
  return { head, tree: tree?.status === 0 ? tree.stdout.trim() : null, main: trunk, privateCheck,
    clean: privateCheck || treeUntouched(root),
    load: { average: loadavg(), cpus: availableParallelism(), freeMB: Math.floor(freemem() / 1048576) } };
}

/** Use only a known structured Node runner; arbitrary shell, Jest and Vitest commands are never replaced. */
function nodePrefix(command, config, root, pin) {
  const executable = '(?:node|/[^\\s\'";|&`$]+/node)';
  const own = new RegExp('^(' + executable + ')\\s+((?:\\./)?(?:packages/gate|apps/cli)/src/io/run/tests\\.js)(?:\\s|$)', 'u');
  const builtin = new RegExp('^(' + executable + ')\\s+--test(?:\\s|$)', 'u');
  const match = own.exec(command);
  if (match) return knownRunner(root, pin) ? match[1] + ' ' + match[2] : null;
  const native = builtin.exec(command);
  if (native) {
    const rest = command.slice(native[0].length);
    if (/[;&|`$()<>\r\n]/u.test(rest) || /(?:^|\s)--(?!test-reporter=tap(?:\s|$))\S+/u.test(rest)) return null;
    return native[1] + ' --test --test-reporter=tap';
  }
  if (new RegExp('^' + executable + '\\s', 'u').test(command)) return null;
  const configured = typeof config.affectedTests === 'string' ? own.exec(config.affectedTests) : null;
  return configured && knownRunner(root, pin) && config.affectedTests.trim() === configured[1] + ' ' + configured[2]
    ? config.affectedTests.trim() : null;
}

/** Recognize the bundled runner by committed bytes, never by a conventional filename in an end-user repo. */
function knownRunner(root, pin) {
  try {
    const bundled = tryGit(root, ['hash-object', '--no-filters', fileURLToPath(new URL("../../../../apps/cli/src/io/run/tests.js", import.meta.url))]);
    if (bundled.status !== 0) return false;
    return [...new Set([pin.head, pin.main].filter(Boolean))].every(commit => {
      if (!committedTest(root, commit, 'apps/cli/src/io/run/tests.js')) return false;
      const source = tryGit(root, ['rev-parse', '--verify', commit + ':apps/cli/src/io/run/tests.js']);
      return source.status === 0 && source.stdout === bundled.stdout;
    });
  } catch { return false; }
}

/** Copy the whole output/profile to unique durable evidence before any diagnostic executes. */
function saveReceipt(directory, id, label, run) {
  const file = join(directory, label + '.log');
  const source = run.log || run.logPath;
  if (source) copyFileSync(source, file, constants.COPYFILE_EXCL);
  else writeFileSync(file, run.output ?? '', { flag: 'wx', mode: 0o600 });
  let profileSha256 = null;
  if (run.profilePath) {
    copyFileSync(run.profilePath, join(directory, label + '.profile.json'), constants.COPYFILE_EXCL);
    profileSha256 = fileDigest(run.profilePath);
  }
  return { green: run.isGreen, sha256: fileDigest(file), bytes: statSync(file).size, artifact: 'flake-evidence/' + id + '/' + label + '.log', profileSha256 };
}

/**
 * What one probe proved for each selected target: true or false only where that target's own completion is present
 * once at the top level, and null otherwise. A batch run is trusted only when every selected target completed and
 * its exit agrees with them, so a crash after some targets passed proves none of them [#1899].
 */
function targetResults(run, root, names) {
  const results = new Map(names.map(name => [name, null]));
  if (run.executionSourceUnchanged === false) return results;
  const rows = tapTests(run.output ?? '', run.executionRoot ?? root).filter(row => row.type !== 'suite' && !row.skip);
  if (rows.length !== names.length || rows.some(row => row.indent !== 0 || !results.has(row.name)
    || ['subtestsFailed', 'cancelledByParent', 'testAborted'].includes(row.failureType))) return results;
  if (new Set(rows.map(row => row.name)).size !== rows.length) return results;
  if (rows.every(row => row.passed) !== run.isGreen) return results;
  for (const row of rows) results.set(row.name, row.passed);
  return results;
}

/** Run an exact-target private source comparison, preserving the trusted check's full receipt. */
function privateProbe(root, commit, command, lease, policyCommit, checkAtCommit, submitDiagnostic = false) {
  const item = { item_id: submitDiagnostic ? lease.proof.item : 0, item_commit: commit, item_claim_head: policyCommit, item_frozen: JSON.stringify({ check: command }) };
  const check = submitDiagnostic ? runFrozenProof(root, item, { gateLease: lease, diagnostic: true }, { checkAtCommit }) : checkAtCommit(root, item, { gateLease: lease });
  const output = check.outputPath ? readFileSync(check.outputPath, 'utf8') : '';
  return { ...(check.proofReceiptId ? { proofReceiptId: check.proofReceiptId } : {}), isGreen: check.state === 'pass', unverified: check.state === 'unverified', output, log: check.outputPath,
    executionRoot: check.executionRoot, executionSourceUnchanged: check.executionSourceUnchanged, profilePath: check.profilePath, profile: check.profile,
    executionRunner: check.executionRunner, executionLoad: check.executionLoad, executionMain: check.executionMain,
    executionSource: check.executionSource, environment: check.environment,
    rawOutputPath: check.rawOutputPath, rawOutputSha256: check.rawOutputSha256 };
}

/**
 * Why a remote admission cannot be judged, or null when its receipt names both facts a local run measures: the
 * execution host's load, and the pinned main this run used (#925). A missing fact is never guessed or replaced by a
 * local measurement.
 */
function remoteGap(run, pin, receipt = 'remote') {
  if (!run.executionLoad) return `The ${receipt} receipt does not carry the execution host's load; the red remains unclassified, never guessed.`;
  if (!pin.main || run.executionMain !== pin.main) return `The ${receipt} receipt does not name the pinned main this run used; the red remains unclassified, never guessed.`;
  return null;
}

/** Report only a bounded code when diagnostic work fails; never replace the original gate's red result. */
export async function observeNativeFailure(options) {
  const started = Date.now();
  try { await observeFailure(options); }
  catch (error) { diagnosticUnavailable(options, error, started); }
}

/** Record a bounded diagnostic failure without replacing the original run or exposing arbitrary exception text. */
export function diagnosticUnavailable(options, error, started = Date.now()) {
  const code = diagnosticCode(error);
  options.run.flakeDiagnostics = { ...(options.run.flakeDiagnostics ?? { observations: [] }), wallMs: Date.now() - started, error: code };
  const message = `failure diagnostics could not finish (${code}); the original result stays red; inspect the retained gate log and pullboard flakes\n`;
  try {
    if (typeof options.onError === 'function') options.onError({ code, message });
    else process.stderr.write(message);
  } catch { /* An unavailable diagnostic channel cannot change the original verdict. */ }
}

/** Retain an operational code without echoing arbitrary command text or credentials from an exception. */
function diagnosticCode(error) {
  return /^[A-Z][A-Z0-9_]{0,79}$/u.test(error?.code ?? '') ? error.code : 'FLAKE_DIAGNOSTIC_FAILED';
}

/**
 * Observe one red run: probe each file's failing cases together, once at the candidate and once at main, then
 * persist one typed result per case without changing its verdict. Batching keeps a 33-case red file to two probes
 * instead of 66 [#1899]; each case still keeps its own evidence directory, receipts and classification.
 */
async function observeFailure({ root, outputRoot = root, config, pin, run, command, lease, kind, record, recordBatch, recordRun, checkAtCommit }) {
  if (run.isGreen || !pin.head || !pin.tree) return;
  const started = Date.now();
  const observedAt = new Date().toISOString();
  const load = { average: loadavg(), cpus: availableParallelism(), freeMB: Math.floor(freemem() / 1048576) };
  const prefix = nodePrefix(command, config, root, pin);
  const parsed = tapTests(run.output ?? '', run.executionRoot ?? outputRoot).filter(row => !row.passed && row.type !== 'suite' && !['subtestsFailed', 'cancelledByParent', 'testAborted'].includes(row.failureType));
  const failures = parsed.length ? parsed : [{ file: null, name: null, indent: null }];
  const common = tryGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common.status !== 0) throw new Error('Cannot retain flake evidence without the board Git directory.');
  const evidence = join(common.stdout.trim(), 'pullboard', 'flake-evidence');
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  // Every case's original receipt is durable before any diagnostic executes.
  const cases = failures.map(failure => {
    const id = randomUUID();
    const directory = join(evidence, id); mkdirSync(directory, { mode: 0o700 });
    return { failure, id, directory, started: Date.now(), original: saveReceipt(directory, id, 'original', run),
      named: Boolean(failure.file && failure.name && committedTest(root, pin.head, failure.file)), paired: null, mainReceipt: null,
      classification: 'unclassified',
      reason: config.flakes?.rerun === true ? 'No supported structured Node test selector is available.' : 'Paired reruns are off for this board; the original red is retained.' };
  });
  invalidateGitFacts();
  const changed = run.executionSourceUnchanged === false || !pin.privateCheck && (headCommit(root) !== pin.head || headTree(root) !== pin.tree || !isClean(root) || untracked(root).length > 0);
  const groups = new Map();
  for (const entry of cases) {
    if (!pin.clean || changed) entry.reason = 'The source is dirty or changed; no unchanged-head diagnostic is claimed.';
    else if (lease?.runner && remoteGap(run, pin)) entry.reason = remoteGap(run, pin);
    else if (config.flakes?.rerun === true && prefix && entry.named && entry.failure.indent === 0) {
      const group = groups.get(entry.failure.file) ?? [];
      if (!group.some(other => other.failure.name === entry.failure.name)) group.push(entry);
      groups.set(entry.failure.file, group);
    } else if (config.flakes?.rerun === true && prefix) {
      // Name the missing fact, so a red that was never paired says which condition kept it unpaired.
      entry.reason = !entry.failure.file || !entry.failure.name ? 'The red names no test file and case in its output; no paired rerun is possible.'
        : !entry.named ? `${entry.failure.file} is not a committed test file at the pinned head ${pin.head.slice(0, 12)}; no paired rerun is possible.`
          : 'A nested failing case has no structured selector; no paired rerun is possible.';
    }
  }
  const pairedReceipts = [];
  for (const [file, group] of groups) {
    const pairedRun = probeFile(root, pin, lease, prefix, checkAtCommit, file, group);
    if (kind === 'submit' && pairedRun?.proofReceiptId) pairedReceipts.push(pairedRun.proofReceiptId);
  }
  const observations = [];
  const pending = [];
  for (const entry of cases) {
    const { failure, id, directory, named, original, paired, mainReceipt, classification, reason } = entry;
    const observation = { id, file: named ? failure.file : null, name: named ? failure.name : null, head: pin.head, tree: pin.tree, main: pin.main,
      kind, classification, reason, commandSha256: digest(command), at: observedAt, diagnosticMs: Date.now() - entry.started,
      // A remote run records its own host's load; without one, the observer's sample stands and the reason says so.
      load: lease?.runner && run.executionLoad ? run.executionLoad : load, original, paired, mainReceipt };
    writeFileSync(join(directory, 'observation.json'), JSON.stringify(observation, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const manifest = Object.fromEntries(readdirSync(directory).map(name => [name, fileDigest(join(directory, name))]));
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    observations.push({ id, classification, file: observation.file, name: observation.name, paired: paired !== null, recorded: false });
    pending.push({ observation, directory });
  }
  run.flakeDiagnostics = { wallMs: Date.now() - started, observations };
  await recordObservations(pending, observations, { record, recordBatch });
  // The typed repair link and raw stacks exist before automatic receipt-based quarantine chooses its owner.
  if (typeof recordRun === 'function') for (const id of pairedReceipts) await recordRun(id);
  run.flakeDiagnostics = { wallMs: Date.now() - started, observations };
}

/**
 * Run one candidate probe and one main probe for every failing case of one file, selecting the cases by exact name,
 * then classify each case from its own result in those two shared receipts.
 */
function probeFile(root, pin, lease, prefix, checkAtCommit, file, group) {
  const names = group.map(entry => entry.failure.name);
  const pattern = '^(?:' + names.map(name => name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|') + ')$';
  const selected = prefix + ' --test-name-pattern ' + word(pattern) + ' ' + word(file);
  const submitDiagnostic = lease?.proof?.kind === 'submit' && Boolean(lease.proof.diagnosticAdmission);
  const pairRun = pin.privateCheck || submitDiagnostic ? privateProbe(root, pin.head, selected, lease, pin.main ?? pin.head, checkAtCommit, submitDiagnostic)
    : runProfiledShell(root, selected, { gateLease: lease });
  // Every remote receipt a classification rests on carries both facts, the paired rerun's and main's included; a
  // probe that ran in a local private copy has no remote receipt to check.
  const gaps = [];
  const pairGap = pairRun.executionRunner ? remoteGap(pairRun, pin, 'paired remote') : null;
  if (pairGap) gaps.push(pairGap);
  const pairResults = pairRun.unverified || pairGap ? new Map() : targetResults(pairRun, root, names);
  let mainRun = null, mainResults = new Map();
  if (pin.main && pin.main !== pin.head && committedTest(root, pin.main, file)) {
    mainRun = privateProbe(root, pin.main, selected, lease, pin.main, checkAtCommit);
    const mainGap = mainRun.executionRunner ? remoteGap(mainRun, pin, 'main remote') : null;
    if (mainGap) gaps.push(mainGap);
    if (!mainRun.unverified && !mainGap) mainResults = targetResults(mainRun, root, names);
  }
  invalidateGitFacts();
  const moved = !pin.privateCheck && (headCommit(root) !== pin.head || headTree(root) !== pin.tree || !isClean(root) || untracked(root).length > 0);
  for (const entry of group) {
    entry.paired = saveReceipt(entry.directory, entry.id, 'paired', pairRun);
    if (mainRun) entry.mainReceipt = saveReceipt(entry.directory, entry.id, 'main', mainRun);
    const pairResult = pairResults.get(entry.failure.name) ?? null;
    const mainResult = pin.main === pin.head ? false : mainRun ? mainResults.get(entry.failure.name) ?? null : null;
    if (mainResult === true) { entry.classification = 'possible-regression'; entry.reason = 'The exact target passes on pinned main; this candidate failure is not a flake observation.'; }
    else if (pairResult === true && mainResult === false) { entry.classification = 'flake'; entry.reason = 'The red target passed its one paired rerun at the same pinned head; original red retained.'; }
    else if (pairResult === false) { entry.classification = 'stable-red'; entry.reason = 'The target remains red in its one paired rerun; original red retained.'; }
    else entry.reason = gaps[0] ?? 'A probe did not establish the exact target at its pinned source; it remains unclassified.';
    if (moved) { entry.classification = 'unclassified'; entry.reason = 'The source changed during diagnostics; no unchanged-head classification is claimed.'; }
  }
  return pairRun;
}

/**
 * Write every completed observation to the board after all probes finish: through one batch when the caller can
 * record several at once, else one at a time. A failure leaves the rest unrecorded and keeps each evidence manifest.
 */
async function recordObservations(pending, observations, { record, recordBatch }) {
  try {
    if (typeof recordBatch === 'function') {
      await recordBatch(pending.map(row => row.observation));
      for (const summary of observations) summary.recorded = true;
      return;
    }
    for (const [index, row] of pending.entries()) { await record(row.observation); observations[index].recorded = true; }
  } catch (error) {
    // The completed evidence manifests remain immutable; each unrecorded case gets its own addendum.
    for (const [index, row] of pending.entries()) {
      if (observations[index].recorded) continue;
      try { writeFileSync(join(row.directory, 'recording-error.addendum.json'), JSON.stringify({ code: diagnosticCode(error), originalRetained: true }) + '\n', { flag: 'wx', mode: 0o600 }); }
      catch { /* A failing disk cannot justify replacing the original verdict. */ }
    }
    throw error;
  }
}
