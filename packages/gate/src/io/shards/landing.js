/**
 * A landing gate's rerun files fanned out over runner slots by the submit proof's batch queue (proveBatches, at most
 * three lanes, sized by recorded runtime), merged back into the one run the landing gate records [C7].
 *
 * Why: a runners-only coordinator sends its landing gate to one runner, which ran every selected file serially; #3489's
 * gate could not finish inside the 10-minute stop on 9 Nov, while a submit gate of the same files ran as three shards.
 */
import { freeRunnerSlots } from './proof.js';
import { proveBatches } from './proof.js';
import { shardSlotOptions } from './proof.js';
import { withGateSlot } from '../slot.js';
import { readFileTimes } from '../test/value/timing.js';
import { COLLECTION_REPORT_PREFIX } from '../../logic/collection/report.js';
import { formatCollectionReport } from '../../logic/collection/report.js';

/**
 * Whether a landing gate's command is exactly its rerun files under the focused runner, so its files can run as shards
 * with the same receipt: the command the receipt names is `filesCommand(files)` itself.
 *
 * @param {string} command - The gate command the landing runs.
 * @param {{ files?: string[], filesCommand?: (files: string[]) => string } | null | undefined} shard
 * @returns {boolean}
 */
export function landingShardable(command, shard) {
  if (!shard || !Array.isArray(shard.files) || shard.files.length < 2 || typeof shard.filesCommand !== 'function') return false;
  try { return shard.filesCommand(shard.files) === command; } catch { return false; }
}

/**
 * The execute step of runProfiledShardsAsync for a landing gate on a runner lease: the gate's own lease is the first
 * lane, and each further lane takes its own runner slot under the gate's slot options. Every batch runs under the
 * plan's remote options, so its collection, stages, waivers and timing run id are the gate's; the merged run carries
 * each shard, and the gate writes the only receipt for the whole command, as a submit proof does.
 *
 * @param {string} root
 * @param {{ files: string[], filesCommand: (files: string[]) => string }} shard
 * @param {object} slotOptions - The options the landing gate's own slot was taken with.
 * @param {{ say?: (line: string) => void, settings?: () => any, freeSlots?: () => number, takeSlot?: Function }} [ports] - settings reads the
 *   machine settings (config's loadMachineSettings) for the registered runners; freeSlots and takeSlot are test stand-ins.
 * @returns {(execution: object) => Promise<object>}
 */
export function landingShardExecution(root, shard, slotOptions, ports = {}) {
  return execution => {
    const runners = execution.gateLease.executionServices.runners;
    const wrap = planWrapper(execution);
    const wrapped = files => wrap(shard.filesCommand(files));
    const shardOptions = lease => ({ ...execution.remoteOptions, runner: lease.runner, source: lease.source,
      runnerWaitDeadline: lease.runnerWaitDeadline, runnerStartupMs: lease.runnerStartupMs, browser: lease.browser, byLaunch: lease.browserByLaunch,
      metadata: { ...execution.remoteOptions.metadata, ...(lease.runMetadata ?? {}), timingRunId: execution.remoteOptions.metadata.timingRunId } });
    const takeSlot = ports.takeSlot ?? ((lane, { closed }) => withGateSlot(root, lease => lane(files => runners.runOnRunnerAsync(root, wrapped(files), shardOptions(lease))),
      shardSlotOptions(slotOptions, { closed })));
    const freeSlots = ports.freeSlots ? ports.freeSlots()
      : freeRunnerSlots(undefined, { browser: slotOptions.browser === true, gui: slotOptions.gui === true, runners: ports.settings ? runners.effectiveRunners?.(ports.settings()) ?? null : null });
    return proveBatches(root, execution, { files: shard.files, filesCommand: wrapped, takeSlot, freeSlots, times: readFileTimes(root), say: ports.say })
      .then(run => ({ ...run, output: combineCollectionReports(String(run.output ?? '')) }));
  };
}

/**
 * The plan's own wrapping of a files command: a landing that collects every failure runs its command inside the
 * collection environment (remoteCommand), and each shard must run inside the same one or it stops at its first red
 * and reports no collection.
 *
 * @param {{ command: string, remoteCommand?: string }} execution
 * @returns {(command: string) => string}
 */
export function planWrapper(execution) {
  const whole = execution.remoteCommand ?? execution.command;
  // The wrapper's prefix may hold the command's text by chance (an x inside export); the command itself comes last.
  const at = whole.lastIndexOf(execution.command);
  if (at < 0 || whole === execution.command) return command => command;
  const before = whole.slice(0, at), after = whole.slice(at + execution.command.length);
  return command => `${before}${command}${after}`;
}

/**
 * Join the suite collection reports the shards of one run printed under the same collection id into the one report
 * the whole run makes: every planned file, every completed file, complete and cleaned up only when every shard was.
 * Why: the gate reads exactly one suite report per collection id, so a sharded run with one report per shard read as
 * uncollected and its red could never be accounted [C7].
 *
 * @param {string} output - The merged run's output.
 * @returns {string}
 */
export function combineCollectionReports(output) {
  const groups = new Map();
  const kept = [];
  for (const line of output.split('\n')) {
    if (!line.startsWith(COLLECTION_REPORT_PREFIX)) { kept.push(line); continue; }
    let value;
    try { value = JSON.parse(line.slice(COLLECTION_REPORT_PREFIX.length)); } catch { kept.push(line); continue; }
    if (value?.scope !== 'suite' || value.shard !== null || typeof value.id !== 'string') { kept.push(line); continue; }
    if (!groups.has(value.id)) groups.set(value.id, []);
    groups.get(value.id).push(value);
  }
  if (![...groups.values()].some(reports => reports.length > 1)) return output;
  const lines = [...kept];
  for (const [id, reports] of groups) {
    const planned = [...new Set(reports.flatMap(report => report.plannedFiles ?? []))].sort();
    const completed = [...new Set(reports.flatMap(report => report.completedFiles ?? []))].sort();
    lines.push(formatCollectionReport({ id, scope: 'suite', shard: null, full: reports.every(report => report.full === true), plannedFiles: planned, completedFiles: completed,
      complete: reports.every(report => report.complete === true), cleanupVerified: reports.every(report => report.cleanupVerified === true) }).trimEnd());
  }
  return lines.join('\n');
}
