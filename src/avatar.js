// Optional lip-synced talking-head overlay, composited onto the finished
// screen recording as a circular cutout in one corner.
//
// The heavy lifting (Wav2Lip / SadTalker) is NOT reimplemented here — it's
// the sibling video-pipeline project's avatar.py, invoked as a CLI. Same
// engines, same models, same content-hash cache, one implementation.
//
// The compositing differs from video-pipeline's, though, and that's the
// whole reason this file exists: video-pipeline builds one clip per scene
// (still image + its own avatar), while a recording here is a single
// continuous screencast with narration at arbitrary timestamps. So each
// avatar clip is shifted to its narration's offset (setpts) and gated to
// just that window (overlay enable=between), leaving the screencast
// untouched everywhere else.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// The avatar is the one feature that needs the sibling video-pipeline
// project (for its Wav2Lip/SadTalker engines and their ~3GB of checkpoints —
// worth borrowing, not duplicating). Everything else in this repo stands
// alone. Point VIDEO_PIPELINE_DIR anywhere, or set avatar.pipelineDir in the
// flow; the default assumes the two repos are cloned side by side.
function pipelineDir(cfg = {}) {
  return path.resolve(
    cfg.pipelineDir
    || process.env.VIDEO_PIPELINE_DIR
    || path.join(__dirname, '..', '..', 'video-pipeline'),
  );
}

// Each engine lives in its own venv over there (they pin incompatible
// torch/numpy versions and cannot share one).
const ENGINE_VENV = { wav2lip: '.avatar-venv', sadtalker: '.sadtalker-venv' };

const POSITIONS = {
  'bottom-right': (s, m) => [`W-${s}-${m}`, `H-${s}-${m}`],
  'bottom-left': (s, m) => [`${m}`, `H-${s}-${m}`],
  'top-right': (s, m) => [`W-${s}-${m}`, `${m}`],
  'top-left': (s, m) => [`${m}`, `${m}`],
};

function resolveConfig(flow) {
  const a = flow.avatar || {};
  return {
    enabled: !!a.enabled,
    face: a.face,
    engine: a.engine || 'wav2lip',
    position: a.position || 'bottom-right',
    size: a.size || 280,
    margin: a.margin ?? 48,
    pipelineDir: pipelineDir(a),
  };
}

// Runs the engines once for all narration clips (one python startup, not one
// per clip — loading a 400MB+ checkpoint per event would dominate runtime).
function synthesizeClips(cfg, events, cacheDir) {
  const venv = ENGINE_VENV[cfg.engine];
  if (!venv) {
    throw new Error(`unknown avatar.engine "${cfg.engine}" — use ${Object.keys(ENGINE_VENV).join(' or ')}`);
  }
  const pipeline = cfg.pipelineDir;
  const avatarPy = path.join(pipeline, 'src', 'avatar.py');
  const python = path.join(pipeline, venv, 'bin', 'python3');

  if (!fs.existsSync(avatarPy)) {
    throw new Error(
      `avatar needs the video-pipeline project, not found at ${pipeline}\n`
      + 'clone https://github.com/licongchen200/video-pipeline beside this repo, '
      + 'or set VIDEO_PIPELINE_DIR / avatar.pipelineDir to where it lives',
    );
  }
  if (!fs.existsSync(python)) {
    throw new Error(
      `${cfg.engine} venv not found at ${python}\n`
      + `run \`make avatar-setup${cfg.engine === 'sadtalker' ? '-sadtalker' : ''}\` in ${pipeline}`,
    );
  }
  if (!fs.existsSync(cfg.face)) throw new Error(`avatar.face not found: ${cfg.face}`);

  const out = execFileSync(
    python,
    [avatarPy, path.resolve(cfg.face), cacheDir, cfg.engine, ...events.map((e) => path.resolve(e.file))],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 24 },
  );
  return JSON.parse(out.trim());
}

// Circular cutout: alpha 255 inside the radius, 0 outside. Same approach as
// video-pipeline's assemble.py — no mask asset needed.
function circleMask(size) {
  return `scale=${size}:${size},format=rgba,`
    + `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':`
    + `a='if(lte(pow(X-${size}/2,2)+pow(Y-${size}/2,2),pow(${size}/2,2)),255,0)'`;
}

// Input 0 is the screencast, input 1 is a still frame lifted from the first
// lip-sync clip, and inputs 2..n are the clips themselves.
//
// The still is overlaid for the WHOLE video, with each clip layered on top
// only for its own window. That's what keeps a face on screen between
// narration lines — gating the clips alone made the avatar vanish during
// every navigation and slide change, since those happen in the gaps.
// Sourcing the still from a clip's own first frame (rather than the raw
// photo) guarantees it matches the clips' framing, so the hand-off from
// still to talking is seamless.
function buildFilterComplex(events, clips, cfg) {
  const [x, y] = POSITIONS[cfg.position](cfg.size, cfg.margin);
  const s = cfg.size;
  const parts = [`[1:v]${circleMask(s)}[still]`];
  // eof_action=pass so a short overlay input can never truncate the output.
  parts.push(`[0:v][still]overlay=${x}:${y}:eof_action=pass:repeatlast=0[base]`);

  let base = '[base]';
  events.forEach((e, i) => {
    const off = e.offsetSec.toFixed(3);
    const end = (e.offsetSec + clips[i].sec).toFixed(3);
    parts.push(`[${i + 2}:v]${circleMask(s)},setpts=PTS+${off}/TB[av${i}]`);
    const label = i === events.length - 1 ? '[vout]' : `[v${i}]`;
    parts.push(
      `${base}[av${i}]overlay=${x}:${y}:enable='between(t,${off},${end})'`
      + `:eof_action=pass:repeatlast=0${label}`,
    );
    base = label;
  });

  return parts.join(';');
}

function probeDurationSec(file) {
  return parseFloat(execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ], { encoding: 'utf8' }).trim());
}

// The between-lines still: the first frame of the first lip-sync clip.
function extractStill(clipPath, outPath) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', clipPath,
    '-frames:v', '1', outPath]);
  return outPath;
}

// video (with narration already muxed) + narration events -> same video with
// the avatar composited in. Returns false if avatar isn't configured.
function applyAvatar(flow, videoPath, events, cacheDir, outPath) {
  const cfg = resolveConfig(flow);
  if (!cfg.enabled || events.length === 0) return false;
  if (!POSITIONS[cfg.position]) {
    throw new Error(`unknown avatar.position "${cfg.position}" — use ${Object.keys(POSITIONS).join(', ')}`);
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  const clips = synthesizeClips(cfg, events, cacheDir);
  const still = extractStill(clips[0].mp4, path.join(cacheDir, 'still.png'));

  const args = ['-y', '-i', videoPath];
  // Bounded to the screencast's length rather than looped forever, so the
  // output duration stays governed by the recording itself.
  args.push('-loop', '1', '-t', String(probeDurationSec(videoPath)), '-i', still);
  for (const c of clips) args.push('-i', c.mp4);
  args.push(
    '-filter_complex', buildFilterComplex(events, clips, cfg),
    '-map', '[vout]',
    // The avatar clips carry their own audio (the same narration), which
    // must NOT be mixed in again — the base video's track already has it.
    '-map', '0:a?',
    '-c:a', 'copy',
    '-pix_fmt', 'yuv420p',
    outPath,
  );
  execFileSync('ffmpeg', args, { stdio: 'inherit' });
  return true;
}

module.exports = { resolveConfig, buildFilterComplex, applyAvatar, POSITIONS };
