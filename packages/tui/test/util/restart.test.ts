import { describe, expect, test } from "bun:test"
import { restartArgv } from "../../src/util/restart"

const ORIG_ARGV = process.argv

function withArgv(argv: string[], fn: () => void) {
  Object.defineProperty(process, "argv", { value: argv, configurable: true })
  try {
    fn()
  } finally {
    Object.defineProperty(process, "argv", { value: ORIG_ARGV, configurable: true })
  }
}

describe("restartArgv", () => {
  test("adds --session when absent", () => {
    withArgv(["bun", "/$bunfs/root/oc", "src"], () => {
      expect(restartArgv("ses_abc")).toEqual(["src", "--session", "ses_abc"])
    })
  })

  test("replaces existing --session value", () => {
    withArgv(["bun", "/$bunfs/root/oc", "--session", "ses_old", "-m", "x/y"], () => {
      expect(restartArgv("ses_new")).toEqual(["--session", "ses_new", "-m", "x/y"])
    })
  })

  test("replaces existing --session=value", () => {
    withArgv(["bun", "/$bunfs/root/oc", "--session=ses_old"], () => {
      expect(restartArgv("ses_new")).toEqual(["--session=ses_new"])
    })
  })

  test("replaces -s alias value", () => {
    withArgv(["bun", "/$bunfs/root/oc", "-s", "ses_old"], () => {
      expect(restartArgv("ses_new")).toEqual(["-s", "ses_new"])
    })
  })

  test("skips empty argv[0] artifact from a previous execve restart", () => {
    withArgv(["bun", "/$bunfs/root/oc", "", "-s", "ses_old"], () => {
      expect(restartArgv("ses_new")).toEqual(["-s", "ses_new"])
    })
  })

  test("strips --fork and --continue when session id given", () => {
    withArgv(["bun", "/$bunfs/root/oc", "--continue", "--fork"], () => {
      expect(restartArgv("ses_abc")).toEqual(["--session", "ses_abc"])
    })
  })

  test("strips -c alias too", () => {
    withArgv(["bun", "/$bunfs/root/oc", "-c"], () => {
      expect(restartArgv("ses_abc")).toEqual(["--session", "ses_abc"])
    })
  })

  test("no session id: drops session args and fork/continue", () => {
    withArgv(["bun", "/$bunfs/root/oc", "--session", "ses_old", "--fork", "src"], () => {
      expect(restartArgv(undefined)).toEqual(["src"])
    })
  })

  test("preserves unrelated flags and positional args", () => {
    withArgv(["bun", "/$bunfs/root/oc", "proj", "-m", "a/b", "--agent", "build"], () => {
      expect(restartArgv("ses_abc")).toEqual(["proj", "-m", "a/b", "--agent", "build", "--session", "ses_abc"])
    })
  })

  test("preserves everything after -- separator", () => {
    withArgv(["bun", "/$bunfs/root/oc", "--", "-c", "--fork"], () => {
      expect(restartArgv("ses_abc")).toEqual(["--", "-c", "--fork", "--session", "ses_abc"])
    })
  })
})
