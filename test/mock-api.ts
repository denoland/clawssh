// Mock Anthropic API server for testing clawssh SSH routing.
// Serves a scripted sequence of tool_use calls, logs tool results to a file.

const PORT = parseInt(Deno.env.get("MOCK_PORT") ?? "18923");
const RESULTS_FILE = Deno.env.get("MOCK_RESULTS_FILE") ??
  "/tmp/clawssh-test-results.json";
const READ_PATH = Deno.env.get("MOCK_READ_PATH") ??
  "/tmp/clawssh-test/file.txt";

const toolResults: Record<string, unknown>[] = [];
let step = 0;

const STEPS = [
  // Step 0: Run a bash command that proves it's running over SSH
  {
    id: "msg_0",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-20250514",
    content: [
      {
        type: "tool_use",
        id: "toolu_bash",
        name: "Bash",
        input: { command: "echo CLAWSSH_BASH_OK" },
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  },
  // Step 1: Read a file that exists on the remote
  {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-20250514",
    content: [
      {
        type: "tool_use",
        id: "toolu_read",
        name: "Read",
        input: { file_path: READ_PATH },
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  },
  // Step 2: Done
  {
    id: "msg_2",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-20250514",
    content: [
      { type: "text", text: "DONE" },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  },
];

function streamResponse(response: typeof STEPS[0]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const e = (event: string, data: unknown) =>
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );

      e("message_start", {
        type: "message_start",
        message: { ...response, content: [] },
      });

      for (let idx = 0; idx < response.content.length; idx++) {
        const block = response.content[idx];
        if (block.type === "text") {
          e("content_block_start", {
            type: "content_block_start",
            index: idx,
            content_block: { type: "text", text: "" },
          });
          e("content_block_delta", {
            type: "content_block_delta",
            index: idx,
            delta: { type: "text_delta", text: block.text },
          });
        } else if (block.type === "tool_use") {
          // Must send input via input_json_delta, not in content_block_start
          e("content_block_start", {
            type: "content_block_start",
            index: idx,
            content_block: { type: "tool_use", id: block.id, name: block.name },
          });
          e("content_block_delta", {
            type: "content_block_delta",
            index: idx,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify(block.input),
            },
          });
        } else {
          e("content_block_start", {
            type: "content_block_start",
            index: idx,
            content_block: block,
          });
        }
        e("content_block_stop", { type: "content_block_stop", index: idx });
      }

      e("message_delta", {
        type: "message_delta",
        delta: { stop_reason: response.stop_reason, stop_sequence: null },
        usage: { output_tokens: 10 },
      });
      e("message_stop", { type: "message_stop" });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

Deno.serve({ port: PORT }, async (req: Request) => {
  const url = new URL(req.url);

  if (req.method === "POST" && url.pathname.includes("/messages")) {
    const body = await req.json();

    // Extract tool results from the conversation
    for (const msg of body.messages ?? []) {
      if (msg.role === "user" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_result") {
            toolResults.push({
              tool_use_id: block.tool_use_id,
              content: block.content,
            });
            // Write results after each new tool result
            await Deno.writeTextFile(
              RESULTS_FILE,
              JSON.stringify(toolResults, null, 2),
            );
            console.error(
              `[mock] Got tool result for ${block.tool_use_id}: ${
                JSON.stringify(block.content).slice(0, 200)
              }`,
            );
          }
        }
      }
    }

    const response = STEPS[Math.min(step, STEPS.length - 1)];
    console.error(
      `[mock] step=${step} -> ${
        response.content[0].type === "tool_use"
          ? response.content[0].name
          : "end_turn"
      }`,
    );
    step++;

    return streamResponse(response);
  }

  return new Response("ok");
});

console.error(`[mock] Listening on port ${PORT}`);
