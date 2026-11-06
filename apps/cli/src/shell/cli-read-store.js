/**
 * The board queries a read command uses, from the query module alone. The store front door also re-exports the
 * write path, the event log and every board mover, so a read that imports it pays for all of them; this module
 * names only the read side [C7].
 */
export * from '../../../../packages/store/src/shell/board-query.js';
