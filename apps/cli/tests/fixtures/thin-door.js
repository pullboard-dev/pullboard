/** Fixtures that put a project's machine settings in the state the thin read doors serve under [C7]. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Pin health.derivedState off for a fixture project, in its machine settings file and for this process.
 * Why: the thin list and show doors step aside while health.derivedState is on (its default since #11391), because the
 * full path then reads verdict freshness from the derived-state table. A test of the door's own rows tests the off path,
 * so it turns the setting off; the on path belongs to the full path and has its own derived.test.js cases.
 * The door runs in the test process, so the process's machine home points at the fixture's until the returned function runs.
 *
 * @param {{ env: Record<string, string> }} box - A fixture project from createE2eHelpers().project().
 * @returns {() => void} Puts the process's machine home back; the settings file stays with the fixture.
 */
export function pinDerivedStateOff(box) {
  const home = box.env.PULLBOARD_MACHINE_HOME;
  const file = join(home, 'settings.json');
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...settings, health: { ...settings.health, derivedState: false } }));
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  return () => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; };
}
