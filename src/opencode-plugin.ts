import { type Plugin, tool } from "@opencode-ai/plugin";
import { execFileSync } from "child_process";

const target = process.env.CLAWSSH_TARGET;
const remoteCwd = process.env.CLAWSSH_REMOTE_CWD ?? "~";
const sshOpts = process.env.CLAWSSH_SSH_OPTS
  ? JSON.parse(process.env.CLAWSSH_SSH_OPTS)
  : [];
const MAX_BUFFER = 50 * 1024 * 1024;
const SSH_TIMEOUT = 30_000;

let pending = 0;
const MAX_CONCURRENT = 4;

function sq(s: string): string {
  s = s.replace(/\0/g, "");
  if (!s.includes("'")) return "'" + s + "'";
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

async function waitForSlot() {
  while (pending >= MAX_CONCURRENT) {
    await new Promise((r) => setTimeout(r, 50));
  }
  pending++;
}

function releaseSlot() {
  pending--;
}

function ssh(command: string): string {
  const args = [...sshOpts, target!, "--", `bash -c ${sq(command)}`];
  return execFileSync("ssh", args, {
    maxBuffer: MAX_BUFFER,
    timeout: SSH_TIMEOUT,
    encoding: "utf-8",
  }).trim();
}

function sshInput(command: string, input: string): void {
  execFileSync("ssh", [...sshOpts, target!, "--", command], {
    input,
    maxBuffer: MAX_BUFFER,
    timeout: SSH_TIMEOUT,
  });
}

export const ClawSSH: Plugin = async (ctx) => {
  if (!target) return {};

  console.log(`[clawssh] routing tools to ${target} (cwd: ${remoteCwd})`);

  return {
    tool: {
      bash: tool({
        description: "Execute a bash command on the remote machine",
        args: {
          command: tool.schema.string(),
          timeout: tool.schema.number().optional(),
        },
        async execute(args) {
          await waitForSlot();
          try {
            return ssh(`cd ${sq(remoteCwd)} && ${args.command}`);
          } finally {
            releaseSlot();
          }
        },
      }),

      read: tool({
        description: "Read a file from the remote machine",
        args: {
          filePath: tool.schema.string(),
          offset: tool.schema.number().optional(),
          limit: tool.schema.number().optional(),
        },
        async execute(args) {
          await waitForSlot();
          try {
            const p = args.filePath.startsWith("/")
              ? args.filePath
              : `${remoteCwd}/${args.filePath}`;
            if (args.offset || args.limit) {
              const start = (args.offset ?? 0) + 1;
              const count = args.limit ?? 2000;
              return ssh(`sed -n '${start},${start + count - 1}p' ${sq(p)}`);
            }
            return ssh(`cat ${sq(p)}`);
          } finally {
            releaseSlot();
          }
        },
      }),

      write: tool({
        description: "Write a file on the remote machine",
        args: {
          filePath: tool.schema.string(),
          content: tool.schema.string(),
        },
        async execute(args) {
          await waitForSlot();
          try {
            const p = args.filePath.startsWith("/")
              ? args.filePath
              : `${remoteCwd}/${args.filePath}`;
            ssh(`mkdir -p ${sq(p.substring(0, p.lastIndexOf("/")))}`);
            sshInput(`cat > ${sq(p)}`, args.content);
            return `Wrote ${args.content.length} bytes to ${args.filePath}`;
          } finally {
            releaseSlot();
          }
        },
      }),

      edit: tool({
        description: "Edit a file on the remote machine by replacing text",
        args: {
          filePath: tool.schema.string(),
          old: tool.schema.string(),
          new: tool.schema.string(),
        },
        async execute(args) {
          await waitForSlot();
          try {
            const p = args.filePath.startsWith("/")
              ? args.filePath
              : `${remoteCwd}/${args.filePath}`;
            const content = ssh(`cat ${sq(p)}`);
            if (!content.includes(args.old)) {
              throw new Error(`String not found in ${args.filePath}`);
            }
            sshInput(`cat > ${sq(p)}`, content.replace(args.old, args.new));
            return `Edited ${args.filePath}`;
          } finally {
            releaseSlot();
          }
        },
      }),

      grep: tool({
        description: "Search file contents on the remote machine",
        args: {
          pattern: tool.schema.string(),
          path: tool.schema.string().optional(),
          include: tool.schema.string().optional(),
        },
        async execute(args) {
          await waitForSlot();
          try {
            const dir = args.path ?? remoteCwd;
            const inc = args.include ? `--include=${sq(args.include)}` : "";
            return ssh(
              `cd ${sq(remoteCwd)} && grep -rn ${inc} ${sq(args.pattern)} ${
                sq(dir)
              } 2>/dev/null | head -50`,
            );
          } finally {
            releaseSlot();
          }
        },
      }),

      glob: tool({
        description: "Find files by pattern on the remote machine",
        args: {
          pattern: tool.schema.string(),
          path: tool.schema.string().optional(),
        },
        async execute(args) {
          await waitForSlot();
          try {
            const dir = args.path ?? remoteCwd;
            return ssh(
              `cd ${sq(dir)} && find . -name ${
                sq(args.pattern)
              } -type f 2>/dev/null | head -100`,
            );
          } finally {
            releaseSlot();
          }
        },
      }),

      patch: tool({
        description: "Apply a patch to a file on the remote machine",
        args: {
          filePath: tool.schema.string(),
          patch: tool.schema.string(),
        },
        async execute(args) {
          await waitForSlot();
          try {
            const p = args.filePath.startsWith("/")
              ? args.filePath
              : `${remoteCwd}/${args.filePath}`;
            sshInput(`cd ${sq(remoteCwd)} && patch ${sq(p)}`, args.patch);
            return `Patched ${args.filePath}`;
          } finally {
            releaseSlot();
          }
        },
      }),

      list: tool({
        description: "List directory contents on the remote machine",
        args: {
          path: tool.schema.string().optional(),
        },
        async execute(args) {
          await waitForSlot();
          try {
            const dir = args.path ?? remoteCwd;
            const p = dir.startsWith("/") ? dir : `${remoteCwd}/${dir}`;
            return ssh(`ls -la ${sq(p)}`);
          } finally {
            releaseSlot();
          }
        },
      }),
    },
  };
};
