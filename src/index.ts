#!/usr/bin/env -S deno run -A

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

const home = Deno.env.get("HOME") ?? "/tmp";
const socketDir = `${home}/.clawssh/sockets`;
await Deno.mkdir(socketDir, { recursive: true, mode: 0o700 });
const sessionId = crypto.randomUUID().slice(0, 8);
const controlPath = `${socketDir}/%r@%h:%p-${sessionId}`;

const SSH_OPTS = [
  "-o", `ControlMaster=auto`,
  "-o", `ControlPath=${controlPath}`,
  "-o", "ControlPersist=60",
  "-o", "StrictHostKeyChecking=accept-new",
  ...userSshFlags,
];

const DIM = "\x1b[90m";
const RESET = "\x1b[0m";

function killSocket() {
  try { new Deno.Command("ssh", { args: [...SSH_OPTS, "-O", "exit", target!], stdout: "null", stderr: "null" }).outputSync(); } catch { /* */ }
}

console.error(`${DIM}[clawssh] Connecting to ${target}...${RESET}`);

const sshResult = await new Deno.Command("ssh", {
  args: [...SSH_OPTS, target, "--", "pwd"],
  stdout: "piped",
  stderr: "piped",
}).output();

if (!sshResult.success) {
  console.error(`[clawssh] Failed to connect to ${target}`);
  console.error(new TextDecoder().decode(sshResult.stderr));
  Deno.exit(1);
}

const remoteCwd = new TextDecoder().decode(sshResult.stdout).trim();
console.error(`${DIM}[clawssh] Connected — remote cwd: ${remoteCwd}${RESET}`);

async function findClaudeCliJs(): Promise<string> {
  const envPath = Deno.env.get("CLAWSSH_CLAUDE_PATH");
  if (envPath) return envPath;

  for (const p of [
    `${home}/.npm-packages/lib/node_modules/@anthropic-ai/claude-code/cli.js`,
    `/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js`,
    `/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js`,
  ]) {
    try { await Deno.stat(p); return p; } catch { /* */ }
  }

  try {
    const out = await new Deno.Command("npm", { args: ["root", "-g"], stdout: "piped", stderr: "null" }).output();
    if (out.success) {
      const p = `${new TextDecoder().decode(out.stdout).trim()}/@anthropic-ai/claude-code/cli.js`;
      try { await Deno.stat(p); return p; } catch { /* */ }
    }
  } catch { /* */ }

  console.error("[clawssh] Could not find Claude Code cli.js");
  console.error("Set CLAWSSH_CLAUDE_PATH or: npm install -g @anthropic-ai/claude-code");
  Deno.exit(1);
}

async function findNode(): Promise<string> {
  const envPath = Deno.env.get("CLAWSSH_NODE_PATH");
  if (envPath) return envPath;
  for (const p of ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"]) {
    try { await Deno.stat(p); return p; } catch { /* */ }
  }
  try {
    if ((await new Deno.Command("node", { args: ["--version"], stdout: "null", stderr: "null" }).output()).success) return "node";
  } catch { /* */ }
  console.error("[clawssh] Node.js required. Set CLAWSSH_NODE_PATH.");
  Deno.exit(1);
}

const cliPath = await findClaudeCliJs();
const nodePath = await findNode();
console.error(`${DIM}[clawssh] Using Claude Code from ${cliPath}${RESET}`);

const patchPath = join(dirname(fromFileUrl(import.meta.url)), "patch.cjs");
const existingNodeOpts = Deno.env.get("NODE_OPTIONS") ?? "";

const child = new Deno.Command(nodePath, {
  args: [cliPath, ...claudeArgs],
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...Deno.env.toObject(),
    CLAWSSH_TARGET: target,
    CLAWSSH_REMOTE_CWD: remoteCwd,
    CLAWSSH_SSH_OPTS: JSON.stringify(SSH_OPTS),
    NODE_OPTIONS: `--require=${patchPath} ${existingNodeOpts}`.trim(),
    DISABLE_AUTOUPDATER: "1",
  },
}).spawn();

Deno.addSignalListener("SIGINT", () => { killSocket(); Deno.exit(130); });

const status = await child.status;
killSocket();
console.error(`${DIM}[clawssh] Session ended.${RESET}`);
Deno.exit(status.code);
