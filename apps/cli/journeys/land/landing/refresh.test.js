/** @pullboard-test-input docs-tree */
import { test } from 'node:test';
import { runLandingDocsRefresh } from '../../../tests/fixtures/landing/refresh.js';

test('a clean merge lands regenerated docs with refresh [B3,C7,V4]', () => runLandingDocsRefresh(false));
