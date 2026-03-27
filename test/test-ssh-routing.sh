#!/usr/bin/env bash
set -euo pipefail

# Test that clawssh routes Bash and Read tool calls through SSH.
# Requires: SSH to localhost working (ssh localhost true), deno, node, claude-code installed.

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DIR")"

MOCK_PORT=18923
RESULTS_FILE="/tmp/clawssh-test-results.json"
REMOTE_DIR="/tmp/clawssh-test-$$"
MARKER="CLAWSSH_FILE_CONTENT_$(date +%s)"

cleanup() {
  kill "$MOCK_PID" 2>/dev/null || true
  wait "$MOCK_PID" 2>/dev/null || true
  rm -rf "$REMOTE_DIR" "$RESULTS_FILE"
}
trap cleanup EXIT

echo "==> Setting up test file on remote (localhost)..."
ssh localhost "mkdir -p $REMOTE_DIR && echo $MARKER > $REMOTE_DIR/testfile.txt"

echo "==> Starting mock API server..."
MOCK_PORT=$MOCK_PORT \
  MOCK_RESULTS_FILE="$RESULTS_FILE" \
  MOCK_READ_PATH="$REMOTE_DIR/testfile.txt" \
  deno run -A "$DIR/mock-api.ts" 2>/tmp/clawssh-mock.log &
MOCK_PID=$!
sleep 1

if ! kill -0 "$MOCK_PID" 2>/dev/null; then
  echo "FAIL: Mock server didn't start"
  cat /tmp/clawssh-mock.log
  exit 1
fi

echo "==> Running clawssh against localhost with mock API..."
CLAWSSH_DEBUG=1 \
  ANTHROPIC_BASE_URL="http://localhost:$MOCK_PORT" \
  ANTHROPIC_API_KEY="fake-key" \
  deno run -A "$ROOT/src/index.ts" localhost --print -p "test" --max-turns 3 --dangerously-skip-permissions \
  > /tmp/clawssh-test-stdout.log 2>/tmp/clawssh-test-stderr.log || true

echo "==> Mock server log:"
cat /tmp/clawssh-mock.log

echo ""
echo "==> Checking results..."

if [ ! -f "$RESULTS_FILE" ]; then
  echo "FAIL: No tool results captured"
  echo "--- stdout ---"
  cat /tmp/clawssh-test-stdout.log
  echo "--- stderr ---"
  cat /tmp/clawssh-test-stderr.log
  exit 1
fi

echo "Tool results:"
cat "$RESULTS_FILE"
echo ""

# Check Bash result: should contain CLAWSSH_BASH_OK (proves command ran)
# and SSH_CONN= with a value (proves it went through SSH)
BASH_RESULT=$(cat "$RESULTS_FILE")

if echo "$BASH_RESULT" | grep -q "CLAWSSH_BASH_OK"; then
  echo "PASS: Bash tool executed successfully"
else
  echo "FAIL: Bash tool result missing CLAWSSH_BASH_OK"
  exit 1
fi

# Check Read result: should contain our marker
if echo "$BASH_RESULT" | grep -q "$MARKER"; then
  echo "PASS: Read tool returned correct file content over SSH"
else
  echo "FAIL: Read tool result missing marker '$MARKER'"
  exit 1
fi

echo ""
echo "All tests passed!"
