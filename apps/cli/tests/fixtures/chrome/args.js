/** Shared real Chrome arguments, separate from generic Node process stand-ins [C7]. */
/** Launch arguments for an isolated Chrome at 1280x900, because under 900 px the view shows the Menu drawer and hides the tabs (#6725); phone journeys set their own size over CDP. */
export function chromeLaunchArgs(profile) {
  return ['--disable-features=MacAppCodeSignClone', '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync', '--disable-extensions', '--no-proxy-server',
    '--use-mock-keychain', '--window-size=1280,900', '--password-store=basic', '--remote-debugging-port=0',
    // A person's real view holds 4890; no test Chrome may reach it, even by preconnect.
    '--host-resolver-rules=MAP 127.0.0.1:4890 ~NOTFOUND, MAP localhost:4890 ~NOTFOUND', `--user-data-dir=${profile}`, 'about:blank'];
}
