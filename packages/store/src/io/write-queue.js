/**
 * The board write-queue port [C7,#8925]: one ordered writer for board writes. Every write is submitted as a function;
 * writes run one at a time in submission order, and a failed write rejects only its own caller, never the writes
 * behind it. Why: board writers raced for the database lock (#3009); callers move onto this port in #8163.
 * @returns {{ submit: <T>(write: () => T | Promise<T>) => Promise<T>, pending: () => number }}
 */
export function createWriteQueue() {
  let tail = Promise.resolve();
  let pending = 0;
  return {
    /** Queue a write behind everything already submitted; resolves with its result or rejects with its own error. */
    submit(write) {
      pending++;
      const run = tail.then(() => write());
      tail = run.then(() => {}, () => {}).finally(() => { pending--; });
      return run;
    },
    /** How many submitted writes have not finished. */
    pending: () => pending,
  };
}
