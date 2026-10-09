/** Preserve per-file and per-test timings from Node's real test events [C7,V10]. */
import { Transform } from 'node:stream';
import { relative, resolve } from 'node:path';

const files = new Map();
const completions = [];

/** Collect Node events without changing the TAP reporter sent to stdout. */
const reporter = new Transform({
  writableObjectMode: true,
  transform(event, encoding, callback) {
    const data = event.data ?? {};
    if (event.type === 'test:summary' && typeof data.file === 'string' && Number.isFinite(data.duration_ms)) {
      const path = relative(process.cwd(), resolve(data.file));
      files.set(path, { path, durationMs: data.duration_ms, summaryIndex: completions.length });
    }
    if (event.type === 'test:complete' && data.details?.type === 'test' && typeof data.file === 'string' && Number.isFinite(data.details.duration_ms)) {
      completions.push({
        file: relative(process.cwd(), resolve(data.file)), name: data.name,
        durationMs: data.details.duration_ms, passed: data.details.passed === true,
        line: data.line, column: data.column,
      });
    }
    callback();
  },
  flush(callback) {
    const wrappers = new Set();
    // A file that crashes before its summary still has a synthetic completion.
    for (const test of completions) {
      if (!files.has(test.file) && test.line === 1 && test.column === 1
          && typeof test.name === 'string' && resolve(test.name) === resolve(test.file)) {
        files.set(test.file, { path: test.file, durationMs: test.durationMs, summaryIndex: null });
      }
    }
    for (const file of files.values()) {
      // Node's synthetic file completion may precede the file's buffered events
      // or follow its summary. Remove just that boundary event, retaining even
      // real tests deliberately named after their file at line 1, column 1.
      const candidates = completions.flatMap((test, index) => test.file === file.path && test.line === 1 && test.column === 1
        && typeof test.name === 'string' && resolve(test.name) === resolve(file.path) ? [index] : []);
      const wrapper = file.summaryIndex === null ? candidates.at(-1)
        : candidates.find(index => index >= file.summaryIndex) ?? candidates[0];
      if (wrapper !== undefined) {
        wrappers.add(wrapper);
        file.durationMs = completions[wrapper].durationMs;
      }
    }
    this.push(JSON.stringify({
      files: [...files.values()].map(({ summaryIndex, ...file }) => file),
      tests: completions.filter((test, index) => !wrappers.has(index)).map(({ line, column, ...test }) => test),
    }));
    callback();
  },
});

export default reporter;
