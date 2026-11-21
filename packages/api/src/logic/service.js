/**
 * The supervised board API service: its launchd definition and the commands that load or remove it [P7].
 * Why: the board API on its port was not supervised, so one crash stopped every runner until a person restarted it; a
 * LaunchAgent with KeepAlive restarts it. Installing is opt-in: only `pullboard serve install` writes any of this.
 */

/** The launchd label, so a reinstall replaces the one service and `serve uninstall` finds it. */
export const BOARD_SERVICE_LABEL = 'dev.pullboard.board-api';

const xml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/**
 * The service's launchd property list.
 *
 * @param {{ node: string, cli: string, root: string, log: string, home: string, address?: string, port?: number }} plan
 *   node and cli are the files the service runs; root is the board's checkout (the service's working folder); address
 *   and port are passed to serve only when given, so the person's serve settings otherwise apply.
 * @returns {string}
 */
export function boardServicePlist({ node, cli, root, log, home, address, port }) {
  const args = [node, cli, 'serve', ...(address === undefined ? [] : ['--address', address]), ...(port === undefined ? [] : ['--port', String(port)])];
  const path = [node.replace(/\/[^/]*$/u, ''), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  return ['<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">', '<dict>',
    `  <key>Label</key><string>${xml(BOARD_SERVICE_LABEL)}</string>`,
    '  <key>ProgramArguments</key>', '  <array>', ...args.map((arg) => `    <string>${xml(arg)}</string>`), '  </array>',
    `  <key>EnvironmentVariables</key>`, `  <dict><key>PATH</key><string>${xml(path)}</string><key>HOME</key><string>${xml(home)}</string></dict>`,
    `  <key>WorkingDirectory</key><string>${xml(root)}</string>`,
    '  <key>RunAtLoad</key><true/>', '  <key>KeepAlive</key><true/>', '  <key>ThrottleInterval</key><integer>10</integer>',
    `  <key>StandardOutPath</key><string>${xml(log)}</string>`, `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
    '</dict>', '</plist>', ''].join('\n');
}

/**
 * The launchctl commands for one install or removal, in order. A reload is bootout then bootstrap, never kickstart
 * alone, so the new definition is the one that runs; the bootout of a service that is not loaded may fail and is
 * not an error. Removal only boots the service out.
 *
 * @param {{ uid: number, plist: string, remove?: boolean }} plan
 * @returns {{ args: string[], optional: boolean }[]}
 */
export function boardServiceCommands({ uid, plist, remove = false }) {
  const domain = `gui/${uid}`;
  const bootout = { args: ['bootout', `${domain}/${BOARD_SERVICE_LABEL}`], optional: true };
  return remove ? [bootout] : [bootout, { args: ['bootstrap', domain, plist], optional: false }];
}
