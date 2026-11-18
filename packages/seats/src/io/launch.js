import { runtimeProfile } from './runtime-profile.js';

/**
 * The launch configuration for a seat: its runtime's shipped profile applied to the seat's lane tools.
 * Why: prompt caching and tool loading differ by model provider, so a seat launches with what its runtime's
 * profile asks for, and a runtime outside the shipped data launches with caching off [C7].
 *
 * @param {{ runtime: string, laneTools?: string[] }} seat the runtime or model-provider name and the tools its lane may load
 * @returns {{ runtime: string, promptCache: string, cachedPrefix: string[], toolLoading: string, tools: string[] }}
 */
export function seatLaunchConfig({ runtime, laneTools = [] }) {
  const profile = runtimeProfile(runtime);
  return { runtime, promptCache: profile.cache, cachedPrefix: [...profile.cachedPrefix], toolLoading: profile.toolLoading, tools: [...laneTools] };
}
