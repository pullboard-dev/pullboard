/** @pullboard-test-input source-tree */
/** @pullboard-test-input docs-tree */
import { test } from 'node:test';
import { runLandingDocsRefresh } from '../../../tests/fixtures/landing/refresh.js';

test('a clean merge refuses stale docs without refresh [B3,C7,V4]', () => runLandingDocsRefresh(true));
