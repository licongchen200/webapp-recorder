const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { withAiFallback } = require('../src/ai-resolver.js');

// Provider-selection/gating logic (getAiConfig/isAiEnabled) is tested in
// test/llm.test.js, which src/ai-resolver.js's element-resolution logic
// shares with src/slide-generator.js. This file covers only the
// fallback-wiring behavior specific to element resolution — never a real
// API call.

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  delete process.env.ENABLE_AI;
  delete process.env.ANTHROPIC_API_KEY;
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('withAiFallback', () => {
  test('returns the deterministic result directly on success — AI never touched', async () => {
    const resolver = async () => 'the-real-locator';
    assert.equal(await withAiFallback(resolver, {}, 'Save', 'click'), 'the-real-locator');
  });

  test('rethrows the original error unchanged when AI is disabled (the default)', async () => {
    const resolver = async () => { throw new Error('No clickable element found matching "Save"'); };
    await assert.rejects(
      () => withAiFallback(resolver, {}, 'Save', 'click'),
      /No clickable element found matching "Save"/,
    );
  });
});
