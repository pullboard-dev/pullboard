/** The tool build command resolves its guard and timer paths through the gate cell's timerFiles [C7,#8623]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { timerFiles as auditTimerFiles } from '../../../../../packages/gate/index.js';
import { timerFiles } from '../../../src/io/tool/build.js';

test('cli.io-tool-build-timer-files.cli-tool-build-timer-files-clause-2: cli.tool-build.timer-files: clause 2: build.js resolves the same guard and timer paths as timerFiles for the same directory [C7,#8623]', () => {
  const common = privateFixtureFiles('pb-build-timer-files-').root;
  const found = timerFiles(common, true, { label: 'main audit', folder: 'main-audits' });
  const named = auditTimerFiles(found.directory);
  assert.equal(found.guard, named.guard);
  assert.equal(found.file, named.timer);
});
