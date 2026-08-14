import fs from "node:fs"
import { restoreTermiosSync, restoreTerminalSync } from "./restore"

/**
 * Restart the opencode process, resuming the current session.
 *
 * Uses process.execve (Bun 1.3.14+, Node v24 parity): the process image is
 * replaced in place via execve(2), so pid, process group, controlling
 * terminal and raw-mode termios all survive the restart. The shell never
 * sees its foreground job complete, so it never reclaims the TTY - the
 * classic spawn+exit approach fails there (shell tcsetpgrp to itself, child
 * left in a background group, setRawMode EIO), and detached/setsid children
 * lose the controlling terminal and SIGWINCH. execve is the canonical
 * mechanism.
 *
 * The compiled stub consumes OS argv[0] as the program name and passes the
 * remaining entries through verbatim, so restart() passes execPath as
 * argv[0] and the user's original argv.slice(2) round-trips intact.
 */

export function restartArgv(sessionID: string | undefined): string[] {
  const argv = process.argv.slice(2)
  // execve passes OS argv through verbatim (the compiled stub only consumes
  // OS argv[0] as the program name), so a previous restart's argv[0] must
  // not leak into the rebuilt launch line.
  while (argv.length > 0 && argv[0] === "") argv.shift()
  const result: string[] = []
  let sessionSet = false
  let positionals = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!positionals && arg === "--") {
      // Everything after the separator is positional - pass through verbatim.
      positionals = true
      result.push(arg)
      continue
    }
    if (!positionals && arg === "--fork") continue
    if (!positionals && (arg === "--continue" || arg === "-c")) continue
    if (!positionals && (arg === "--session" || arg === "-s")) {
      // Replace the old value; a session id is always known at call time, but
      // guard for the no-session restart (home screen) where --session must go.
      if (sessionID) {
        result.push(arg, sessionID)
        sessionSet = true
      }
      i += 1 // skip the old value
      continue
    }
    if (!positionals && arg.startsWith("--session=")) {
      if (sessionID) {
        result.push(`--session=${sessionID}`)
        sessionSet = true
      }
      continue
    }
    result.push(arg)
  }
  if (sessionID && !sessionSet) result.push("--session", sessionID)
  return result
}

export function restart(sessionID: string | undefined) {
  if (typeof process.execve !== "function") {
    throw new Error("process.execve is not supported by this runtime")
  }
  // Full restore BEFORE the exec boundary: critically this exits the
  // alternate screen. If we exec while the alt screen is still active, the
  // restarted instance's 1049h entry re-saves the CURRENT (alt) frame as
  // the terminal's "main screen" state - quitting then restores that stale
  // TUI frame onto the main screen, the shell prompt renders over it, and
  // typed input stops echoing. With the alt screen exited first, the new
  // instance enters it fresh and the post-quit main screen is the original
  // prompt. The pop also prevents keyboard-protocol stack growth per
  // restart, and the sync write survives the image replacement (the
  // renderer's own async io_uring teardown writes would be dropped).
  restoreTerminalSync()
  // The exec preserves termios: without this, the restarted instance's
  // renderer captures the raw renderer state as its "original" baseline and
  // restores RAW on ITS exit - the shell lands in a no-echo state.
  restoreTermiosSync()
  // Clear the main screen so the restarted instance paints its startup
  // block (logo + session banner) fresh at the top, like a normal launch.
  // Without this, the stale first-boot block stays below the prompt and the
  // post-quit prompt lands in the middle of it.
  try {
  // Clear + boot feedback, then LF LF so the cursor rests on a blank line
  // below the message (not highlighting the first character) and the
  // restarted instance's startup block paints BELOW the message instead of
  // overwriting it.
    fs.writeSync(1, "\x1b[2J\x1b[HRestarting oc...\n\n")
 } catch {
   // stdout closed - nothing to do
 }
  // argv[0] = execPath is consumed by the stub as the program name; the
  // remaining entries become the new process's argv.slice(2). Never returns
  // on success.
  process.execve(process.execPath, [process.execPath, ...restartArgv(sessionID)], process.env)
}
