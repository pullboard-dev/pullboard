/** Install a private observer around actual fixture-worker Git children [C7]. */
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Observe the first completed worker job; callers await its real terminal result before reading. */
export function installWorkerGitWitness(directory) {
  const trace = join(directory, 'worker-git-trace.jsonl');
  const preload = join(directory, 'worker-git-observer.mjs');
  const source = readFileSync(new URL('../../../../../../packages/git/tests/fixtures/observer.mjs', import.meta.url), 'utf8');
  const placeholder = "'__FIXTURE_GIT_TRACE_PATH__'";
  if (source.split(placeholder).length !== 2) throw new Error('the private observer needs one exact trace placeholder');
  writeFileSync(preload, source.replace(placeholder, JSON.stringify(trace)), { mode: 0o600 });
  return { nodeOptions: '--import=' + pathToFileURL(preload).href,
    /** Read actual launch/close rows, retaining a single job instead of blending repeated workers. */
    rows() {
      const rows = readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const worker = rows[0]?.worker;
      return rows.filter(row => row.worker === worker);
    } };
}
