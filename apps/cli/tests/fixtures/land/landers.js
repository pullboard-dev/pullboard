import assert from 'node:assert/strict';
import { runFixtureChild } from '../child.js';

/** The commands of every live process that runs the automatic lander for a path under `dir`; it lives in a fixture so journeys never launch a child themselves [C7]. */
export function landers(dir) {
  const listed = runFixtureChild('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.failure ?? listed.stderr);
  return listed.stdout.split('\n').filter(line => line.includes('/landing/automatic.js') && line.includes(dir));
}
