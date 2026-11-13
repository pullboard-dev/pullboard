/** A coordinator lands named items at named proven commits as one batch on the product train, bisecting a static red [C7,#5559]. */
import { test } from 'node:test';

// CONTROLLER_ONLY: `land --items/--commit` is the batch engine's named landing; pull lands what is accepted through one job and refuses the flags with LAND_OFFER_ONLY [C7,#5559].
test('land --items lands two named proven items as one batch without a test gate [C7,#5559]', { skip: 'CONTROLLER_ONLY: deleted with #6807' }, () => {});

// CONTROLLER_ONLY: static-red bisection of a named batch belongs to the same engine [C7,#5559].
test('land --items bisects a static red out of the batch and lands the good items [C7,#5559]', { skip: 'CONTROLLER_ONLY: deleted with #6807' }, () => {});

// CONTROLLER_ONLY: the refusals are the named flags' own; a worker seat landing is refused COORDINATOR_ONLY in push.test.js [C7,#5559].
test('land --items refuses a non-coordinator, a missing id and a commit count that does not match [C7,#5559]', { skip: 'CONTROLLER_ONLY: deleted with #6807' }, () => {});
