/** @pullboard-test-input source-tree */
/** @pullboard-test-input docs-tree */
import { test } from 'node:test';
import { runLandingDocsRefresh } from './landing-docs-refresh.fixture.js';

test('a clean merge lands regenerated docs with refresh [B3,C7,V4]', () => runLandingDocsRefresh(false));
