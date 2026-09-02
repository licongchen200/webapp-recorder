// Pre-generates all per-step narration audio *before* recording starts, so
// the slow/variable TTS + ffprobe subprocess calls never compete with
// screencapture for CPU during the actual recording (that contention was
// stretching some steps by 10+ seconds and cutting the video short).
//
// Two engines:
//   "say"   (default) — macOS built-in, zero setup, robotic-ish compact voices
//   "piper" — free local neural TTS, much smoother, needs `npm run tts:setup`
//             once (installs a venv + downloads a voice model)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT_DIR = path.join(__dirname, '..'); // .tts-venv/ and tts-models/ live at the project root, not src/
const PIPER_BIN = path.join(ROOT_DIR, '.tts-venv', 'bin', 'piper');
const DEFAULT_PIPER_MODEL = path.join(ROOT_DIR, 'tts-models', 'en_US-lessac-high.onnx');

// Given a flow, decides which TTS engine to use, the output file extension,
// and (for piper) which voice model — pure decision logic, no I/O.
function getEngineConfig(flow) {
  if (flow.tts === 'piper') {
    return { engine: 'piper', ext: 'wav', modelPath: flow.piperModel || DEFAULT_PIPER_MODEL };
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

function getDurationSec(file) {
  return parseFloat(execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ]).toString().trim());
}

function main() {
  const [, , flowPath, outDir] = process.argv;
  const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
  fs.mkdirSync(outDir, { recursive: true });

  const config = getEngineConfig(flow);

  const plan = flow.steps.map((step, i) => {
    if (!step.say) return null;
    const file = path.join(outDir, `narr-${i}.${config.ext}`);
    if (config.engine === 'piper') {
      synthesizeWithPiper(step.say, config.modelPath, file);
    } else {
      synthesizeWithSay(step.say, config.voice, file);
    }
    return { file, durationSec: getDurationSec(file) };
  });

  fs.writeFileSync(path.join(outDir, 'plan.json'), JSON.stringify(plan));
}

if (require.main === module) {
  main();
}

module.exports = { getEngineConfig, synthesizeWithPiper };
