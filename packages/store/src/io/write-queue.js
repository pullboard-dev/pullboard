/**
 * The board write-queue port [C7,#8925,#8926]: one ordered writer for board writes. Every write is submitted as a function;
 * writes run one at a time in submission order, and a failed write rejects only its own caller, never the writes
 * behind it. Why: board writers raced for the database lock (#3009); callers move onto this port in #8163.
 *
 * With `transaction` and `savepoint` ports (both run a function and return its result, as `atomic(board, work)` does),
 * every write queued in the same turn commits in ONE transaction, each inside its own savepoint, so a failing write
 * rolls back only itself. Grouped writes must be synchronous: a transaction cannot stay open across an await.
 * Without the ports each write runs alone, as before.
 * @param {{ transaction?: <T>(work: () => T) => T, savepoint?: <T>(work: () => T) => T }} [ports]
 * @returns {{ submit: <T>(write: () => T | Promise<T>) => Promise<T>, pending: () => number }}
 */
export function createWriteQueue({ transaction, savepoint } = {}) {
  let tail = Promise.resolve();
  let pending = 0;
  let group = null;
  /** Commit every write gathered in one turn as a single transaction, settling each caller after the commit. */
  function commitGroup(jobs) {
    const outcomes = [];
    try {
      transaction(() => {
        for (const job of jobs) {
          try { outcomes.push({ job, value: savepoint ? savepoint(job.write) : job.write() }); }
          catch (error) { outcomes.push({ job, error, failed: true }); }
        }
      });
    } catch (error) {
      for (const job of jobs) job.reject(error);
      return;
    }
    for (const { job, value, error, failed } of outcomes) (failed ? job.reject(error) : job.resolve(value));
  }
  return {
    /** Queue a write behind everything already submitted; resolves with its result or rejects with its own error. */
    submit(write) {
      pending++;
      if (!transaction) {
        const run = tail.then(() => write());
        tail = run.then(() => {}, () => {}).finally(() => { pending--; });
        return run;
      }
      const result = new Promise((resolve, reject) => {
        if (!group) {
          const jobs = group = [];
          tail = tail.then(() => new Promise(done => queueMicrotask(done))).then(() => { group = null; commitGroup(jobs); });
        }
        group.push({ write, resolve, reject });
      });
      result.then(() => { pending--; }, () => { pending--; });
      return result;
    },
    /** How many submitted writes have not finished. */
    pending: () => pending,
  };
}
