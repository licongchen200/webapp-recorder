// Overlays each per-step narration clip onto the silent screen recording at
// the recorded timestamp, then muxes the result. Clips don't overlap in
// time (one step narrates at a time) so amix's normalize=0 keeps each clip
// at full volume instead of dividing it by the input count.
const { execFileSync } = require('child_process');
const fs = require('fs');

// padSec > 0 also pads the video by holding its last frame, in the same
// graph — mixing a -vf with -filter_complex is asking for trouble.
function buildFilterComplex(events, padSec = 0) {
  const delayed = events.map((e, i) => {
    const ms = Math.round(e.offsetSec * 1000);
    return `[${i + 1}:a]adelay=delays=${ms}:all=1[a${i}]`;
  });
  const mixLabels = events.map((_, i) => `[a${i}]`).join('');
  const audio = `${delayed.join(';')};${mixLabels}amix=inputs=${events.length}:duration=longest:normalize=0[aout]`;
  if (padSec > 0) {
    return `[0:v]tpad=stop_mode=clone:stop_duration=${padSec.toFixed(3)}[vout];${audio}`;
  }
  return audio;
}

// When the last narration ends, in seconds.
function audioEndSec(events) {
  return events.reduce((max, e) => Math.max(max, e.offsetSec + e.durationSec), 0);
}

function probeDurationSec(file) {
  return parseFloat(execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ], { encoding: 'utf8' }).trim());
}

function main() {
  const [, , videoPath, narrationLogPath, outPath] = process.argv;
  const events = JSON.parse(fs.readFileSync(narrationLogPath, 'utf8'));

  // -shortest would silently clip a narration that outruns the recording —
  // you'd get a video that simply stops mid-sentence with no warning. If the
  // audio really is longer, hold the last frame to cover it instead. Normally
  // the per-step holds already prevent this, so this path is a safety net.
  const videoSec = probeDurationSec(videoPath);
  const overrunSec = audioEndSec(events) - videoSec;
  const needsPad = overrunSec > 0.05;

  const args = ['-y', '-i', videoPath];
  for (const e of events) args.push('-i', e.file);

  const padSec = needsPad ? overrunSec + 0.3 : 0;
  args.push('-filter_complex', buildFilterComplex(events, padSec));
  if (needsPad) {
    console.warn(
      `narration runs ${overrunSec.toFixed(2)}s past the recording — `
      + 'holding the last frame to cover it (re-encoding video)',
    );
    args.push('-map', '[vout]', '-map', '[aout]', '-pix_fmt', 'yuv420p');
  } else {
    // Nothing to fix — keep the fast path, no video re-encode.
    args.push('-map', '0:v:0', '-map', '[aout]', '-c:v', 'copy');
  }
  args.push('-c:a', 'aac', outPath);

  execFileSync('ffmpeg', args, { stdio: 'inherit' });
}

if (require.main === module) {
  main();
}

module.exports = { buildFilterComplex, audioEndSec };
