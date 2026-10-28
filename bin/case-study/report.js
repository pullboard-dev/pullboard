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
export function caseStudy({ root, boardPath, from, to, baseline = null, finished = false, planRoot = root, suiteLogTable = null }) {
  const structure = structureMetrics(root, { planRoot }), events = eventMetrics(boardPath, { from, to });
  const durations = { frozenCheck: frozenCheckMetrics(boardPath, { from, to }),
    historicalSuiteLogs: suiteLogTable ? suiteLogMetrics(suiteLogTable) : null };
  if (finished) requireFinishedStructure(structure);
  return { version: 1, release: '0.9.4', phase: finished ? 'structure-finished' : 'in-progress',
    baseline, observation: { window: { from, to, boundary: '(from,to]' }, structure, events, durations },
    qualification: 'This aggregate report does not authorize a release. A structure-finished label does not prove a full suite passed. Missing duration evidence remains unknown; no test count is used to infer a full run. The final release still requires the person\'s approval.' };
}

/** Present the data and its populations together; missing measurements stay explicit. */
export function caseStudyMarkdown(report) {
  const { observation } = report, structure = observation.structure;
  const baseline = report.baseline?.structure;
  const rows = [
    ['Import occurrences into later cells', baseline?.importCutsLeft, structure.importCutsLeft],
    ...Object.entries(structure.lints).map(([name, count]) => [`Cell lint: ${name}`, baseline?.lints?.[name], count]),
    ['Completed cell moves', baseline?.cells?.completed, structure.cells.completed],
  ];
  return `# Pullboard 0.9.4 case study\n\nStatus: ${report.phase}.\n\n`
    + `Observation: ${observation.window.from} to ${observation.window.to}, start excluded and end included.\n\n`
    + '| Structure metric | Starting capture | Observation |\n| --- | ---: | ---: |\n'
    + rows.map(([name, before, after]) => `| ${name} | ${before ?? 'unknown'} | ${after} |`).join('\n')
    + `\n\nThe starting plan and later regenerated plan retain their own source commits; planned cut totals are not substituted for measured imports left.\n\n`
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
