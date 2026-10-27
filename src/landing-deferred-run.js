/** Keep deferred landing execution, native refusals and durable diagnostics under one admitted lease [C7]. */
import {
  runProfiledShell,
  withLandingGateSlot,
  refuseSandboxBlocked,
} from './gate.js';
import { testsNeedBrowser } from './browser-admission.js';
import { testsNeedGui } from './gui-admission.js';
import { browserFreeChecksEnabled } from './settings.js';
import { Refused } from './refused.js';

/** Quote one selected path as a single shell argument. */
function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

/** Read bounded whole or pretty native documents without mistaking surrounding diagnostics for JSON. */
function nativeDocuments(output) {
  const values = [];
  if (output.length <= 64 * 1024) {
    try { values.push(JSON.parse(output.trim())); return values; } catch { /* Native stderr warnings may surround the document. */ }
  }
  let pending = '';
  for (const line of output.split('\n')) {
    if (!pending && !/^\s*\{/u.test(line)) continue;
    pending += line + '\n';
    if (pending.length > 64 * 1024) { pending = ''; continue; }
    try { values.push(JSON.parse(pending)); pending = ''; } catch { /* A pretty document is incomplete until its closing line. */ }
  }
  return values;
}

/** Recognize a native JSON refusal only when the launcher produced no test account. */
function nativeRefusal(output) {
  if (/^(?:TAP version |(?:not )?ok \d+\b|\s*test at |\s*✖ )/mu.test(output)) return null;
  for (const value of nativeDocuments(output)) {
    const error = value?.version === 1 ? value.error : null;
    if (!error || !/^[A-Z][A-Z0-9_]+$/u.test(error.code ?? '') || typeof error.message !== 'string' || !error.message.trim()) continue;
    const prefix = `[${error.code}] `;
    return new Refused(error.code, error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message, error.next);
  }
  return null;
}

/** Run the actual deferred command, persisting its log before distinguishing tests from a launch refusal. */
export async function runDeferredAffectedTests(root, config, files, { directory, onWait } = {}) {
  const browser = !browserFreeChecksEnabled() || await testsNeedBrowser(root, files);
  const run = await withLandingGateSlot(root, lease => runProfiledShell(root,
    `${config.affectedTests} ${files.map(quote).join(' ')}`, { waitMs: lease.waitMs, gateLease: lease,
      stages: true, landing: true, persistLog: true, artifactDirectory: directory, artifactPrefix: 'deferred', timeoutMs: config.landing?.timeoutMs }),
  { agent: 'coordinator', kind: 'gate', landing: true, browser, gui: testsNeedGui(root, files), onWait });
  refuseSandboxBlocked(run);
  if (run.timedOut) throw new Refused('LAND_GATE_TIMEOUT', `the deferred landing command timed out; no file is blamed; inspect ${run.logPath}`);
  if (!run.isGreen) {
    const refused = run.profile?.tests?.length ? null : nativeRefusal(run.output ?? '');
    if (refused) throw refused;
  }
  return run;
}
