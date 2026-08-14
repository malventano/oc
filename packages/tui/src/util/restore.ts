/**
 * Synchronous terminal restore on exit.
 *
 * The renderer's teardown emits its restore escape sequences through
 * async io_uring writes, which can be dropped when the process exits
 * immediately after (process.exit kills the io_uring worker mid-flight).
 * The net effect: the outer terminal keeps modes the app enabled - most
 * damagingly the kitty keyboard protocol (CSI > flags u), which re-encodes
 * every keystroke as CSI-u escapes. A plain shell (readline) cannot decode
 * those, so typing appears dead after quitting the TUI (only Ctrl+C still
 * works). strace'd runs masked this: ptrace forces Bun onto synchronous
 * writes, so the restore was flushed before exit.
 *
 * fs.writeSync is a real synchronous syscall - the bytes reach the kernel
 * before the process dies. All sequences are idempotent and harmless to
 * terminals that never enabled the modes.
 *
 * The exit path must NOT re-send 1049l: the renderer's own destroy already
 * exits the alternate screen, and a second 1049l re-restores a stale saved
 * cursor position, moving the shell prompt on a normal quit.
 */
import fs from "node:fs"

// Mode restores only - no 1049l (the renderer's own destroy handles the
// altscreen exit + cursor restore on normal quits).
export const TERMINAL_MODE_RESTORE_SEQUENCES =
  // kitty keyboard protocol pop
  "\x1b[<u" +
  // mouse reporting off (all modes + SGR)
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l" +
  // bracketed paste off
  "\x1b[?2004l" +
  // focus event reporting off
  "\x1b[?1004l" +
  // show cursor, reset SGR
  "\x1b[?25h\x1b[0m"

// Full restore incl. leaving the alternate screen - used by the /restart
// path, where no renderer teardown ever runs before the exec boundary.
export const TERMINAL_RESTORE_SEQUENCES = TERMINAL_MODE_RESTORE_SEQUENCES + "\x1b[?1049l"

export function restoreKeyboardSync(fd = 1) {
  try {
    fs.writeSync(fd, TERMINAL_MODE_RESTORE_SEQUENCES)
  } catch {
    // fd closed or not a tty - nothing to restore
  }
}

export function restoreTerminalSync(fd = 1) {
  try {
    fs.writeSync(fd, TERMINAL_RESTORE_SEQUENCES)
  } catch {
    // fd closed or not a tty - nothing to restore
  }
}

export function restoreTermiosSync() {
  try {
    // setRawMode(false) restores the termios saved at the first raw entry.
    // Critical for the execve restart path: exec preserves the renderer's
    // raw termios, and the restarted instance's renderer would capture THAT
    // raw state as its "original" baseline - its exit then restores raw mode
    // and the shell lands in a no-echo state. Restoring cooked first makes
    // the new instance capture a clean baseline.
    process.stdin.setRawMode(false)
  } catch {
    // fd 0 not a tty - nothing to restore
  }
}
