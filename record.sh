#!/bin/bash
# Repeatable demo recording: drive the click path (with optional per-step
# narration) against the logged-in Chrome tab, capturing the page's own
# rendering via CDP screenshots (immune to other windows covering the
# screen — no OS screen recording, no Screen Recording permission, no
# window-position math), then assemble the frames and mux narration audio.
set -e
cd "$(dirname "$0")"
if [ -z "$1" ]; then
  echo "Usage: ./record.sh <flow.json>  (e.g. ./record.sh flows/examples/cloudflare-domains.json)" >&2
  exit 1
fi
FLOW="$1"
mkdir -p videos
BASE="$(basename "$FLOW" .json)-$(date +%Y%m%d-%H%M%S)"
RAW="videos/.raw-$BASE.mov"
OUT="videos/$BASE.mov"
WORK_DIR=$(mktemp -d)
NARRATION_LOG="$WORK_DIR/events.json"
NARRATION_PLAN="$WORK_DIR/plan.json"
SLIDES_PLAN="$WORK_DIR/slides.json"
FRAMES_DIR="$WORK_DIR/frames"
FRAMES_MANIFEST="$WORK_DIR/frames.json"

# Synthesize all narration audio (steps + intro/outro slides) and resolve
# any AI-generated slide content up front — `say`/ffprobe/AI calls are slow
# and variable under load, and running them *during* the recording was
# stealing CPU and throwing off step timing.
SLIDES_PLAN="$SLIDES_PLAN" node src/synthesize-narration.js "$FLOW" "$WORK_DIR"

START_MS=$(node -e 'console.log(Date.now())')
START_MS="$START_MS" NARRATION_LOG="$NARRATION_LOG" NARRATION_PLAN="$NARRATION_PLAN" \
  SLIDES_PLAN="$SLIDES_PLAN" FRAMES_DIR="$FRAMES_DIR" FRAMES_MANIFEST="$FRAMES_MANIFEST" \
  node src/click-flow.js "$FLOW"

node src/assemble-video.js "$FRAMES_MANIFEST" "$RAW"

EVENT_COUNT=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1])).length)" "$NARRATION_LOG")
if [ "$EVENT_COUNT" -gt 0 ]; then
  node src/mux-narration.js "$RAW" "$NARRATION_LOG" "$OUT"
  rm -f "$RAW"
else
  mv "$RAW" "$OUT"
fi
rm -rf "$WORK_DIR"
echo "Saved $OUT"
