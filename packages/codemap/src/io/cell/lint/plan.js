/** Plan the baseline's own literal tool-data inventory before recording its falling allowances [C7,CD64]. */
import { cellLintBaseline } from './ratchet.js';
import { cellLintFiles } from './store.js';
import { Refused } from '../../../../../kernel/index.js';

/** Remove only the validated previous generation's stray/unreachable rows; all other files and metrics stay literal. */
function withoutPrevious(report, previous) {
  const metrics = Object.fromEntries(Object.entries(report.metrics).map(([metric, row]) => {
    const findings = ['strays', 'unreachable'].includes(metric) ? row.findings.filter(finding => !previous.has(finding.key)) : [...row.findings];
    return [metric, { count: findings.reduce((sum, finding) => sum + finding.count, 0), findings }];
  }));
  return { ...report, metrics };
}

/** Add the exact anticipated JSON paths using the ordinary bin/ stray and production-file reach rules. */
function withMetadata(report, paths) {
  const metrics = { ...report.metrics };
  for (const metric of ['strays', 'unreachable']) {
    const findings = [...metrics[metric].findings];
    for (const key of paths) if (!findings.some(row => row.key === key)) findings.push({ key, count: 1, detail: 'literal planned tool metadata' });
    findings.sort((a, b) => a.key.localeCompare(b.key));
    metrics[metric] = { count: findings.reduce((sum, row) => sum + row.count, 0), findings };
  }
  return { ...report, metrics };
}

/** Solve only the finite shard-path inventory; all generated files stay under 500 lines and final actual measurement must match. */
export function planCellLintBaseline(report, previous = new Map()) {
  const source = withoutPrevious(report, previous), seen = new Set();
  let paths = [...cellLintFiles(cellLintBaseline(source)).keys()].sort();
  for (let step = 0; step < 16; step++) {
    const planned = withMetadata(source, paths), baseline = cellLintBaseline(planned);
    const next = [...cellLintFiles(baseline).keys()].sort(), signature = JSON.stringify(next);
    if (signature === JSON.stringify(paths)) return { baseline, report: planned, paths };
    if (seen.has(signature)) break;
    seen.add(signature);
    paths = next;
  }
  throw new Refused('CELL_BASELINE', 'bounded metadata inventory did not stabilize; inspect shard planning before writing');
}
