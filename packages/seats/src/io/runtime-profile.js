import profiles from './runtime-profiles.json' with { type: 'json' };

/**
 * The shipped runtime profile for a seat's runtime: its prompt-cache setting, cached prefix and tool loading.
 * Why: a runtime outside the shipped data must still launch, so it gets the profile's safe default (caching off) [C7].
 *
 * @param {string} runtime a runtime or model-provider name, e.g. "claude"
 * @returns {{cache: string, cachedPrefix: string[], toolLoading: string}}
 */
export function runtimeProfile(runtime) {
  return Object.hasOwn(profiles, runtime) && runtime !== 'default' ? profiles[runtime] : profiles.default;
}
