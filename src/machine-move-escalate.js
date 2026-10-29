import { IN_STATE } from './machine-shared.js';

/**
 * The `escalate` lifecycle move, declared in its own module so a change to one move's
 * guards never edits the file every other move shares; src/machine.js lists every move in order [M1,C7].
 *
 * @type {import('./machine.js').Move[]}
 */
export const MOVES = [
  {
    verb: 'escalate', from: ['open', 'claimed'], to: 'open', by: ['agent', 'coordinator'], refuse: 'CLOSED',
    guards: ['joined', 'noteGiven', 'itemExists', 'holderOrCoordinator', IN_STATE], command: 'pullboard escalate <id> --note "..."',
  },
];
