#!/usr/bin/env -S deno run -A

import { dirname, fromFileUrl, join } from "jsr:@std/path";
import OPENCODE_PLUGIN from "./opencode-plugin.ts" with { type: "text" };

// deno-fmt-ignore
const SSH_FLAGS_WITH_ARG = new Set([
  "-B", "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J",
  "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w",
]);

const rawArgs = Deno.args;
const userSshFlags: string[] = [];
let target: string | null = null;

let agentArgsStart = -1;
let agent: "claude" | "opencode" = "claude";
for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === "--opencode") {
    agent = "opencode";
    continue;
  }
  if (!target) {
    if (arg.includes("@") && !arg.startsWith("-")) {
      target = arg;
      agentArgsStart = i + 1;
    } else if (SSH_FLAGS_WITH_ARG.has(arg) && i + 1 < rawArgs.length) {
      userSshFlags.push(arg, rawArgs[++i]);
    } else if (arg.startsWith("-")) {
      userSshFlags.push(arg);
    } else {
      target = `${Deno.env.get("USER") ?? "root"}@${arg}`;
      agentArgsStart = i + 1;
    }
  }
}

if (!target) {
  console.error(
    "Usage: clawssh [--opencode] [ssh-flags...] <user@host> [agent-flags...]",
  );
  console.error("");
  console.error("  clawssh root@192.168.1.10");
  console.error("  clawssh --opencode dev@server");
  console.error("  clawssh -i ~/.ssh/key -p 2222 dev@server --resume");
  console.error("  clawssh -J jumpbox root@internal --model opus");
  Deno.exit(1);
}

const agentArgs = agentArgsStart >= 0
  ? rawArgs.slice(agentArgsStart).filter((a) => a !== "--opencode")
  : [];

const home = Deno.env.get("HOME") ?? "/tmp";
const socketDir = `${home}/.clawssh/sockets`;
await Deno.mkdir(socketDir, { recursive: true, mode: 0o700 });
const sessionId = crypto.randomUUID().slice(0, 8);

const SSH_OPTS = [
  "-o",
  "ControlMaster=auto",
  "-o",
  `ControlPath=${socketDir}/%r@%h:%p-${sessionId}`,
  "-o",
  "ControlPersist=60",
  "-o",
  "StrictHostKeyChecking=accept-new",
  ...userSshFlags,
];

const DIM = "\x1b[90m";
const BOLD = "\x1b[1m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

function killSocket() {
  try {
    new Deno.Command("ssh", {
      args: [...SSH_OPTS, "-O", "exit", target!],
      stdout: "null",
      stderr: "null",
    }).outputSync();
  } catch { /* */ }
}

console.error(`${DIM}[clawssh] Connecting to ${target}...${RESET}`);

