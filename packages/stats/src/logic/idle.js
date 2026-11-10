/** Prospective idle observations grouped by their actual first candidate filter [C7,#3080]. */

/** Count each seat once, ending an observed idle interval on new work and clipping it to the last 24 hours. */
export function idleSkipMinutes(history, now) {
  const since = now - 24 * 60 * 60_000;
  const idle = new Map(), totals = new Map();
  /** Close one observed interval; other skipped candidates are context, never duplicate seat time. */
  function close(seat, at) {
    const held = idle.get(seat);
    if (!held) return;
    const ms = Math.max(0, Math.min(at, now) - Math.max(held.at, since));
    totals.set(held.code, (totals.get(held.code) ?? 0) + ms);
    idle.delete(seat);
  }
  for (const event of history) {
    if (!['next-idle', 'claim', 'reserve'].includes(event.event_kind)) continue;
    const at = Date.parse(event.event_at);
    if (!Number.isFinite(at) || at > now) continue;
    close(event.event_by, at);
    if (event.event_kind !== 'next-idle') continue;
    let detail;
    try { detail = JSON.parse(event.event_detail); } catch { continue; /* Invalid historical observations establish no interval. */ }
    const code = detail?.skips?.[0]?.code;
    idle.set(event.event_by, { at, code: /^[A-Z][A-Z0-9_]{0,63}$/u.test(code ?? '') ? code : 'UNKNOWN' });
  }
  for (const seat of idle.keys()) close(seat, now);
  return { since: new Date(since).toISOString(), until: new Date(now).toISOString(),
    rows: [...totals].filter(([, ms]) => ms > 0).sort(([a], [b]) => a.localeCompare(b)).map(([code, ms]) => ({ code, seatMinutes: ms / 60_000 })) };
}
