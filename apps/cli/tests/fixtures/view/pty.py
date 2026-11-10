"""Run one person-mode pullboard view command with real terminal file descriptors."""
import http.cookiejar
import json
import os
import pty
import select
import signal
import socket
import subprocess
import sys
import time
import urllib.request


def stopped(port):
    deadline = time.monotonic() + 6
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.25):
                pass
        except ConnectionRefusedError:
            return True
        except OSError:
            time.sleep(0.025)
        else:
            time.sleep(0.025)
    return False


def main():
    config = json.load(sys.stdin)
    env = config["env"]
    for key in ("AI_AGENT", "PULLBOARD_VIEW_FOREGROUND", "PULLBOARD_VIEW_BACKGROUND_CHILD"):
        env.pop(key, None)
    master, slave = pty.openpty()
    actual_stdout_tty = os.isatty(slave)
    assert actual_stdout_tty, "fixture did not create a real terminal"
    child = subprocess.Popen(
        [config["node"], config["bin"], "view", "--no-open", "--port", "0", "--json"],
        cwd=config["repo"], env=env, stdin=slave, stdout=slave, stderr=slave, close_fds=True,
    )
    os.close(slave)
    document = None
    buffer = b""
    page_status = None
    cleanup_ok = False
    processes_gone = False
    stayed_foreground = False
    pid_matches = False
    parent_pid = child.pid
    server_pid = None
    try:
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline and document is None:
            if not select.select([master], [], [], 0.2)[0]:
                continue
            try:
                buffer += os.read(master, 65536)
            except OSError:
                break
            text = buffer.decode(errors="replace")
            for start, char in enumerate(text):
                if char != "{":
                    continue
                try:
                    candidate, _ = json.JSONDecoder().raw_decode(text[start:])
                except ValueError:
                    continue
                if isinstance(candidate, dict) and "url" in candidate:
                    document = candidate
                    break
        assert document is not None, "person PTY command did not print its JSON view link"
        server_pid = document.get("pid")
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        with opener.open(document["url"], timeout=5) as response:
            page_status = response.status
        assert page_status == 200, "the PTY view link did not fetch the page"
        stayed_foreground = child.poll() is None
        pid_matches = server_pid == child.pid
        returncode = None
    finally:
        if not document:
            try:
                pointer = os.path.join(env["PULLBOARD_HOME"], "view.json")
                with open(pointer, encoding="utf-8") as stream:
                    state_pointer = json.load(stream)
                state_path = os.path.join(env["PULLBOARD_HOME"], f"view-{state_pointer['port']}.json")
                with open(state_path, encoding="utf-8") as stream:
                    state = json.load(stream)
                document = {"pid": state["pid"], "port": state["port"]}
            except (FileNotFoundError, KeyError, ValueError, json.JSONDecodeError):
                document = None
        targets = {child.pid}
        if isinstance(document, dict) and isinstance(document.get("pid"), int):
            targets.add(document["pid"])
        for pid in targets:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        try:
            returncode = child.wait(timeout=8)
        except subprocess.TimeoutExpired:
            child.kill()
            returncode = child.wait(timeout=8)
        if document and isinstance(document.get("port"), int):
            cleanup_ok = stopped(document["port"])
        else:
            cleanup_ok = True
        processes_gone = True
        for pid in targets:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.025)
            else:
                processes_gone = False
        os.close(master)
        assert returncode is not None, "person PTY process did not exit during cleanup"
        assert processes_gone, "a PTY view process remained after cleanup"
        assert cleanup_ok, "person PTY listener remained open after cleanup"
    print(json.dumps({
        "actualStdoutTTY": actual_stdout_tty, "aiAgent": False, "jsonMode": True,
        "pageStatus": page_status, "parentRemainedForeground": stayed_foreground,
        "serverPidMatchesParent": pid_matches, "parentPid": parent_pid,
        "serverPid": server_pid, "processesGone": processes_gone, "listenerClosed": cleanup_ok,
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Never echo the captured terminal buffer or URL: it contains the session key.
        detail = error.args[0] if isinstance(error, AssertionError) and error.args else "unexpected helper failure"
        print(f"PTY regression failed: {type(error).__name__}: {detail}", file=sys.stderr)
        raise SystemExit(1)
