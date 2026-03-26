# clawssh

Run Claude Code on remote machines over SSH. Full native TUI, zero
installation on the remote — just SSH access.

```
clawssh root@192.168.1.10
clawssh -i ~/.ssh/key -p 2222 dev@myserver
clawssh -J jumpbox root@internal --model opus
```

## How it works

`clawssh` injects a tiny patch into Claude Code's Node.js runtime via
`NODE_OPTIONS=--require`. The patch intercepts `child_process.spawn` —
the function Claude uses to execute Bash tool commands — and rewrites
each call to run over SSH on the remote machine instead.

Native TUI is fully preserved. Claude doesn't know it's remote.

1. **SSH connection** — Connects to the target, detects remote home
   directory, sets up ControlMaster for connection reuse.

2. **Spawn interception** — Injected into Claude's main process AND
   worker threads (where the Bash tool actually runs). Every non-local
   command gets wrapped in `ssh target -- bash -c 'cd /remote/cwd && command'`.

3. **Shell cleanup** — Strips Claude's local shell-snapshot sourcing
   and CWD-tracking before sending commands to the remote.

4. **Local passthrough** — Commands like `git`, `ssh`, `node`, `security`
   (macOS keychain) stay local so auth and Claude internals keep working.

## Install

```
deno install -A --global --name clawssh src/index.ts
```

Requires Deno and Node.js (for Claude Code's cli.js). The remote
machine needs nothing — just an SSH server.

## Usage

```
clawssh [ssh-flags...] <user@host> [claude-flags...] [prompt]
```

SSH flags go before the target, Claude flags go after:

```
clawssh root@192.168.1.10                        # interactive session
clawssh -p 2222 dev@server                       # custom SSH port
clawssh -i ~/.ssh/key root@box --resume          # SSH key + resume session
clawssh -J jumpbox root@internal --model opus    # jump host + model choice
clawssh root@server -c                           # continue last session
```

## What runs where

**Remote (via SSH):**
All Bash tool commands — `ls`, `cat`, `grep`, `find`, `systemctl`,
`docker ps`, `nginx -t`, anything Claude decides to run.

**Local (passthrough):**
`git`, `ssh`, `node`, `npm`, `deno`, `security` (macOS keychain),
`which`, `pbcopy`/`pbpaste`, Claude's own internals.

## How the patch works

Claude Code's Bash tool parses commands and calls `child_process.spawn`
directly (e.g., `spawn("system_profiler", ["SPHardwareDataType"])`),
and this happens inside a **worker thread**. Regular monkey-patching
of the main process doesn't reach workers.

The fix: `NODE_OPTIONS=--require=patch.cjs` injects the patch into
every Node.js context — main thread and all workers. The patch uses
`Object.defineProperty` with a getter on `child_process.spawn` to
ensure interception survives bundler captures and module caching.

```
clawssh (Deno)
├── Connects to remote via SSH, detects home dir
├── Finds Claude Code's cli.js (npm global install)
├── Sets NODE_OPTIONS=--require=patch.cjs
├── Sets CLAWSSH_TARGET, CLAWSSH_REMOTE_CWD, CLAWSSH_SSH_OPTS
└── Spawns: node cli.js [claude-args...]
    ├── stdio: inherit (native TUI)
    └── patch.cjs loaded in main + workers
        └── child_process.spawn → ssh target -- bash -c 'command'
```

## Environment variables

```
CLAWSSH_CLAUDE_PATH    Override path to Claude Code's cli.js
CLAWSSH_DEBUG=1        Log all intercepted spawn calls to stderr
```

## Limitations

- **File tools** (Read, Write, Edit, Glob, Grep) still operate on the
  local filesystem. Only Bash tool commands are routed to the remote.
  For full file interception, the local and remote home directories
  must not overlap (e.g., local `/Users/divy` vs remote `/root`).

- Requires the npm-installed Claude Code (`cli.js`). The native binary
  (`~/.local/bin/claude`) can't be patched this way.

## License

MIT
