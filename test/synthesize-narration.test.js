const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { getEngineConfig, synthesizeWithPiper, synthesizeWithKokoro } = require('../src/synthesize-narration.js');

describe('getEngineConfig', () => {
  test('defaults to the say engine with .aiff output', () => {
    assert.deepEqual(getEngineConfig({}), { engine: 'say', ext: 'aiff', voice: undefined });
  });

  test('carries the requested say voice through', () => {
    assert.deepEqual(
      getEngineConfig({ voice: 'Samantha' }),
      { engine: 'say', ext: 'aiff', voice: 'Samantha' },
    );
  });

  test('switches to piper with .wav output and the default voice model', () => {
    const config = getEngineConfig({ tts: 'piper' });
    assert.equal(config.engine, 'piper');
    assert.equal(config.ext, 'wav');
    assert.equal(path.basename(config.modelPath), 'en_US-lessac-high.onnx');
  });

  test('honors a custom piperModel path', () => {
    const config = getEngineConfig({ tts: 'piper', piperModel: '/custom/voice.onnx' });
    assert.equal(config.modelPath, '/custom/voice.onnx');
  });

  test('switches to kokoro with .wav output, default voice/speed, and default model paths', () => {
    const config = getEngineConfig({ tts: 'kokoro' });
    assert.equal(config.engine, 'kokoro');
    assert.equal(config.ext, 'wav');
    assert.equal(config.voice, 'af_heart');
    assert.equal(config.speed, 1.0);
    assert.equal(path.basename(config.modelPath), 'kokoro-v1.0.onnx');
    assert.equal(path.basename(config.voicesPath), 'voices-v1.0.bin');
  });

  test('honors custom kokoro voice/speed/model/voices overrides', () => {
    const config = getEngineConfig({
      tts: 'kokoro', voice: 'af_bella', kokoroSpeed: 1.2,
      kokoroModel: '/custom/model.onnx', kokoroVoices: '/custom/voices.bin',
    });
    assert.equal(config.voice, 'af_bella');
    assert.equal(config.speed, 1.2);
    assert.equal(config.modelPath, '/custom/model.onnx');
    assert.equal(config.voicesPath, '/custom/voices.bin');
  });
});

describe('synthesizeWithPiper', () => {
  test('fails clearly instead of silently producing no audio', () => {
    assert.throws(
      () => synthesizeWithPiper('hello', '/no/such/model.onnx', '/tmp/webapp-recorder-test-out.wav'),
      /Piper|model/i,
    );
  });
});

describe('synthesizeWithKokoro', () => {
  test('fails clearly instead of silently producing no audio', () => {
    assert.throws(
      () => synthesizeWithKokoro('hello', {
        modelPath: '/no/such/model.onnx', voicesPath: '/no/such/voices.bin', voice: 'af_heart', speed: 1.0,
      }, '/tmp/webapp-recorder-test-out.wav'),
      /Kokoro|model/i,
    );
  });
});
