/** Keep a real completed assertion when cancellation replaces its ordered file result [C7,V4]. */

/** Retain the execution result before abort, without changing native event order or numbering. */
export function landingFailureReport() {
  let completed;
  let replaced = false;
  let reported = false;
  return {
    /** Save the real execution result before abort can replace its ordered file result. */
    remember(data) { completed = data; },
    /** Restore only a shadowed failure, leaving authentic reports and their native counts alone. */
    event(event) {
      const data = event.data;
      const error = completed?.details?.error;
      if (completed && event.type === 'test:fail' && data.file === completed.file && data.name === completed.name
          && !['testAborted', 'subtestsFailed'].includes(data.details?.error?.failureType)) reported = true;
      if (!reported && !replaced && completed && event.type === 'test:fail' && data.file === completed.file
          && data.details?.error?.failureType === 'testAborted' && error
          && !['testAborted', 'subtestsFailed'].includes(error.failureType)) {
        replaced = true;
        return { ...event, data: { ...data, ...completed, nesting: data.nesting, testNumber: data.testNumber } };
      }
      if (!replaced) return event;
      if (event.type === 'test:diagnostic' && data.nesting === 0) {
        const count = /^(fail|cancelled) (\d+)$/u.exec(data.message);
        if (count) return { ...event, data: { ...data, message: `${count[1]} ${Number(count[2]) + (count[1] === 'fail' ? 1 : -1)}` } };
      }
      if (event.type === 'test:summary' && !data.file && data.counts) {
        return { ...event, data: { ...data, success: false,
          counts: { ...data.counts, failed: data.counts.failed + 1, cancelled: data.counts.cancelled - 1 } } };
      }
      return event;
    },
  };
}
