#!/bin/bash
# Samočinná zkouška celé appky bez obrazovky (Linux, Xvfb):
# zásobník -> dva klipy -> screenshoty oken. Vypíše KINE_TEST_RESULT.
set -e
cd "$(dirname "$0")/.."
OUT=${KINE_TEST_OUT:-/tmp/kine-test-out}
rm -rf "$OUT"; mkdir -p "$OUT"
KINE_TEST=1 KINE_DEBUG=1 KINE_TEST_OUT="$OUT" KINE_USER_DATA="${KINE_USER_DATA:-/tmp/kine-test-userdata}" \
  KINE_TEST_WAIT_MS="${KINE_TEST_WAIT_MS:-9000}" KINE_TEST_CLIP_SECONDS="${KINE_TEST_CLIP_SECONDS:-6}" \
  timeout 120 xvfb-run -a -s "-screen 0 1280x800x24" node_modules/electron/dist/electron --no-sandbox . 2>&1 \
  | grep -E "^20|KINE_TEST_RESULT" | grep -v OpenH264
