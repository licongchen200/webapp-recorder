// CLI for the subtitle stage (see subtitles.js).
//
//   node src/write-subtitles.js <video> <narration-log>
//
// Writes <video>.srt and .vtt beside the recording, then embeds the track
// into the file itself. A failure here must never cost you the recording,
// so problems are reported and skipped rather than thrown.
const fs = require('fs');
const { buildCues, write, embed } = require('./subtitles.js');

function main() {
  const [, , videoPath, narrationLogPath] = process.argv;
  if (!videoPath || !narrationLogPath) {
    throw new Error('Usage: write-subtitles.js <video> <narration-log>');
  }

  const events = JSON.parse(fs.readFileSync(narrationLogPath, 'utf8'));
  const cues = buildCues(events);
  const srt = write(cues, videoPath);
  if (!srt) return; // nothing narrated — no captions to write

  try {
    embed(videoPath, srt);
    console.log(`Subtitles: ${cues.length} cues -> .srt + .vtt, embedded`);
  } catch (err) {
    console.warn(`Subtitles written, but embedding failed: ${err.message}`);
  }
}

if (require.main === module) {
  main();
}
