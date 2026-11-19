/** changelogBetween returns the CHANGELOG.md sections newer than one version up to another [C7,#1303]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changelogBetween } from '../../src/logic/changelog-between.js';

const TEXT = [
  '# Changelog', '', 'Notable changes.', '',
  '## [0.9.10] - 2026-12-01', '', '### Added', '', '- ten', '',
  '## [0.9.4] - 2026-11-15', '', '### Added', '', '- four', '',
  '## [0.9.3] - 2026-10-26', '', '### Fixed', '', '- three', '',
  '## [0.9.2] - 2026-10-21', '', '- two', '',
].join('\n');

test('cli.logic-changelog-between.newer-than-from-up-to-to: clause 1: changelogBetween returns the sections newer than from up to and including to, in file order [C7]', () => {
  const between = changelogBetween(TEXT, '0.9.2', '0.9.4');
  assert.equal(between, '## [0.9.4] - 2026-11-15\n\n### Added\n\n- four\n\n## [0.9.3] - 2026-10-26\n\n### Fixed\n\n- three');
  assert.ok(!between.includes('0.9.2') && !between.includes('0.9.10'));
});

test('cli.logic-changelog-between.compares-numbers-not-text: clause 1: changelogBetween orders 0.9.10 after 0.9.4 by number [C7]', () => {
  assert.equal(changelogBetween(TEXT, '0.9.4', '0.9.10'), '## [0.9.10] - 2026-12-01\n\n### Added\n\n- ten');
});

test('cli.logic-changelog-between.empty-when-from-equals-to: clause 1: changelogBetween returns an empty result when from equals to [C7]', () => {
  assert.equal(changelogBetween(TEXT, '0.9.3', '0.9.3'), '');
  assert.equal(changelogBetween(TEXT, '0.9.10', '0.9.10'), '');
});
