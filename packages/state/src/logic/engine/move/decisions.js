import { Refused } from '../../../../../kernel/light.js';

/** Treat a present correction array, including an empty one, as the new apply protocol marker. */
export function validate(args) {
  if (Object.hasOwn(args[0] ?? {}, 'refreezes') && !Array.isArray(args[0].refreezes)) {
    throw new Refused('ROW_DECISION', 'the spec correction payload is invalid; run pullboard spec apply again');
  }
}

