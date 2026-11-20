/** Runs the runner derive job (packages/landing/src/io/derive.js main) on a clone of a fixture repo and returns the patch it prints [C7,#12053]. */
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { runFixtureChild } from '../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../gate/tests/fixtures/child.js';

const DERIVE = fileURLToPath(new URL('../../src/io/derive.js', import.meta.url));

/** The derive job run as its own process in a clone of root; resolves { status, stderr, patch } with the decoded LANDING_DERIVE_PATCH text. */
export function deriveJobPatch(root, tree) {
  const { root: twin } = privateFixtureFiles('landing-derive-tighten-');
  runFixtureGit(['clone', '-q', root, twin], { cwd: root });
  const ran = runFixtureChild(process.execPath, [DERIVE, '--tree', tree], { cwd: twin, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  rmSync(twin, { recursive: true, force: true });
  const line = String(ran.stdout ?? '').split('\n').find(entry => entry.startsWith('LANDING_DERIVE_PATCH='));
  return { status: ran.status, stderr: ran.stderr, patch: line ? Buffer.from(line.slice(21), 'base64').toString('utf8') : '' };
}
