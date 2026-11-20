/** Generate reproducible aggregate evidence without publishing private board history [C7,D3]. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { eventMetrics } from './events.js';
import { structureMetrics, requireFinishedStructure } from './structure.js';
import { frozenCheckMetrics, suiteLogMetrics } from './durations.js';

/** Bind the exact retained starting capture; it must never become today's rolling baseline. */
export function readCaseStudyBaseline(file) {
  const bytes = readFileSync(file), value = JSON.parse(bytes);
  if (value.version !== 1 || !value.source || !value.structure || !value.window || !value.events) {
    throw new Error('restore a complete version-1 case-study baseline with its source, window, structure and events');
  }
  return { ...value, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Read real event and lint sources for one explicitly bounded observation. */
export function caseStudy({ root, boardPath, from, to, baseline = null, finished = false, suiteLogTable = null }) {
  const structure = structureMetrics(root), events = eventMetrics(boardPath, { from, to });
  const durations = { frozenCheck: frozenCheckMetrics(boardPath, { from, to }),
    historicalSuiteLogs: suiteLogTable ? suiteLogMetrics(suiteLogTable) : null };
  if (finished) requireFinishedStructure(structure);
  return { version: 1, release: '0.9.4', phase: finished ? 'structure-finished' : 'in-progress',
    baseline, observation: { window: { from, to, boundary: '(from,to]' }, structure, events, durations },
    qualification: 'Windows contain different workloads, plans and agent populations; these observations do not establish a causal speedup. This aggregate report does not authorize a release. A structure-finished label does not prove a full suite passed. Missing duration evidence remains unknown; no test count is used to infer a full run. The final release still requires the person\'s approval.' };
}

/** Present the data and its populations together; missing measurements stay explicit. */
export function caseStudyMarkdown(report) {
  const { observation } = report, structure = observation.structure;
  const baseline = report.baseline?.structure;
  const rows = [
    ...Object.entries(structure.lints).map(([name, count]) => [`Cell lint: ${name}`, baseline?.lints?.[name], count]),
    ['Cells with a front door', baseline?.cells?.completed, structure.cells.completed],
  ];
  const earlier = report.baseline?.events, current = observation.events;
  /** Keep sample sizes beside durations so unavailable history cannot look like zero wait. */
  const duration = metric => metric?.n ? `${(metric.medianMs / 60_000).toFixed(2)} min (n=${metric.n}, unknown=${metric.unknown})` : 'unknown (n=0)';
  const flow = [
    ['Landings per hour', earlier?.landings.perHour ?? 'unknown', current.landings.perHour],
    ['Landing observations', earlier?.landings.n ?? 'unknown', current.landings.n],
    ['Claim to landing, median', duration(earlier?.claimToLand), duration(current.claimToLand)],
    ['Acceptance to landing, median', duration(earlier?.acceptToLand), duration(current.acceptToLand)],
    ['Submits per submitted item', earlier?.submits.perSubmittedItem ?? 'unknown', current.submits.perSubmittedItem ?? 'unknown'],
    ['Conflict reopens per landing', earlier?.conflictReopens.perLanding ?? 'unknown', current.conflictReopens.perLanding ?? 'unknown'],
    ['Frozen check, median', duration(report.baseline?.durations?.frozenCheck), duration(observation.durations.frozenCheck)],
  ];
  return `# Pullboard 0.9.4 case study\n\nStatus: ${report.phase}.\n\n`
    + `Observation: ${observation.window.from} to ${observation.window.to}, start excluded and end included.\n\n`
    + '| Structure metric | Starting capture | Observation |\n| --- | ---: | ---: |\n'
    + rows.map(([name, before, after]) => `| ${name} | ${before ?? 'unknown'} | ${after} |`).join('\n')
    + '\n\n| Event metric | Starting window | Observation window |\n| --- | ---: | ---: |\n'
    + flow.map(([name, before, after]) => `| ${name} | ${before} | ${after} |`).join('\n')
    + `\n\nStarting event window: ${report.baseline?.window?.from ?? 'unknown'} to ${report.baseline?.window?.to ?? 'unknown'}. Starting source: ${report.baseline?.source?.head ?? 'unknown'}. Observation source: ${structure.source?.head ?? 'unknown'}.\n`
    + 'Event measurements, including their populations and missing evidence:\n\n```json\n'
    + JSON.stringify({ ...observation.events, durationEvidence: observation.durations }, null, 2) + '\n```\n\n'
    + structure.qualification + '\n\n' + report.qualification + '\n';
}

/** Write a requested companion pair only when the owner explicitly selects its output directory. */
export function writeCaseStudy(report, directory) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, '0.9.4.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(directory, '0.9.4.md'), caseStudyMarkdown(report));
}
