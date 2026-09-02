// Builds a video from the per-frame screenshots captured during the flow,
// using each frame's *actual* recorded duration (not an assumed framerate)
// so the video's real length always matches how long the flow actually took.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// ffmpeg's concat demuxer ignores the last entry's "duration" unless the
// file is repeated once more after it — hence the trailing duplicate line.
function buildConcatLines(frames) {
  if (frames.length === 0) throw new Error('No frames captured');
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const duration = i + 1 < frames.length
      ? frames[i + 1].tSec - frames[i].tSec
      : 0.3; // hold the last frame briefly
    lines.push(`file '${frames[i].file}'`);
    lines.push(`duration ${duration.toFixed(3)}`);
  }
  lines.push(`file '${frames[frames.length - 1].file}'`);
  return lines;
}

function main() {
  const [, , framesManifestPath, outPath] = process.argv;
  const frames = JSON.parse(fs.readFileSync(framesManifestPath, 'utf8'));

  const listPath = path.join(os.tmpdir(), `frames-${Date.now()}.txt`);
  fs.writeFileSync(listPath, buildConcatLines(frames).join('\n'));

  execFileSync('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
    '-vsync', 'vfr', '-pix_fmt', 'yuv420p', outPath,
  ], { stdio: 'inherit' });

  fs.unlinkSync(listPath);
}

if (require.main === module) {
  main();
}

module.exports = { buildConcatLines };
