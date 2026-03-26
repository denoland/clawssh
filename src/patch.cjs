const target = process.env.CLAWSSH_TARGET;
const remoteCwd = process.env.CLAWSSH_REMOTE_CWD;
const sshOptsJson = process.env.CLAWSSH_SSH_OPTS;

// Only activate if env vars are set
if (!target || !remoteCwd || !sshOptsJson) return;

const SSH_OPTS = JSON.parse(sshOptsJson);

const childProcess = require('node:child_process');
const path = require('node:path');

function shellQuote(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Commands that must run locally
const LOCAL_COMMANDS = new Set([
  'ssh', 'scp', 'node', 'npm', 'which', 'where', 'git', 'deno',
  'security', 'open', 'pbcopy', 'pbpaste', 'osascript',
  // claude internals
  'claude', 'bun', 'pnpm', 'yarn',
]);

function isLocalCommand(command) {
  if (!command) return true;
  return LOCAL_COMMANDS.has(path.basename(String(command)));
}

function argsToShellCommand(command, args) {
  const parts = [String(command)];
  if (Array.isArray(args)) {
    for (const a of args) {
      const s = String(a);
      if (/^[a-zA-Z0-9_.\/=:@%^+,-]+$/.test(s)) parts.push(s);
      else parts.push(shellQuote(s));
    }
  }
  return parts.join(' ');
}

function wrapForRemote(userCommand) {
  return {
    command: 'ssh',
    args: [...SSH_OPTS, target, '--', 'bash', '--norc', '--noprofile', '-c', shellQuote(`cd ${remoteCwd} && ${userCommand}`)],
  };
}

const originalSpawn = childProcess.spawn;

function patchedSpawn(command, spawnArgs, options) {
  const cmd = path.basename(String(command));

  // Intercept shell -c "..." — Claude's Bash tool does:
  //   zsh -c "source ~/.claude/shell-snapshots/... ; actual_command"
  // We extract the actual command and run it on remote without the shell snapshot.
  if ((cmd === 'bash' || cmd === 'zsh' || cmd === 'sh') &&
      Array.isArray(spawnArgs) && spawnArgs.includes('-c')) {
    const cIdx = spawnArgs.indexOf('-c');
    const shellCmd = spawnArgs[cIdx + 1];
    if (typeof shellCmd === 'string') {
      // Strip Claude's shell-snapshot sourcing and cwd-tracking
      const cleaned = shellCmd
        .replace(/source\s+[^\s;]*shell-snapshots[^\s;]*\s*;?\s*/g, '')
        .replace(/;\s*echo\s+\$PWD\s*>\s*[^\s;]*/g, '')
        .trim();
      if (cleaned) {
        const remote = wrapForRemote(cleaned);
        if (process.env.CLAWSSH_DEBUG) {
          process.stderr.write(`\x1b[33m[clawssh:shell] ${cleaned.slice(0, 100)}\x1b[0m\n`);
        }
        return originalSpawn.call(this, remote.command, remote.args, options);
      }
    }
  }

  // Intercept direct commands (e.g. spawn("system_profiler", ["SPHardwareDataType"]))
  if (!isLocalCommand(command)) {
    const fullCmd = argsToShellCommand(command, spawnArgs);
    const remote = wrapForRemote(fullCmd);
    if (process.env.CLAWSSH_DEBUG) {
      process.stderr.write(`\x1b[33m[clawssh:spawn] ${fullCmd.slice(0, 100)}\x1b[0m\n`);
    }
    return originalSpawn.call(this, remote.command, remote.args, options);
  }

  return originalSpawn.call(this, command, spawnArgs, options);
}

Object.keys(originalSpawn).forEach(key => {
  Object.defineProperty(patchedSpawn, key, {
    value: originalSpawn[key], writable: true, configurable: true,
  });
});

Object.defineProperty(childProcess, 'spawn', {
  get() { return patchedSpawn; },
  set() {},
  configurable: true,
});

const originalSpawnSync = childProcess.spawnSync;

function patchedSpawnSync(command, spawnArgs, options) {
  if (!isLocalCommand(command)) {
    const fullCmd = argsToShellCommand(command, spawnArgs);
    const remote = wrapForRemote(fullCmd);
    return originalSpawnSync.call(this, remote.command, remote.args, options);
  }
  return originalSpawnSync.call(this, command, spawnArgs, options);
}

Object.defineProperty(childProcess, 'spawnSync', {
  get() { return patchedSpawnSync; },
  set() {},
  configurable: true,
});

const originalCwd = process.cwd;
process.cwd = function() {
  return remoteCwd;
};
