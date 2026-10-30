/** Real native source advancement remains explicitly accounted under the newly landed policy [Q1,B3]. */
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { sourceAdvancePolicyCase } from './landing-queue-fixture.js';
const helpers = createE2eHelpers();
after(helpers.cleanup);
test('actual source-advance gates remain bound to their landed policy [Q1,B3]', { timeout: 240_000 }, async t => sourceAdvancePolicyCase(t, helpers));
