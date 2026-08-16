// Test suite for the bash file-op guard (plugins/bash-file-op-guard.js).
// Walks the complete case table from oc-spec/11 (bash guards): every
// guarded class fires, every exclusion context stays silent, and the
// false-positive samples stay silent.
//
// Run: node plugins/bash-file-op-guard.test.mjs

import guard from "./bash-file-op-guard.js"

const hook = guard.server()["tool.execute.after"]

const fire = async (cmd) => {
  const input = { tool: "bash", args: { command: cmd } }
  const output = { output: "" }
  await hook(input, output)
  return output.output
}

let pass = 0
let fail = 0
const failures = []

const check = async (cmd, expect, label) => {
  const out = await fire(cmd)
  const hit = out.includes("Bash file-op guard")
  if (hit === expect) {
    pass++
  } else {
    fail++
    failures.push(`${expect ? "MISS" : "FALSE POSITIVE"} (${label}): ${cmd}`)
  }
}

// --- Positive cases: every guarded class must fire ---
const POSITIVE = [
  // in-place mutations (edit tool)
  ["sed -i 's/x/y/' file.txt", "sed -i"],
  ["sed -i.bak 's/x/y/' file.txt", "sed -i with backup suffix"],
  ["perl -i -pe 's/x/y/' file.txt", "perl -i"],
  ["perl -pi -e 's/x/y/' file.txt", "perl -pi"],
  ["perl -i.bak -pe 's/x/y/' file.txt", "perl -i.bak"],
  ["perl -wpi -e 's/x/y/' file.txt", "perl -wpi"],
  ["awk -i inplace '{print}' file.txt", "awk -i inplace"],
  ["truncate -s 0 file.txt", "truncate"],
  ["jq -i '.a=1' file.json", "jq -i"],
  ["jq --in-place '.a=1' file.json", "jq --in-place"],
  ["yq -i '.a=1' file.yaml", "yq -i"],
  ["dos2unix file.txt", "dos2unix"],
  ["unix2dos file.txt", "unix2dos"],
  // file lifecycle
  ["rm file.txt", "rm bare"],
  ["rm -f file.txt", "rm -f"],
  ["rm -f a.txt b.txt", "rm multi-file"],
  ["mv a.txt b.txt", "mv rename"],
  ["mv -f a.txt b.txt", "mv -f rename"],
  ["touch newfile.txt", "touch"],
  // writes (write tool)
  [': > file.txt', "colon truncate"],
  ["echo x > file.txt", "redirect EOL"],
  ["echo x >> file.txt", "append EOL"],
  ["echo x >> file.txt && echo y", "append mid-chain"],
  ["tee out.txt", "tee"],
  ["cat > file.txt << EOF", "heredoc write"],
  ["python3 - << 'PY'\nopen('out.txt','w').write('hi')\nPY", "python heredoc write"],
  ["python3 << 'EOF'\nopen('out.txt','w').write('hi')\nEOF", "python heredoc no-dash"],
  ["python3 - << 'PY'\nopen('f','a').write('x')\nPY", "python heredoc append"],
  ["python3 - << 'PY'\nopen('f','r+').write('x')\nPY", "python heredoc r+ read-write"],
  ["python3 - << 'PY'\nopen('f','wb').write(b'x')\nPY", "python heredoc binary"],
  ["python3 - << 'PY'\nfrom pathlib import Path\nPath('f').write_text('x')\nPY", "python heredoc pathlib write_text"],
  ["python3 - << 'PY'\nPath('f').unlink()\nPY", "python heredoc pathlib unlink"],
  ["python3 - << 'PY'\nimport os\nos.remove('f')\nPY", "python heredoc os.remove"],
  ["python3 - << 'PY'\nimport os\nos.rename('a','b')\nPY", "python heredoc os.rename"],
  ["python3 - << 'PY'\nimport shutil\nshutil.copyfile('a','b')\nPY", "python heredoc shutil.copyfile"],
  ["python3 - << 'EOF'\npath = '/root/oc/opencode/docs/x.md'\ns = open(path).read()\nold = 'a'\nnew = 'b'\nassert s.count(old) == 1\nopen(path, 'w').write(s.replace(old, new))\nprint('OK')\nEOF", "python heredoc assert-RMW (real pattern)"],
  ["python3 -c 'open(\"out.txt\",\"w\").write(\"hi\")'", "python -c write"],
  ["python -c \"open('f','w')\"", "python -c single quotes"],
  ["python3 -c \"open('f','a').write('x')\"", "python -c append"],
  ["python3 -c \"from pathlib import Path; Path('f').write_bytes(b'x')\"", "python -c pathlib write_bytes"],
  ["node -e \"fs.writeFileSync('f','x')\"", "node -e writeFileSync"],
  ["node -e \"fs.appendFileSync('f','x')\"", "node -e appendFileSync"],
  ["node - << 'EOF'\nfs.writeFileSync('f','x')\nEOF", "node heredoc write"],
  ["node - << 'PY'\nfs.rmSync('f')\nPY", "node heredoc rmSync"],
  ["deno eval \"Deno.writeTextFile('f','x')\"", "deno eval writeTextFile"],
  ["tsx -e \"fs.writeFile('f','x',()=>{})\"", "tsx -e writeFile"],
  ["dd if=/dev/zero of=out.bin bs=1M count=1", "dd of="],
  // reads (read/grep tools)
  ["sed -n '5,20p' file.txt", "sed -n window"],
  ["grep foo bar.txt", "grep bare filename"],
  ["grep -n foo bar.txt", "grep -n bare"],
  ["grep -rn foo src/", "grep recursive dir"],
  ["grep -P 'foo' file.txt", "grep -P"],
  ["rg -n foo file.txt", "rg is sanctioned but still a file search - no fire expected (see negative)"],
  ["wc -l file.txt", "wc -l"],
  ["wc file.txt", "wc bare"],
  ["wc -l -w file.txt", "wc multi-flag"],
  ["cat file.txt", "cat bare"],
  ["cat -n file.txt", "cat -n"],
  ["head -5 file.txt", "head bare"],
  ["tail -20 file.txt", "tail bare"],
  ["tail -f app.log", "tail -f"],
  ["cat /root/oc/opencode/README.md", "cat absolute path"],
]

