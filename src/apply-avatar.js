// CLI wrapper for the avatar overlay stage (see avatar.js).
//
//   node src/apply-avatar.js <flow.json> <video> <narration-log> <cache-dir>
//
// Composites in place: writes to a temp file, then replaces <video> only on
// success, so a failed overlay can never destroy a good recording.
const fs = require('fs');
const path = require('path');
const { applyAvatar } = require('./avatar.js');

function main() {
  const [, , flowPath, videoPath, narrationLogPath, cacheDir] = process.argv;
  if (!flowPath || !videoPath) {
    throw new Error('Usage: apply-avatar.js <flow.json> <video> <narration-log> <cache-dir>');
  }
  const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
  if (!flow.avatar || !flow.avatar.enabled) return; // not configured — nothing to do

  const events = JSON.parse(fs.readFileSync(narrationLogPath, 'utf8'));
  const tmp = path.join(
    path.dirname(videoPath),
    `.avatar-${path.basename(videoPath)}`,
  );

  const applied = applyAvatar(flow, videoPath, events, cacheDir, tmp);
  if (applied) {
    fs.renameSync(tmp, videoPath);
    console.log('Avatar overlay applied');
  }
}

if (require.main === module) {
  main();
}
