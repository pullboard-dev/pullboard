import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixtureAdd } from '../testkit.js';

/** File light work at mid, then route it through the coordinator's diagnosis. */
export async function addDiagnosedLight(box, ...args) {
  const route = args.indexOf('--route');
  assert.equal(args[route + 1], 'light');
  const brief = args.includes('--brief-file') ? readFileSync(args[args.indexOf('--brief-file') + 1], 'utf8') : args[args.indexOf('--brief') + 1];
  args[route + 1] = 'mid';
  const added = await fixtureAdd(box.runLocal, box.repo, ...args);
  assert.equal(added.code, 0, added.err || added.out);
  const id = added.out.match(/^#(\d+)/m)?.[1];
  assert.ok(id, added.out);
  const diagnosis = (await box.runLocal(box.repo, 'fact', id, 'diagnosis', brief));
  assert.equal(diagnosis.code, 0, diagnosis.err || diagnosis.out);
  return added;
}
