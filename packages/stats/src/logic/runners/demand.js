/** Runner demand per agent: proof jobs and slot-minutes per active seat per hour, and the slots per agent they imply [C7,#6034]. */
const HOUR_MS = 3_600_000;

/** Milliseconds a span overlaps the hour starting at hourStart. */
function overlapMs(span, hourStart) {
  return Math.max(0, Math.min(span.end, hourStart + HOUR_MS) - Math.max(span.start, hourStart));
}

/**
 * Compute hourly demand per active seat.
 * An active seat is one with a board event in that hour. Slots per agent is the average slots a seat held busy:
 * slot-minutes in the hour / 60 / active seats. Hours with no active seat report null per-seat figures.
 * Why: the pool must be sized from what each working agent really asks of it, not a guess.
 *
 * @param {{ start: number, end: number }[]} spans - Job slot spans.
 * @param {number[]} jobTimes - Creation time of every proof job.
 * @param {{ at: number, seat: string }[]} events - Board events (time, seat).
 * @param {{ now: number, windowMinutes?: number }} options
 */
export function runnerDemand(spans, jobTimes, events, { now, windowMinutes = 1440 }) {
  const last = Math.floor(now / HOUR_MS) * HOUR_MS;
  const first = Math.floor((now - windowMinutes * 60_000) / HOUR_MS) * HOUR_MS;
  const hours = [];
  let jobsTotal = 0, minutesTotal = 0, seatHours = 0;
  for (let start = first; start <= last; start += HOUR_MS) {
    const seats = new Set(events.filter(event => event.at >= start && event.at < start + HOUR_MS).map(event => event.seat));
    const proofJobs = jobTimes.filter(at => at >= start && at < start + HOUR_MS).length;
    const slotMinutes = spans.reduce((sum, span) => sum + overlapMs(span, start), 0) / 60_000;
    const n = seats.size;
    jobsTotal += proofJobs; minutesTotal += slotMinutes; seatHours += n;
    hours.push({ hour: new Date(start).toISOString(), activeSeats: n, proofJobs, slotMinutes,
      jobsPerSeat: n ? proofJobs / n : null, slotMinutesPerSeat: n ? slotMinutes / n : null, slotsPerAgent: n ? slotMinutes / 60 / n : null });
  }
  return { windowMinutes, hours, overall: { proofJobs: jobsTotal, slotMinutes: minutesTotal, seatHours,
    jobsPerSeatHour: seatHours ? jobsTotal / seatHours : null, slotMinutesPerSeatHour: seatHours ? minutesTotal / seatHours : null, slotsPerAgent: seatHours ? minutesTotal / 60 / seatHours : null } };
}

/** Text lines for pullboard stats runners --demand. */
export function demandLines(report) {
  const num = value => (value === null ? 'n/a' : value.toFixed(2));
  const o = report.overall;
  const lines = [`runner demand per agent, last ${report.windowMinutes} min: ${num(o.slotsPerAgent)} slots per agent, ${num(o.jobsPerSeatHour)} proof jobs and ${num(o.slotMinutesPerSeatHour)} slot-min per seat-hour`];
  for (const h of report.hours.filter(row => row.activeSeats || row.proofJobs)) lines.push(`  ${h.hour}: ${h.activeSeats} seats, ${h.proofJobs} jobs, ${h.slotMinutes.toFixed(1)} slot-min, ${num(h.slotsPerAgent)} slots/agent`);
  return lines;
}
