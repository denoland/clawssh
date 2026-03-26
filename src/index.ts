#!/usr/bin/env -S deno run -A

/**
 * clawssh — Run Claude Code on remote machines via SSH.
 *
 * Injects a patch via NODE_OPTIONS=--require that intercepts child_process.spawn
 * in Claude Code AND its worker threads, routing commands to the remote machine.
 * Native TUI is fully preserved.
 *
 * Usage: clawssh [ssh-flags...] user@host [claude-flags...] [prompt]
 */

import { dirname, fromFileUrl, join } from "jsr:@std/path";

const SSH_FLAGS_WITH_ARG = new Set([
  "-B", "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J",
  "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w",
]);

const rawArgs = Deno.args;
const userSshFlags: string[] = [];
let target: string | null = null;
let claudeArgsStart = -1;

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (!target) {
    if (arg.includes("@") && !arg.startsWith("-")) {
      target = arg;
      claudeArgsStart = i + 1;
    } else if (SSH_FLAGS_WITH_ARG.has(arg) && i + 1 < rawArgs.length) {
      userSshFlags.push(arg, rawArgs[++i]);
    } else if (arg.startsWith("-")) {
      userSshFlags.push(arg);
    } else {
      target = `${Deno.env.get("USER") ?? "root"}@${arg}`;
      claudeArgsStart = i + 1;
    }
  }
}

if (!target) {
  console.error("Usage: clawssh [ssh-flags...] <user@host> [claude-flags...] [prompt]");
  console.error("");
  console.error("  clawssh root@192.168.1.10");
  console.error("  clawssh -i ~/.ssh/key -p 2222 dev@server --resume");
  console.error("  clawssh -J jumpbox root@internal --model opus");
  Deno.exit(1);
}

const claudeArgs = claudeArgsStart >= 0 ? rawArgs.slice(claudeArgsStart) : [];

const SSH_OPTS = [
  "-o", "ControlMaster=auto",
  "-o", "ControlPath=/tmp/clawssh-%r@%h:%p",
  "-o", "ControlPersist=60",
  "-o", "StrictHostKeyChecking=accept-new",
  ...userSshFlags,
];

const DIM = "\x1b[90m";
const RESET = "\x1b[0m";

// Connect and get remote home dir
console.error(`${DIM}[clawssh] Connecting to ${target}...${RESET}`);

const sshTest = new Deno.Command("ssh", {
  args: [...SSH_OPTS, target, "--", "pwd"],
  stdout: "piped",
  stderr: "piped",
});
const sshResult = await sshTest.output();

if (!sshResult.success) {
  console.error(`[clawssh] Failed to connect to ${target}`);
  console.error(new TextDecoder().decode(sshResult.stderr));
  Deno.exit(1);
}

const remoteCwd = new TextDecoder().decode(sshResult.stdout).trim();
console.error(`${DIM}[clawssh] Connected — remote cwd: ${remoteCwd}${RESET}`);

async function findClaudeCliJs(): Promise<string | null> {
  // Check env override
  const envPath = Deno.env.get("CLAWSSH_CLAUDE_PATH");
  if (envPath) return envPath;

  // npm global
  try {
    const cmd = new Deno.Command("npm", { args: ["root", "-g"], stdout: "piped", stderr: "null" });
    const out = await cmd.output();
    if (out.success) {
      const root = new TextDecoder().decode(out.stdout).trim();
      const p = `${root}/@anthropic-ai/claude-code/cli.js`;
      try { await Deno.stat(p); return p; } catch { /* continue */ }
    }
  } catch { /* continue */ }

  // Common locations
  const home = Deno.env.get("HOME") ?? "~";
  const locations = [
    `${home}/.npm-packages/lib/node_modules/@anthropic-ai/claude-code/cli.js`,
    `/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js`,
    `/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js`,
  ];
  for (const p of locations) {
    try { await Deno.stat(p); return p; } catch { /* continue */ }
  }

  return null;
}

async function findNode(): Promise<string> {
  for (const name of ["node", "nodejs"]) {
    try {
      const cmd = new Deno.Command("which", { args: [name], stdout: "piped", stderr: "null" });
      const out = await cmd.output();
      if (out.success) return new TextDecoder().decode(out.stdout).trim();
    } catch { /* continue */ }
  }
  console.error("[clawssh] Node.js is required");
  Deno.exit(1);
}

const cliPath = await findClaudeCliJs();
if (!cliPath) {
  console.error("[clawssh] Could not find Claude Code cli.js");
  console.error("Install via: npm install -g @anthropic-ai/claude-code");
  Deno.exit(1);
}

const nodePath = await findNode();
console.error(`${DIM}[clawssh] Using Claude Code from ${cliPath}${RESET}`);

const patchPath = join(dirname(fromFileUrl(import.meta.url)), "patch.cjs");

// Build NODE_OPTIONS: prepend our --require to any existing NODE_OPTIONS
const existingNodeOpts = Deno.env.get("NODE_OPTIONS") ?? "";
const nodeOptions = `--require=${patchPath} ${existingNodeOpts}`.trim();

const child = new Deno.Command(nodePath, {
  args: [cliPath, ...claudeArgs],
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...Object.fromEntries(
      Object.entries(Deno.env.toObject()),
    ),
    // Pass config to the patch via env vars
    CLAWSSH_TARGET: target,
    CLAWSSH_REMOTE_CWD: remoteCwd,
    CLAWSSH_SSH_OPTS: JSON.stringify(SSH_OPTS),
    NODE_OPTIONS: nodeOptions,
    // Disable autoupdater
    DISABLE_AUTOUPDATER: "1",
  },
}).spawn();

const status = await child.status;
console.error(`${DIM}[clawssh] Session ended.${RESET}`);
Deno.exit(status.code);
