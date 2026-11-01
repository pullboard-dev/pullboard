/** Record Node's actual per-file TAP outcomes alongside the public reporter [C7]. */
import { createHash } from 'node:crypto';
import {
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  relative,
  sep,
} from 'node:path';
import { tap } from 'node:test/reporters';

/** Consume the real event stream without adding output to the caller's selected reporter. */
export default async function* recordActionTap(events) {
  const directory = process.env.PULLBOARD_TEST_ACTIONS;
  const plan = JSON.parse(readFileSync(join(directory, 'keys.json'), 'utf8'));
  const reports = new Map();
  let publishing = null;
  for await (const event of events) {
    const file = event.data?.file;
    // Node publishes a file's buffered outcomes and then its root summary in order. That root has no source loc;
    // its summary therefore has no file either. Never attribute the final aggregate summary after this boundary.
    const summary = event.type === 'test:summary';
    const path = file ? relative(plan.root, file).split(sep).join('/') : summary ? publishing : null;
    if (summary) publishing = null;
    if (!plan.files[path]) continue;
    if (!reports.has(path)) reports.set(path, { lines: [], counts: null, observedTests: 0 });
    const report = reports.get(path);
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      publishing = path;
      if (event.data.details?.type !== 'suite') report.observedTests += 1;
      // Node supplies the escaping, nesting and numbering used by the public TAP reporter.
      for await (const chunk of tap([event])) {
        for (const line of chunk.split('\n')) if (/^\s*(?:not )?ok \d+(?: |$)/u.test(line)) report.lines.push(line);
      }
    }
    if (event.type === 'test:summary' && event.data.success) report.counts = event.data.counts;
  }
  for (const [file, report] of reports) {
    // A helper can register tests at another source location. Without every outcome's attribution, run fresh.
    if (!report.counts || report.observedTests !== report.counts.tests) continue;
    const name = createHash('sha256').update(JSON.stringify(file)).digest('hex');
    const path = join(directory, `${name}.tap.json`);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(report), { mode: 0o600 });
    renameSync(temporary, path);
  }
}
