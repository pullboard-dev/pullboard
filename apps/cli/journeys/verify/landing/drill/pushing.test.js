/** @pullboard-test-loads apps/cli/tests/fixtures/landing/loader.js */
/** Kill the landing worker during pushing, retaining real Git and SQLite state for the next native accept [B35]. */
import { test } from 'node:test';
import { getItem } from '../../../../../../packages/store/index.js';
import { landingBatches } from '../../../../../../packages/store/index.js';
import { drillCase } from '../../../../tests/fixtures/landing/drill.js';

test('killing the landing worker during pushing lets the next accept land both items without manual recovery [B35]', drillCase('pushing', { getItem, landingBatches }));
