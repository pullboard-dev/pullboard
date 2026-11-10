/** The handoff dispatcher's worker cap comes from the machine, never from the launching seat's environment [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentCapacity } from '../../../../index.js';
import { handoffWorkerCapacity } from '../../../../../resources/index.js';

test('a PULLBOARD_HANDOFF_WORKERS in the inherited environment does not cap the dispatcher; an explicit env does [C7]', () => {
  const previous = process.env.PULLBOARD_HANDOFF_WORKERS;
  process.env.PULLBOARD_HANDOFF_WORKERS = '1';
  try {
    assert.notEqual(currentCapacity(), 1, 'the inherited override is ignored');
    assert.equal(currentCapacity({ PULLBOARD_HANDOFF_WORKERS: '7' }), 7, 'an explicit environment still overrides');
    assert.equal(handoffWorkerCapacity({ env: {}, cores: 8 }), 4, 'the plain default is unchanged');
  } finally {
    if (previous === undefined) delete process.env.PULLBOARD_HANDOFF_WORKERS; else process.env.PULLBOARD_HANDOFF_WORKERS = previous;
  }
});
