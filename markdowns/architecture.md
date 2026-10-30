# RSI-Agent Architecture

Status: integration implemented in `rsi/src/main.ts`; operations in `operations.md`, boundaries in `security.md`. Not a system prompt.

## Process boundary

The trusted Supervisor runs outside bwrap and owns configuration, the document broker, external state, candidate preflight, LKG, Watchdog, sleep, operator control, and Worker lifecycle. It never loads plugins/candidates.

The Worker uses Pi SDK 1.4.0 (`createAgentSession`, `bindExtensions`); `agent_settled` is final idle. `pi-continuity@0.3.1` and `pi-better-web-search@0.1.7` load only in the Worker. IPC is an authenticated Unix socket: one-time token, launchId/generation/session binding, bounded frames. stdout/stderr are logs; production never uses loopback TCP.

## Runtime preflight

`rsi/src/sandbox/preflight.ts` is the single trusted preflight for `rsi --check`, `rsi --start`, the container entrypoint's `deployment-preflight.mjs`, and the bwrap launcher. Each process re-runs it; no cached trusted report, second hand-written probe, or weaker CLI check exists.

It requires Linux, non-setuid bwrap with `--seccomp FD`, and a root Supervisor that can switch to a dedicated non-root Worker host UID/GID through the same `setpriv --reuid --regid --clear-groups` (or `spawn(uid,gid)`) used to launch. The live probe verifies host `/proc/<pid>/status` UID/GID from outside the sandbox, namespace UID/GID, cleared supplementary groups, `CapEff=0`, distinct PID/user/mount namespaces, `/` and proc mounts, UTS hostname, `fs.protected_hardlinks=1`, and `fs.protected_symlinks=1`. Timeout, parse failure, or any mismatch fails closed; no unsandboxed fallback. `--config-only` states that sandbox facts were not verified.

## Paths and state

`/data/markdowns/` holds `Memory.md`, `index.md`, and flat managed `*.md`. `/data/plugins/` is writable but is not an extension loading source. Workspace, tools, workflows, Pi home/sessions, and worker home are writable; Pi/RSI source, manual prompt, markdowns, and operator Pi config are read-only and restart-checked.

Supervisor-owned `/state/` (0700) holds candidates, LKG, control sockets, read statistics, sleep, Watchdog, notices, health, and logs; bwrap hides it with a tmpfs and exposes `/state/run` read-only at `/run/rsi`. The manual prompt is external; missing, empty, symlink, hardlink, or non-regular input fails closed and no prompt is generated. Memory may start empty.

## Worker runtime

`worker-main.ts` builds the Pi Worker and connects IPC, control, heartbeat and shutdown. Deployment defaults to `cline/cline-pass/deepseek-v4.1-flash`; a missing explicit model fails instead of falling back. The external read-only prompt can use `rsi/system-prompt.txt`.

`PiWorker` registers native tools, pinned plugins and `sleep`; `pi_control` is absent. The `pi` shim forwards only MCP commands. Skills use Pi filesystem discovery; after a turn, the Worker previews changes and the Supervisor applies valid Skill/MCP updates.

## Memory and managed knowledge

Memory is capped at 500 words; over-limit writes leave old bytes unchanged and success returns exactly `[System Meta: Current Memory Usage: N / 500 words]`. Every provider request reads authoritative Memory through IPC and writes it into the single leading system message; tool-loop follow-ups see current Memory with the human prompt unchanged.

Only direct `*.md` files under markdowns are managed; nested paths, symlinks, and hardlinks are rejected. Each file is at most 1,000 words; at most 20 include Memory and index. Vendor/Skill docs are excluded. The index has `md名`, `description`, `链接位置` columns and lists itself; mismatches append `[System Meta: Index Warning: ...]`. `read(index.md)` reports words, mtime, and rolling 24-hour reads without changing source bytes/mtime. Writes use revision CAS, staging, and atomic rename.

## Tool decoration

Every finalized top-level result ends with `(Current Time: YYYY/MM/DD HH:mm:ss)`, including errors, blocked/nested calls, images, plugins, web search, sleep, and control. Order: index report, Memory usage, warnings, time. Model-facing content preserves images, `isError`, details, structured content, and usage.

## Reload, health, Watchdog

Reload uses an empty, content-addressed candidate: Agent-written Pi extensions are neither preflighted nor loaded. A legacy snapshot containing extension sources is rejected before Worker launch or restoration. MCP configuration is checked before reload and again before activation; at most five servers are allowed. Static and 3-second Mock subprocesses still run for the empty candidate.

After preflight, `session.reload` loads pinned plugins, Skills and MCP. Three healthy runs promote LKG. Watchdog monitors PID, heartbeats and reload deadlines. LKG does not restore `mcp.json`; invalid MCP can require repair. Unrestricted shell execution can bypass the shim; it is not a command sandbox.

## Sleep, time, commands

Only explicit `sleep` pauses the loop, accepting exactly one relative `duration` (`s`,`m`,`h`) or absolute `until` (`YYYY/MM/DD HH:mm:ss`). Invalid, zero, past, or duplicate forms fail. State is external; Supervisor and Worker share the deadline; heartbeats continue; only the lease suspends.

Time defaults to UTC and accepts IANA zones. `24:00:00` normalizes only with zero minutes/seconds; skipped times fail; ambiguous times choose earlier. Words use NFC; Han/Kana/Hangul letters count individually.

An explicit sleep is the only Agent rest. After `agent_settled`, without sleep or queued/operator/aborted work, the Supervisor sends a factual wake event; duplicate settles and retries do not create parallel prompts. Leading-slash Agent prompts are rejected.

## Commands and acceptance

`cd rsi && npm ci --ignore-scripts`, `npm run check`, `npm run check:types`, `npm run check:plugins`, `node --test test/integration/*.test.ts`. Tests use faux/mock providers and real subprocesses; no real API keys and no Pi monorepo build.

Production entrypoint acceptance: `node scripts/linux-validation.mjs --mode docker --suite entrypoint --image <image> --no-build --timeout-ms 900000 --report <file>`. It uses the image default ENTRYPOINT, real `container-entrypoint.sh`, config rendering, five-document seed, operator-file protection, Supervisor, bwrap, and the real Pi Worker with a local mock provider. The older target suite uses `docker run --entrypoint node` for debugging only, not entrypoint evidence. The 24-hour soak is a separate explicit target command and is never run by CI.
