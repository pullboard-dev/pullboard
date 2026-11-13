/** @pullboard-test-input packages/sandbox/src/io/trusted/policy.js */
/** Deferred landing of a large affected selection, native policy refusal (C7). */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import * as store from '../../../../../packages/store/index.js';
import { settleLand } from '../../../tests/fixtures/land/settle.js';
import { makeDeferralFixtures } from '../../../tests/fixtures/gate/deferral.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { largeSelectionProject, deferredLandingLogs } = makeDeferralFixtures(e2e, store);

test('a pre-test native policy refusal is not reported as deferred files red [C7]', async t => {
const project = largeSelectionProject(t, 20, { inline: true });
const missing = join(project.box.dir, 'uncommitted-policy');
mkdirSync(missing);
project.box.git(missing, 'init', '-q', '-b', 'main');
const source = new URL('../../../../../packages/sandbox/src/io/trusted/policy.js', import.meta.url).href;
const launcher = `import { mainPolicy } from ${JSON.stringify(source)};\nimport { spawnSync } from 'node:child_process';\nconst files=process.argv.slice(2);\nif (!files.some(file=>file.includes('selected-'))) { const child=spawnSync(process.execPath,['--test','--test-reporter=tap',...files],{stdio:'inherit'}); process.exitCode=child.status??1; } else { try { mainPolicy(${JSON.stringify(missing)}); throw new Error('missing policy unexpectedly accepted'); } catch (error) { if (!error.code) throw error; console.log(JSON.stringify({version:1,error:{code:error.code,message:error.message,next:'restore the committed coordinator policy'}},null,2)); process.exitCode=1; } }\n`;
writeFileSync(join(project.box.repo, 'web/policy-launcher.mjs'), launcher);
const policy = join(project.box.repo, 'pullboard.json');
const config = JSON.parse(readFileSync(policy, 'utf8'));
writeFileSync(policy, JSON.stringify({ ...config, affectedTests: 'node web/policy-launcher.mjs' }, null, 2));
project.box.git(project.box.repo, 'add', '-A');
project.box.git(project.box.repo, 'commit', '-q', '-m', 'chore: exercise a native policy refusal before tests');
project.box.git(project.box.web, 'merge', '-q', '--ff-only', 'main');
const ready = await project.submitChange(2);
project.accept(ready.id, ready.receipt.commit);
rmSync(project.box.env.DEFER_MARKER, { force: true });
const result = project.box.run(project.box.repo, 'land', '--json');
assert.equal(result.code, 0, result.err + result.out);
const settled = await settleLand(project.box, JSON.parse(result.out));
const outcome = JSON.stringify(settled.landJob?.receipt ?? {});
assert.match(outcome, /NO_POLICY/u, 'the exact native refusal survives without a test-red wrapper');
assert.doesNotMatch(outcome + result.out + result.err, /\d+ file\(s\) red|the deferred affected tests are red/u);
assert.deepEqual(project.ran(), [], 'no selected test or invariant executes after the pre-test policy refusal');
assert.ok(deferredLandingLogs(project.box).some(log => /NO_POLICY/u.test(log.text)), 'the refusal output is retained for diagnosis');
});

