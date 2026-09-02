const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { isAiEnabled, withAiFallback } = require('../src/ai-resolver.js');

// These only exercise the opt-in gating and fallback-wiring logic — never
// the real Claude API call, which costs money and needs a live key. That
// path (resolveWithAI actually calling Anthropic) is an integration
// concern, not covered here.

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  delete process.env.ENABLE_AI;
  delete process.env.ANTHROPIC_API_KEY;
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('isAiEnabled', () => {
  test('disabled by default (no env vars set)', () => {
    assert.equal(isAiEnabled(), false);
  });

  test('disabled with ENABLE_AI=true but no API key', () => {
    process.env.ENABLE_AI = 'true';
    assert.equal(isAiEnabled(), false);
  });

  test('disabled with an API key but ENABLE_AI unset', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fake';
    assert.equal(isAiEnabled(), false);
  });

  test('disabled when ENABLE_AI is any value other than the string "true"', () => {
    process.env.ENABLE_AI = '1';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fake';
    assert.equal(isAiEnabled(), false);
  });

  test('enabled only when both ENABLE_AI=true and an API key are set', () => {
    process.env.ENABLE_AI = 'true';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fake';
    assert.equal(isAiEnabled(), true);
  });
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