// Two-step: first establish connection (interactive, can prompt for password),
// then get the remote cwd over the now-authenticated ControlMaster socket.
const sshAuth = new Deno.Command("ssh", {
  args: [...SSH_OPTS, target, "true"],
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).spawn();

if (!(await sshAuth.status).success) {
  console.error(`[clawssh] Failed to connect to ${target}`);
  Deno.exit(1);
}

// ControlMaster is now established — no more password prompts
const cwdResult = await new Deno.Command("ssh", {
  args: [...SSH_OPTS, target, "--", "pwd"],
  stdout: "piped",
  stderr: "piped",
}).output();

if (!cwdResult.success) {
  console.error(`[clawssh] Failed to get remote cwd`);
  Deno.exit(1);
}

const remoteCwd = new TextDecoder().decode(cwdResult.stdout).trim();
console.error(`${DIM}[clawssh] Connected — remote cwd: ${remoteCwd}${RESET}`);

async function launchClaude(): Promise<Deno.ChildProcess> {
  const cliPath = await findClaudeCliJs();
  const nodePath = await findNode();
  console.error(`${DIM}[clawssh] Using Claude Code from ${cliPath}${RESET}`);

  const patchPath = join(dirname(fromFileUrl(import.meta.url)), "patch.cjs");
  const existingNodeOpts = Deno.env.get("NODE_OPTIONS") ?? "";

  return new Deno.Command(nodePath, {
    args: [cliPath, ...agentArgs],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...Deno.env.toObject(),
      CLAWSSH_TARGET: target!,
      CLAWSSH_REMOTE_CWD: remoteCwd,
      CLAWSSH_SSH_OPTS: JSON.stringify(SSH_OPTS),
      NODE_OPTIONS: `--require=${patchPath} ${existingNodeOpts}`.trim(),
      DISABLE_AUTOUPDATER: "1",
    },
  }).spawn();
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function getNpmGlobalCliPath(): Promise<string | null> {
  try {
    const out = await new Deno.Command("npm", {
      args: ["root", "-g"],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (out.success) {
      const p = `${
        new TextDecoder().decode(out.stdout).trim()
      }/@anthropic-ai/claude-code/cli.js`;
      if (await fileExists(p)) return p;
    }
  } catch { /* */ }
  return null;
}

async function findClaudeCliJs(): Promise<string> {
  const envPath = Deno.env.get("CLAWSSH_CLAUDE_PATH");
  if (envPath) return envPath;

  const npmPath = await getNpmGlobalCliPath();
  if (npmPath) return npmPath;

  for (
    const p of [
      `${home}/.npm-packages/lib/node_modules/@anthropic-ai/claude-code/cli.js`,
      `/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js`,
    ]
  ) {
    if (await fileExists(p)) return p;
  }

  // No compatible installation found — auto-install via npm
  console.error(
    `${BOLD}${YELLOW}[clawssh] No compatible Claude Code installation found${RESET}`,
  );
  console.error(
    `${DIM}clawssh requires the npm installation (Homebrew/Deno/native builds are not compatible)${RESET}`,
  );
  console.error(`\nInstalling via npm...`);
  try {
    const install = await new Deno.Command("npm", {
      args: ["install", "-g", "@anthropic-ai/claude-code"],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    if (install.success) {
      const installed = await getNpmGlobalCliPath();
      if (installed) {
        console.error(`${DIM}[clawssh] Installed successfully${RESET}\n`);
        return installed;
      }
    }
  } catch { /* */ }
  console.error(
    `\n${BOLD}${YELLOW}npm install failed.${RESET} Install manually:\n`,
  );
  console.error(`  ${CYAN}npm install -g @anthropic-ai/claude-code${RESET}\n`);
  console.error(
    `Or set ${BOLD}CLAWSSH_CLAUDE_PATH${RESET} to the path of cli.js manually.`,
  );
  Deno.exit(1);
}

async function findNode(): Promise<string> {
  const envPath = Deno.env.get("CLAWSSH_NODE_PATH");
  if (envPath) return envPath;
  for (
    const p of [
      "/usr/local/bin/node",
      "/opt/homebrew/bin/node",
      "/usr/bin/node",
    ]
  ) {
    if (await fileExists(p)) return p;
  }
  try {
    if (
      (await new Deno.Command("node", {
        args: ["--version"],
        stdout: "null",
        stderr: "null",
      }).output()).success
    ) return "node";
  } catch { /* */ }
  console.error("[clawssh] Node.js required. Set CLAWSSH_NODE_PATH.");
  Deno.exit(1);
}

async function launchOpencode(): Promise<Deno.ChildProcess> {
  const pluginDir = `${home}/.config/opencode/plugins`;
  await Deno.mkdir(pluginDir, { recursive: true });
  await Deno.writeTextFile(`${pluginDir}/clawssh.ts`, OPENCODE_PLUGIN);
  console.error(`${DIM}[clawssh] Installed opencode plugin${RESET}`);

  return new Deno.Command("opencode", {
    args: agentArgs,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...Deno.env.toObject(),
      CLAWSSH_TARGET: target!,
      CLAWSSH_REMOTE_CWD: remoteCwd,
      CLAWSSH_SSH_OPTS: JSON.stringify(SSH_OPTS),
    },
  }).spawn();
}

console.error(`${DIM}[clawssh] Launching ${agent}...${RESET}`);

const child = agent === "opencode"
  ? await launchOpencode()
  : await launchClaude();

Deno.addSignalListener("SIGINT", () => {
  killSocket();
  Deno.exit(130);
});

const status = await child.status;
killSocket();
console.error(`${DIM}[clawssh] Session ended.${RESET}`);
Deno.exit(status.code);