// --- Negative cases: exclusions and false-positive guards must stay silent ---
const NEGATIVE = [
  // exclusion contexts (whole command skipped)
  ["ssh root@host 'sed -i s/x/y/ /etc/foo'", "ssh remote"],
  ["scp local.txt user@host:~/", "scp"],
  ["docker exec -it container sed -i s/x/y/ /app/f", "docker"],
  ["git mv a.txt b.txt", "git"],
  ["git status", "git status"],
  ["tmux capture-pane | grep foo", "tmux pane output"],
  ["npm run build", "npm build"],
  ["bun test test/session/x.test.ts", "bun test"],
  ["make build", "make"],
  ["vllm-start dsv4 --dry-run", "vllm-start dry-run"],
  ["journalctl -u opencode", "journalctl"],
  ["systemctl restart docker", "systemctl"],
  // no file operations at all
  ["echo hello", "echo no redirect"],
  ["pkill -9 -f aiperf", "pkill"],
  ["ls -la", "ls"],
  ["chmod +x script.sh", "chmod"],
  ["mkdir -p /tmp/x", "mkdir"],
  ["df -h", "df"],
  ["date -u", "date"],
  // stdin / pipe / redirect shapes that are NOT file reads
  ["grep foo | cat", "grep pipe to cat (no file)"],
  ["cat < input.txt", "cat stdin redirect"],
  ["cat << EOF", "cat heredoc to stdout"],
  ["wc", "wc stdin"],
  ["grep pattern < input.txt", "grep stdin redirect"],
  ["grep foo", "grep no target"],
  // directory forms the edit tool cannot express
  ["rm -rf dir/", "rm -rf directory"],
  ["rm -r dir/", "rm -r directory"],
  ["rm --recursive dir/", "rm --recursive"],
  ["rm -fr dir/", "rm -fr"],
  ["rm empty-dir/", "rm trailing slash"],
  ["mv src/ dst/", "mv directories"],
  ["mv a.txt dst/", "mv into directory"],
  // flag-heavy commands that must not match as file targets
  ["grep -e foo -e bar file.txt", "grep -e double (no match by design)"],
  ["perl -e 'print 1'", "perl -e no -i"],
  ["awk -i inplace_script.awk file.txt", "awk -i as include (no inplace)"],
  ["dd if=x of=/dev/null", "dd to /dev/null"],
  ["python3 -c 'print(open(\"f\").read())'", "python -c read-only"],
  ["python3 - << 'PY'\nprint(open('f').read())\nPY", "python heredoc read-only"],
  ["python3 -c 'print(2+2)'", "python -c compute only"],
  ["python3 - << 'PY'\nimport os\nos.path.join('a','b')\nPY", "python os.path is not a file op"],
  ["python3 -c \"from pathlib import Path; print(Path('f').exists())\"", "python pathlib read-only exists"],
  ["node -e \"console.log(fs.readFileSync('f','utf8'))\"", "node -e read-only"],
  ["node -e 'console.log(1+1)'", "node -e compute only"],
  ["touch --help", "touch --help"],
  // not bash
  ["cat file.txt", "non-bash tool (checked separately)"],
]

const main = async () => {
  for (const [cmd, label] of POSITIVE) {
    if (label === "rg is sanctioned but still a file search - no fire expected (see negative)") continue
    await check(cmd, true, label)
  }

  for (const [cmd, label] of NEGATIVE) {
    if (label === "non-bash tool (checked separately)") continue
    await check(cmd, false, label)
  }

  // non-bash tool: the hook must no-op
  {
    const input = { tool: "read", args: { filePath: "file.txt" } }
    const output = { output: "" }
    await hook(input, output)
    if (output.output === "") pass++
    else {
      fail++
      failures.push(`FALSE POSITIVE (non-bash tool): ${JSON.stringify(input)}`)
    }
  }

  // empty command: no-op
  {
    const output = { output: "" }
    await hook({ tool: "bash", args: { command: "" } }, output)
    if (output.output === "") pass++
    else {
      fail++
      failures.push("FALSE POSITIVE (empty command)")
    }
  }

  console.log(`bash-file-op-guard: ${pass} pass / ${fail} fail`)
  for (const f of failures) console.log(`  ${f}`)
  process.exit(fail ? 1 : 0)
}

main()
