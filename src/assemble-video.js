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

// "1920x1080" -> "1920:1080" (ffmpeg scale filter syntax). Either side can
// be -1 or -2 to auto-scale that dimension preserving aspect ratio (ffmpeg
// convention — -2 rounds to an even number, required by some codecs).
function parseResolution(resolution) {
  const match = /^(-?\d+)x(-?\d+)$/.exec(resolution);
  if (!match) {
    throw new Error(
      `Invalid "resolution" — expected "WIDTHxHEIGHT" (e.g. "1920x1080", or "1920x-2" `
      + `to auto-scale height preserving aspect ratio), got "${resolution}"`,
    );
  }
  return `${match[1]}:${match[2]}`;
}

function main() {
  const [, , framesManifestPath, flowPath, outPath] = process.argv;
  const frames = JSON.parse(fs.readFileSync(framesManifestPath, 'utf8'));
  const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));

  const listPath = path.join(os.tmpdir(), `frames-${Date.now()}.txt`);
  fs.writeFileSync(listPath, buildConcatLines(frames).join('\n'));

  const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listPath];
  if (flow.resolution) {
    args.push('-vf', `scale=${parseResolution(flow.resolution)}`);
  }
  // -fps_mode replaced -vsync (deprecated); needs ffmpeg >= 5.0.
  args.push('-fps_mode', 'vfr', '-pix_fmt', 'yuv420p', outPath);

  execFileSync('ffmpeg', args, { stdio: 'inherit' });

  fs.unlinkSync(listPath);
}

if (require.main === module) {
  main();
}

module.exports = { buildConcatLines, parseResolution };
