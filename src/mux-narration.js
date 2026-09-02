// Overlays each per-step narration clip onto the silent screen recording at
// the recorded timestamp, then muxes the result. Clips don't overlap in
// time (one step narrates at a time) so amix's normalize=0 keeps each clip
// at full volume instead of dividing it by the input count.
const { execFileSync } = require('child_process');
const fs = require('fs');

function buildFilterComplex(events) {
  const delayed = events.map((e, i) => {
    const ms = Math.round(e.offsetSec * 1000);
    return `[${i + 1}:a]adelay=delays=${ms}:all=1[a${i}]`;
  });
  const mixLabels = events.map((_, i) => `[a${i}]`).join('');
  return `${delayed.join(';')};${mixLabels}amix=inputs=${events.length}:duration=longest:normalize=0[aout]`;
}

function main() {
  const [, , videoPath, narrationLogPath, outPath] = process.argv;
  const events = JSON.parse(fs.readFileSync(narrationLogPath, 'utf8'));

  const args = ['-y', '-i', videoPath];
  for (const e of events) args.push('-i', e.file);

  args.push(
    '-filter_complex', buildFilterComplex(events),
    '-map', '0:v:0',
    '-map', '[aout]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-shortest',
    outPath,
  );

  execFileSync('ffmpeg', args, { stdio: 'inherit' });
}

if (require.main === module) {
  main();
}

module.exports = { buildFilterComplex };
