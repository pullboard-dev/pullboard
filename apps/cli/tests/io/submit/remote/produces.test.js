/** A foreground submit with a runner registered sends the cells analysis without an inventory and has the runner produce it [C7,#3662]. */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../../../fixtures/analysis.js';
import { remoteSubmitCells } from '../../../../src/io/submit/remote.js';
import { runFixtureGit } from '../../../fixtures/child.js';

test('clause 1: the real remoteSubmitCells path with a cold coordinator inventory ships no bundle and tells the runner to produce it, starting no process but git [C7]', async () => {
  const { root, item } = fixture('', '', 0);
  try {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.invalid' };
    const git = (...args) => runFixtureGit(args, { cwd: root, env });
    // The plan reaches the commit as a Git object, so main has a cells plan and no inventory is warm on the coordinator.
    const plan = runFixtureGit(['hash-object', '-w', '--stdin'], { cwd: root, env, input: '{}\\n' });
    git('update-index', '--add', '--cacheinfo', `100644,${plan},packages/codemap/data/plan/cells.json`);
    git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'plan');
    const main = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
    const stdout = Buffer.from('PULLBOARD_CELLS_RESULT ' + JSON.stringify({ acceptedMain: main, source: main, cells: [], existingCuts: [], problems: [], warnings: [], reorg: null }) + '\n');
    const seen = [];
    const lease = { runner: { host: 'stub' }, executionServices: { runners: { runOnRunnerAsync: async (_root, shell, options) => {
      seen.push({ shell, analysisArtifact: options.analysisArtifact });
      writeFileSync(options.rawOutputPath, stdout);
      return { executionRunner: 'stub', executionSource: { commit: main, tree }, rawOutputPath: options.rawOutputPath, stderr: '',
        privateCheck: { receipt: { requestSha256: options.privateCheck.sha256, sourceUnchanged: true,
          phases: { check: { offset: 0, code: 0, length: stdout.length, sha256: createHash('sha256').update(stdout).digest('hex') } } } } };
    } } } };
    const result = await remoteSubmitCells(root, main, main, item, lease, () => [], join(root, 'out'));
    assert.deepEqual(result.cells, []);
    assert.equal(seen.length, 1, 'the cells analysis went to the runner');
    assert.equal(seen[0].analysisArtifact, undefined, 'no inventory bundle is shipped from the coordinator');
    const payload = JSON.parse(Buffer.from(/"([A-Za-z0-9+/=]{40,})"/u.exec(seen[0].shell)[1], 'base64').toString('utf8'));
    assert.deepEqual(payload.produceInventory, [main], 'the runner is told to produce the accepted inventory itself');
    assert.equal(payload.inventory, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
