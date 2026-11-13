/**
 * Audited exceptions to the 100 ms tab paint goal (#7144) on the 1600-item, 1150-agent, 40000-shout board [N26].
 *
 * Each row is the worst paint measured on runners on 13 Nov (load average 13 to 26) plus 50% for load swings: repeat runs
 * moved a paint by 15% (spec repeat 290 then 291 ms, items first 330 then 377 ms). Rows only go down, and the
 * 0.9.5 view first-paint item brings them to the goal. `hang: true` means the tab never answered the browser within 15 s.
 */
export const TAB_SPEED_GOAL_MS = 100;
export const TAB_SPEED_ROWS = {
  spec: { first: 1400, repeat: 600 },
  doctrine: { first: 450, repeat: 380 },
  items: { first: 560, repeat: 1000 },
  roadmap: { first: 1900, repeat: 260 },
  dashboard: { hang: true },
};
