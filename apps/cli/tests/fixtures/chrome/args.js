/** Shared real Chrome arguments, separate from generic Node process stand-ins [C7]. */
export function chromeLaunchArgs(profile) {
  return ['--disable-features=MacAppCodeSignClone', '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync', '--disable-extensions', '--no-proxy-server',
    '--use-mock-keychain', '--password-store=basic', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'];
}
