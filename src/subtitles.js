// Sidecar subtitle files (.srt / .vtt) — closed captions the viewer can
// toggle, as opposed to the open captions burned into the frames.
//
// These are exact rather than approximate: the text is the same string that
// was fed to the TTS engine (not a transcription of it), and the offsets are
// measured against the frame-capture origin, so the cues are correct by
// construction rather than by luck.
//
// A step with `captions: false` still gets a cue — that flag governs what is
// painted onto the frame, while a caption track is an accessibility surface.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// SRT wants HH:MM:SS,mmm; WebVTT wants the same with a period. Mixing them
// up yields a file players silently ignore.
function formatTimestamp(seconds, millisSep = ',') {
  const totalMs = Math.round(Math.max(0, seconds) * 1000);
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${millisSep}${pad(ms, 3)}`;
}

// Narration events already carry absolute offsets against the video's own
// timeline, so no accumulation is needed here — just filter and format.
function buildCues(events) {
  return events
    .filter((e) => e.text && e.text.trim())
    .map((e) => ({
      start: e.offsetSec,
      end: e.offsetSec + e.durationSec,
      text: e.text.replace(/\s+/g, ' ').trim(),
    }))
    .sort((a, b) => a.start - b.start);
}

function toSrt(cues) {
  return cues
    .map((c, i) => `${i + 1}\n${formatTimestamp(c.start)} --> ${formatTimestamp(c.end)}\n${c.text}\n`)
    .join('\n');
}

function toVtt(cues) {
  return ['WEBVTT\n']
    .concat(cues.map((c) => `${formatTimestamp(c.start, '.')} --> ${formatTimestamp(c.end, '.')}\n${c.text}\n`))
    .join('\n');
}

// Writes <video-without-ext>.srt and .vtt. Returns the .srt path, or null
// when there was nothing to caption.
function write(cues, videoPath) {
  if (cues.length === 0) return null;
  const base = path.join(path.dirname(videoPath), path.basename(videoPath, path.extname(videoPath)));
  fs.writeFileSync(`${base}.srt`, toSrt(cues));
  fs.writeFileSync(`${base}.vtt`, toVtt(cues));
  return `${base}.srt`;
}

// Adds the subtitles as a real track inside the video, so players can toggle
// them without a second file. Audio and video are stream-copied — a remux,
// not a re-encode.
function embed(videoPath, srtPath) {
  const tmp = path.join(path.dirname(videoPath), `.subbed-${path.basename(videoPath)}`);
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', videoPath, '-i', srtPath,
    '-map', '0', '-map', '1',
    '-c', 'copy', '-c:s', 'mov_text',
    '-metadata:s:s:0', 'language=eng',
    tmp,
  ]);
  fs.renameSync(tmp, videoPath);
}

module.exports = { formatTimestamp, buildCues, toSrt, toVtt, write, embed };
