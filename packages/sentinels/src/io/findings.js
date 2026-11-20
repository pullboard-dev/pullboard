import { observeDirtyRunnerTooling } from '../../../runners/index.js';
import { dispatchHealth } from "./dispatch.js";
import { rejectedWorkReturns } from "./returns.js";
/** Snapshot health without keeping a board write lock across Git's merge checks [A6]. */
import { openBoardReadOnly } from "../../../store/index.js";
import { readBoardSnapshot } from "../../../store/index.js";
import { healthReport } from "../../../health/index.js";
import { unaccountedRedFindings } from "../../../health/index.js";
import { healthSentinelEnabled } from "../../../config/index.js";
import { loadMachineSettings } from "../../../config/index.js";
import { Refused } from "../../../kernel/index.js";
import { agentCpuFindings } from "./cpu.js";
import { hostname } from "node:os";
import { scratchMemoryFindings } from "../logic/memory.js";
import {
  healthFindingIdentity,
  normalizedHealthFindings,
} from "../../../store/index.js";
import { fileSystemAdapter } from '../../../fs/index.js';

/** The one file-system adapter this file reads through [C7]. */
const fs = fileSystemAdapter();

/**
 * A missing board or an explicitly disabled sentinel has no observation to publish. `gateDrives(db, now)` adds the
 * findings for gate drives that renew their lease with no step (the drive cell's own detector, which this cell may
 * not import); the CLI's sentinel command passes it, so the production loop shouts each one as Stuck [C7].
 * `memory()` reads process sizes and swap for the scratch-memory warning; it is off unless the sentinel command passes it [C7].
 */
export function scanHealthSentinel(file, { root, config, now, cpu = agentCpuFindings, tooling = observeDirtyRunnerTooling, gateDrives = () => [], memory = () => null, returnRejected = false }) {
  if (!healthSentinelEnabled(config) || !fs.exists(file)) return null;
  const db = openBoardReadOnly(file);
  try {
    db.exec('BEGIN');
    const observedRevision = db.prepare('SELECT COALESCE(MAX(event_id), 0) AS revision FROM event').get().revision;
    const report = healthReport({ db, root, config, now, dispatchHealth, machineSettings: loadMachineSettings() });
    const { dispatch } = dispatchHealth(readBoardSnapshot(db, { now: () => now }), config);
    const last = db.prepare("SELECT event_detail FROM event WHERE event_kind = 'health-scan' ORDER BY event_id DESC LIMIT 1").get();
    report.stuck.push(...tooling(now, last ? JSON.parse(last.event_detail).active : []));
    report.stuck.push(...gateDrives(db, now));
    report.stuck.push(...unaccountedRedFindings(db, now));
    const priorActive = last ? JSON.parse(last.event_detail).active : [];
    report.stuck.push(...scratchMemoryFindings({ ...(memory() ?? {}), host: hostname(), now, since: key => priorActive.find(finding => finding.key === key)?.since ?? null }));
    const processes = cpu(db);
    report.stuck.push(...(processes ?? (last ? JSON.parse(last.event_detail).active : []).filter(finding => finding.cause === 'AGENT_CPU').map(finding => ({ ...finding, owner: { who: finding.owner } }))));
    const before = (last ? JSON.parse(last.event_detail).active : []).map(healthFindingIdentity).sort();
    const after = normalizedHealthFindings(report.stuck).map(healthFindingIdentity).sort();
    const priorDispatch = last ? JSON.parse(last.event_detail).dispatch ?? [] : [];
    const dispatchChanged = JSON.stringify(priorDispatch) !== JSON.stringify(dispatch);
    const pendingReturns = returnRejected ? rejectedWorkReturns({ db, clock: { now: () => now } }, report.stuck) : [];
    db.exec('COMMIT');
    if (!pendingReturns.length && !dispatchChanged && JSON.stringify(before) === JSON.stringify(after) && !(last && (JSON.parse(last.event_detail).pendingCpu?.length || JSON.parse(last.event_detail).pendingDispatch?.length))) return null;
    return { observedRevision, findings: report.stuck, ...(returnRejected ? { returnRejected: true } : {}), ...(dispatchChanged || priorDispatch.length ? { dispatch } : {}) };
  } finally { db.close(); }
}

/** Read the indexed last recorded findings and their recording time without running a health scan. */
export function recordedHealthFindings(board) {
  const last = board.db.prepare("SELECT event_at, event_detail FROM event WHERE event_kind = 'health-scan' ORDER BY event_id DESC LIMIT 1").get();
  if (!last) return { recordedAt: null, findings: [] };
  const detail = JSON.parse(last.event_detail);
  if (!Array.isArray(detail.active) || !Number.isFinite(Date.parse(last.event_at))) {
    throw new Refused('HEALTH_FINDINGS', 'the recorded health findings are invalid; run pullboard doctor before scheduling another sentinel run');
  }
  return { recordedAt: last.event_at, findings: detail.active };
}
