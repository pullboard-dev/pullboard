/**
 * Audited exceptions to the 100 ms tab paint goal (#7144) on the 1600-item, 1150-agent, 40000-shout board [N26].
 *
 * Each row is the worst paint measured on runners on 13 Nov at a load average near 13; spec repeat reached 291 ms in a later run. Rows only go down, and the
 * 0.9.5 view first-paint item brings them to the goal. `hang: true` means the tab never answered the browser within 15 s.
 */
export const TAB_SPEED_GOAL_MS = 100;
export const TAB_SPEED_ROWS = {
  spec: { first: 920, repeat: 400 },
  doctrine: { first: 270, repeat: 230 },
  items: { first: 330, repeat: 670 },
  roadmap: { first: 1260, repeat: 160 },
  dashboard: { hang: true },
};
