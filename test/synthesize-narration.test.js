const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { getEngineConfig, synthesizeWithPiper } = require('../src/synthesize-narration.js');

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
});

describe('synthesizeWithPiper', () => {
  test('fails clearly instead of silently producing no audio', () => {
    assert.throws(
      () => synthesizeWithPiper('hello', '/no/such/model.onnx', '/tmp/webapp-recorder-test-out.wav'),
      /Piper|model/i,
    );
  });
});
