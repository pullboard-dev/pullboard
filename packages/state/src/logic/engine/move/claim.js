import { randomUUID } from 'node:crypto';
import { lineSettings } from '../../../../index.js';
import { prepareFreeze } from './freeze.js';
import { restoreFreeze } from './freeze.js';

/** Mark a claim made under line capacity settings, so replicas apply the same capacity rule [H16]. */
export function prepareBefore(board, values) {
  const settings = lineSettings(board);
  const markers = {
    ...(settings.returnRejectedWork === true ? { returnRejectedWork: true } : {}),
    ...(['wipPerReviewer', 'takeoverMinutes'].some(key => typeof settings[key] === 'number') ? { lineCapacity: true } : {}),
    ...(values[1]?.reworkRoutingPolicy ? { reworkSameFamily: true } : {}),
  };
  if (values[1]?.exitRules?.enabled && values[1].exitClaimKey === undefined) values[1] = { ...values[1], exitClaimKey: randomUUID() };
  if (Object.keys(markers).length) values[1] = { ...values[1], ...markers };
}

/** Seal the frozen criterion in place of the caller's freeze callback [H3]. */
export function prepareAfter(board, values, context) { prepareFreeze(board, 'claim', values, context); }

/** Give the replayed claim back a freeze that returns the sealed criterion [H3]. */
export function replayArgs(board, args) { restoreFreeze(args); }
