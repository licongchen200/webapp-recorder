// Pre-generates all per-step (and intro/outro slide) narration audio
// *before* recording starts, so the slow/variable TTS + ffprobe subprocess
// calls (and any AI slide-content generation) never compete with
// screencapture for CPU during the actual recording (that contention was
// stretching some steps by 10+ seconds and cutting the video short).
//
// Three engines:
//   "say"    (default) — macOS built-in, zero setup, robotic-ish compact voices
//   "piper"  — free local neural TTS, smoother, needs `npm run tts:setup`
//              once (installs a venv + downloads a voice model)
//   "kokoro" — free local neural TTS, best quality of the three, needs
//              `npm run tts:setup:kokoro` once (heavier: ~350MB of models,
//              a dedicated Python 3.13 venv — kokoro-onnx doesn't yet
//              support 3.14)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveSlideContent } = require('./slide-generator.js');

const ROOT_DIR = path.join(__dirname, '..'); // .tts-venv*/ and tts-models/ live at the project root, not src/
const PIPER_BIN = path.join(ROOT_DIR, '.tts-venv', 'bin', 'piper');
const DEFAULT_PIPER_MODEL = path.join(ROOT_DIR, 'tts-models', 'en_US-lessac-high.onnx');

const KOKORO_PYTHON = path.join(ROOT_DIR, '.tts-venv-kokoro', 'bin', 'python3');
const KOKORO_SCRIPT = path.join(__dirname, 'kokoro-say.py');
const DEFAULT_KOKORO_MODEL = path.join(ROOT_DIR, 'tts-models', 'kokoro-v1.0.onnx');
const DEFAULT_KOKORO_VOICES = path.join(ROOT_DIR, 'tts-models', 'voices-v1.0.bin');
const DEFAULT_KOKORO_VOICE = 'af_heart';

// Given a flow, decides which TTS engine to use, the output file extension,
// and engine-specific options — pure decision logic, no I/O.
function getEngineConfig(flow) {
  if (flow.tts === 'piper') {
    return { engine: 'piper', ext: 'wav', modelPath: flow.piperModel || DEFAULT_PIPER_MODEL };
  }
  if (flow.tts === 'kokoro') {
    return {
      engine: 'kokoro',
      ext: 'wav',
      modelPath: flow.kokoroModel || DEFAULT_KOKORO_MODEL,
      voicesPath: flow.kokoroVoices || DEFAULT_KOKORO_VOICES,
      voice: flow.voice || DEFAULT_KOKORO_VOICE,
      speed: flow.kokoroSpeed || 1.0,
    };
  }
  return { engine: 'say', ext: 'aiff', voice: flow.voice };
}

function synthesizeWithSay(text, voice, outFile) {
  const args = [];
  if (voice) args.push('-v', voice);
  args.push('-o', outFile, text);
  execFileSync('say', args);
}

function synthesizeWithPiper(text, modelPath, outFile) {
  if (!fs.existsSync(PIPER_BIN)) {
    throw new Error('Piper not installed — run: npm run tts:setup');
  }
  if (!fs.existsSync(modelPath)) {
    throw new Error(`Piper voice model not found: ${modelPath}`);
  }
  execFileSync(PIPER_BIN, ['-m', modelPath, '-f', outFile], { input: text });
}

function synthesizeWithKokoro(text, config, outFile) {
  if (!fs.existsSync(KOKORO_PYTHON)) {
    throw new Error('Kokoro not installed — run: npm run tts:setup:kokoro');
  }
  if (!fs.existsSync(config.modelPath) || !fs.existsSync(config.voicesPath)) {
    throw new Error(`Kokoro model/voices not found: ${config.modelPath}, ${config.voicesPath}`);
  }
  execFileSync(KOKORO_PYTHON, [
    KOKORO_SCRIPT, config.modelPath, config.voicesPath, config.voice, String(config.speed), outFile,
  ], { input: text });
}

function getDurationSec(file) {
  return parseFloat(execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ]).toString().trim());
}

function synthesize(text, config, outFile) {
  if (config.engine === 'piper') synthesizeWithPiper(text, config.modelPath, outFile);
  else if (config.engine === 'kokoro') synthesizeWithKokoro(text, config, outFile);
  else synthesizeWithSay(text, config.voice, outFile);
  return { file: outFile, durationSec: getDurationSec(outFile) };
}

// Resolves an intro/outro slide's content (title/subtitle/narration —
// possibly via AI) and synthesizes its narration audio, if any.
async function resolveSlide(flow, key, outDir, config) {
  const spec = flow[key];
  if (!spec) return null;
  const { title, subtitle, say } = await resolveSlideContent(flow, spec);
  if (!title) throw new Error(`flow.${key} needs a "title" (or "generate: true" to auto-generate one)`);
  const narration = say ? synthesize(say, config, path.join(outDir, `${key}-narr.${config.ext}`)) : null;
  const wait = typeof spec === 'object' ? spec.wait : undefined;
  return { title, subtitle, narration, wait };
}

async function main() {
  try {
    process.loadEnvFile(); // loads .env from cwd if present — needed for AI slide generation
  } catch {
    // no .env file — fine, AI-generated slides just aren't available
  }

  const [, , flowPath, outDir] = process.argv;
  const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
  fs.mkdirSync(outDir, { recursive: true });

  const config = getEngineConfig(flow);

  const plan = flow.steps.map((step, i) => {
    if (!step.say) return null;
    return synthesize(step.say, config, path.join(outDir, `narr-${i}.${config.ext}`));
  });
  fs.writeFileSync(path.join(outDir, 'plan.json'), JSON.stringify(plan));

  const slidesPlanPath = process.env.SLIDES_PLAN;
  if (slidesPlanPath) {
    const slides = {
      intro: await resolveSlide(flow, 'intro', outDir, config),
      outro: await resolveSlide(flow, 'outro', outDir, config),
    };
    fs.writeFileSync(slidesPlanPath, JSON.stringify(slides));
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { getEngineConfig, synthesizeWithPiper, synthesizeWithKokoro };
