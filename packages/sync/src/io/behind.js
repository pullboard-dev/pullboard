/** The behind-device options a git-synced move passes to prepareEngineMove [H17,#9830]. */

/**
 * The options that let a refused move name the teammate device running an older engine: whatever the caller's `io.behindDeviceOptions` returns,
 * or none. Why a parameter: sync cannot import link (the roster lives there) and a move never reads a setting, so the caller reads engine.nameBehindDevice
 * and the roster first. With the setting off the caller passes nothing and this adds nothing; a fault in the reader leaves the options empty.
 *
 * @param {{ behindDeviceOptions?: () => Promise<object> | object }} io - The caller's ports.
 * @returns {Promise<{ nameBehindDevice?: true, behindDevices?: { device: string, seat: string, engine: number }[] }>}
 */
export async function behindOptions(io) {
  if (typeof io?.behindDeviceOptions !== 'function') return {};
  try {
    const options = await io.behindDeviceOptions();
    return options?.nameBehindDevice === true ? { nameBehindDevice: true, behindDevices: Array.isArray(options.behindDevices) ? options.behindDevices : [] } : {};
  } catch {
    return {};
  }
}
