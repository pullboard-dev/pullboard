# Native Windows compatibility

Pullboard's private relay storage checks the actual NTFS owner and access-control
list on Windows. Synthetic Unix mode bits reported by Node are not used as NTFS
permissions. The current user must own the object and have read access; other
allowed principals are limited to SYSTEM and built-in Administrators. Reparse
points, null DACLs and failed permission queries are refused. New private files
also require a private parent directory before any bytes are written.

Configured gates, formatters and untimed shell commands use the Bash bundled with
Git for Windows, because Pullboard emits POSIX shell syntax. Commands and child
Node programs still run natively on Windows; WSL is not required. Missing Git Bash
is an explicit error.

The background view and other console children request hidden Windows consoles.
This prevents a new CMD/Git window for each view refresh while preserving output,
exit status, callbacks, environment, timeouts and existing child-process guards.

Run the focused compatibility checks from a native Windows checkout:

```powershell
node --test test/windows-storage.test.js test/windows-processes.test.js
```

This is a partial portability repair. Timed shell execution, POSIX process-group
cleanup and the complete test/landing workflow still need Windows-specific work.
These changes do not claim that the full gate passes on Windows.
