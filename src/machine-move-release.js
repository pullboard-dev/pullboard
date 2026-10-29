import { IN_STATE } from './machine-shared.js';

/**
 * The `release` lifecycle move, declared in its own module so a change to one move's
 * guards never edits the file every other move shares; src/machine.js lists every move in order [M1,C7].
 *
 * @type {import('./machine.js').Move[]}
 */
export const MOVES = [
  {
    verb: 'release', from: ['open', 'claimed'], to: 'open', by: ['agent', 'coordinator'], refuse: 'NOT_YOURS',
    guards: ['joined', 'itemExists', IN_STATE, 'releaseOwnsWork', 'reviewReleaseExplained'], command: 'pullboard release <id>',
  },
];
