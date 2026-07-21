#!/usr/bin/env bash
# memory-debug.sh — bounded memory-leak hunt for camera-overlay.
#
# Usage:
#   ./scripts/memory-debug.sh [seconds_per_phase] [port]
#   timeout 300 ./scripts/memory-debug.sh        # hard-bound the whole run
#
# What it does:
#   1. Builds and launches camera-overlay (debug build = symbols for profilers).
#   2. Presses /start, samples VmRSS with no clients (capture-path growth?).
#   3. Attaches one /stream client (simulates OBS), keeps sampling.
#   4. Stops stream + camera, samples to see whether RSS recovers.
#   5. Prints how to interpret the curve and the profiler commands for step 2.
set -u

DUR="${1:-30}"     # seconds sampled per phase
PORT="${2:-8080}"  # must match the port in ~/.config/camera-overlay/config.json
BASE="http://127.0.0.1:$PORT"
BIN="./target/debug/camera-overlay"

cd "$(dirname "$0")/.." || exit 1
cargo build || exit 1

# timeout guarantees the server dies even if this script is killed early.
timeout --signal=SIGINT $((3 * DUR + 90)) env RUST_LOG=info "$BIN" &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT

rss() { awk '/VmRSS/{print $2" kB"}' "/proc/$PID/status" 2>/dev/null || echo "gone"; }

sample() { # $1=label  $2=seconds
    local label="$1" end=$((SECONDS + $2))
    while [ "$SECONDS" -lt "$end" ]; do
        sleep 2
        printf '%s  %-14s %s\n' "$(date +%T)" "$label" "$(rss)"
    done
}

sleep 1
echo "== baseline (camera off, no clients) =="
sample baseline 6

echo
echo "== phase 1: POST /start, NO stream clients =="
if ! curl -sf -X POST "$BASE/start" > /dev/null; then
    echo "   (start failed — is a camera attached? phases below will stay flat)"
fi
sample capture-only "$DUR"
echo "   -> RSS climbing HERE means the capture path itself grows (nokhwa/V4L2)."

echo
echo "== phase 2: one /stream client attached (like an OBS Browser Source) =="
timeout $((DUR + 10)) curl -sN "$BASE/stream" -o /dev/null &
CURL_PID=$!
sample streaming "$DUR"
kill "$CURL_PID" 2>/dev/null
echo "   -> RSS climbing ONLY here points at per-client serving churn, or the"
echo "      client side (Chromium/OBS CEF caches decoded MJPEG frames)."

echo
echo "== phase 3: POST /stop, watch whether RSS settles =="
curl -sf -X POST "$BASE/stop" > /dev/null
sample stopped 10
echo "   -> glibc malloc rarely returns memory instantly, so flat-after-stop is"
echo "      normal. Growth that continues AFTER stop is a real leak."

echo
echo "== next step: prove true leak vs allocator retention =="
echo "heaptrack:  timeout --signal=SIGINT 180 heaptrack $BIN"
echo "            heaptrack_print heaptrack.camera-overlay.*.zst | less   # 'leaked' section"
echo "massif:     timeout --signal=SIGINT 180 valgrind --tool=massif $BIN"
echo "            ms_print massif.out.* | less                            # heap over time"
echo "memcheck:   timeout --signal=SIGINT 120 valgrind --tool=memcheck --leak-check=full $BIN"
echo "status API: watch -n2 curl -s $BASE/status    # includes memory_rss_kb"
