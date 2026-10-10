/** Caller-owned JUnit reporter used only by real timing integration fixtures [C7,V10]. */
import { relative, resolve } from 'node:path';

/** Escape actual event names before printing a caller-selected XML report. */
function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Emit only measured Node events; file summaries and cases remain separate measurements. */
export default async function* junit(events) {
  const files = new Map();
  const tests = [];
  for await (const event of events) {
    const data = event.data ?? {};
    if (event.type === 'test:summary' && data.file && Number.isFinite(data.duration_ms)) files.set(data.file, data.duration_ms);
    // Node 22.13 omits the ordinary-test type; later versions emit it explicitly.
    const ordinaryTest = data.details?.type === undefined || data.details.type === 'test';
    if (event.type === 'test:complete' && ordinaryTest && data.file && Number.isFinite(data.details?.duration_ms)) {
      if (data.line === 1 && data.column === 1 && resolve(data.name) === resolve(data.file)) continue;
      tests.push({file:data.file,name:data.name,durationMs:data.details.duration_ms,passed:data.details.passed===true});
    }
  }
  yield '<testsuites>\n';
  for (const [file, durationMs] of files) {
    yield `<testsuite file="${xml(relative(process.cwd(),file))}" time="${durationMs/1000}">\n`;
    for (const entry of tests.filter(value=>value.file===file)) {
      yield `<testcase name="${xml(entry.name)}" time="${entry.durationMs/1000}">${entry.passed?'':'<failure/>'}</testcase>\n`;
    }
    yield '</testsuite>\n';
  }
  yield '</testsuites>\n';
}
