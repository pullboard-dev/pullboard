/** Preserved setup command-group help, composed in its original display order. */
import { DEFAULT_VIEW_PORT } from '../../../../../packages/config/index.js';
export const setupHelp = `Set up
  pullboard tour                        see it work: a reject and its rework, scripted, in thirty seconds
  pullboard init [--model <name>] [--blueprint <name or file>]... [--no-permissions] [--no-hooks] [--yes] [--verbose]  --no-hooks skips agent nudges; --yes commits only setup's own files with your Git identity
  pullboard worktree <lane> --model <name> [--route light] [--family <name>]   make and join a worktree for a new agent
                                        pullboard.json worktrees: inside or beside; init defaults to inside
  pullboard join <lane> --model <name> [--route light] [--family <name>] [--parent <session-id>]  register this worktree and its parent session
                                        A model is required (or set PULLBOARD_MODEL); family is a separate declaration
  pullboard join coordinator --model <name>                                 declare the main checkout's coordinator model
                                        pullboard.json agents.names: suffix (default) or prefix
  pullboard whoami | lanes | status     who you are, the lanes, the board at a glance
  pullboard agents                      each agent with its seats and helpers, and what each holds
  pullboard lane add <name> --owns <path>[,<path>]   add a lane that owns those folders to pullboard.json
                                        refuses a lane name or a path that is already owned, naming the owner
  pullboard takeover                   rebind this checkout when the same agent starts a new session
                                        in a linked main checkout it also takes the board's coordinator here
  pullboard resources                  local resource holders and their FIFO queues
  pullboard settings line [<name> <value> --reason "why" --window <json>]  read or record board controller inputs; all off by default
      value is on, off, or a number within the setting range
                                        names: order, reviewsFirst, wipPerReviewer (1.5-3), barReady, bar.check, takeoverMinutes (15-60), collisionFreeBatch, landingBatchSize (1-8), landingCadenceMinutes (5-30), route.liveOnly, route.liveOnly
  pullboard settings [gateSlots <n> | browserSlots <n> | gate.runnersFirst on|off]  view or set machine gate policy and capacity (gate default 2; browser default 1)
                                        browser-free check slots are opt-in: gate.browserFreeChecks in ~/.pullboard/settings.json (default false)
                                        a test file takes a browser slot only if it launches Chrome: gate.browserByLaunch (default false)
                                        reviews-first queue order is opt-in: gate.queue.reviewsFirst (default false), gate.queue.agingMinutes (default 30)
                                        release priority is opt-in: gate.queue.currentReleaseFirst (default false), within each board's otherwise-tied positions
                                        memory hold is opt-in: gate.memoryFloorMB in ~/.pullboard/settings.json holds the queue under that many MB free or critical pressure (default off)
                                        short slots for runs that name their test files are opt-in: pullboard settings gate.shortSlots <n> (default 0)
                                        signed person moves are opt-in: pullboard settings person.signed on makes each wait for your passkey; only the passkey turns it off
                                        runner-first dispatch is opt-in: pullboard settings gate.runnersFirst on|off (default off)
                                        measured runner slots are opt-in: pullboard settings gate.measuredSlots on|off (default off); reserve 1 core and 2 GB, then cap mixed plain/browser capacity at 512 MB/2 GB per slot
                                        test/gate/submit/verify runner-only admission is opt-in: pullboard settings gate.runnersOnly on|off (default off)
                                        runner admission deadline: pullboard settings gate.runnerWaitMs <n> (default 300000ms)
                                        worker budget: pullboard settings workers.budget 40/day (or /week), seat-hours run --scale may spend (default off)
  pullboard runner add <ssh-host> [--slots <n> --browser <n>] [--node <remote-path>] [--root <remote-path>]
                                        register SSH test capacity; no runner sign-in; root defaults to ~/.pullboard-runner
                                        measures the runner's cores and memory; --slots declares a fixed count that always wins
  pullboard runner measure [<ssh-host>]  re-measure cores and memory on the runner itself (run it again after a hardware change)
  pullboard runner list                 each runner's slots and browsers, measured cores and memory, and the slots the formula gives
  pullboard runner serve <board-url>    pull jobs from a board over HTTPS and fetch code from its trunk remote; no ssh in
  pullboard runner install-serve <ssh-host> --board <board-url> [--key <key>] | --remove
                                        run runner serve on that runner as a login service that restarts on exit
  pullboard view [--project] [--port N] [--no-open]  every project on this machine in your browser; default http://127.0.0.1:${DEFAULT_VIEW_PORT}
  pullboard view --lan                  a private link for a phone on the local IPv4 network
                                        items, shouts, doctrine, agents and activity; --port 0 chooses a free port
                                        --project limits this view to the registered project for this repository
                                        add items, shout and hold lanes from it
  pullboard view --export <dir> [--public]  a read-only snapshot with event replay, for any static host
                                        --public requires a checked public filter
  pullboard serve [--port N] [--address <ipv4>]  local API v1: boards, state, moves, requests and live events,
                                        behind the session secret in its printed address
                                        serve.address and serve.port in ~/.pullboard/settings.json listen for runners with the board key (default loopback)
  pullboard mcp                        MCP tools over stdio for this worktree's agent, started by its MCP client:
                                        board status, show, shout and capture an idea; a person's move is refused
  pullboard relay [status|on|off|pair|join <code>] [--url <address>] [--name <computer>]  link, inspect or unlink this board's sealed relay
                                        on signs in through GitHub; the address defaults to https://app.pullboard.dev
                                        pair prints a one-use machine code; join stores it in another clone
  pullboard relay members set <login> [<login> ...] | clear  publish an approver-signed membership list
  pullboard relay pair --new-browser    sign in and pair one more browser; existing browsers stay paired
  pullboard relay canary [on|off|status|run|watch]  opt this linked seat into minute sealed round-trip monitoring
  pullboard relay on --all [--url <address>] [--name <computer>]  link every registered project after one sign-in; pair the phone once
                                        keep this command open until pairing finishes; later projects link on registration
  pullboard relay devices [--verbose]   paired phones and joined computers by name, with paired date, last seen and boards
                                        --verbose adds each id and phone key fingerprint
  pullboard relay revoke <device>       stop future key delivery; already received keys remain known
                                        approve on another paired phone, or sign in again with GitHub
  pullboard relay tokens                list this board's agent token ids, agents and expiry, never credentials
  pullboard relay revoke <token-id>     revoke one token from that list; other agents keep working
  pullboard relay recover --skip <sequence>  person-only recovery of one blocked next relay position
  pullboard handoff [--take <id>]        write or take an agent hand-off; keep questions on its item
  pullboard resume [--diagnostics]      where you are: your claim, branch, what came back,
                                        unread shouts, what to do next; run it to start any session
  pullboard badge                       write board-derived Shields endpoint JSON to docs/badges/
  pullboard hooks [uninstall]           install Git hooks and agent nudges; uninstall removes only Pullboard's agent nudges
  pullboard hook SessionStart|Stop|SessionEnd     native agent nudges; errors/timeouts warn and never block

`;
