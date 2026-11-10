/**
 * The `lapse` lifecycle move, declared in its own module so a change to one move's
 * guards never edits the file every other move shares; packages/state/src/io/machine.js lists every move in order [M1,C7].
 *
 * @type {import('../../../io/machine.js').Move[]}
 */
export const MOVES = [
  { verb: 'lapse', from: ['claimed'], to: 'open', by: ['clock'], guards: [], when: 'its lease runs out' },
];
