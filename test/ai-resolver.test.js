const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { getAiConfig, isAiEnabled, withAiFallback } = require('../src/ai-resolver.js');

// These only exercise the opt-in gating, provider-selection, and
// fallback-wiring logic — never a real API call, which costs money and
// needs a live key. That path (resolveWithAI actually calling a provider)
// is an integration concern, not covered here.

const ORIGINAL_ENV = { ...process.env };
const AI_ENV_KEYS = [
  'ENABLE_AI', 'AI_PROVIDER',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
  'OPENROUTER_API_KEY', 'OPENROUTER_MODEL',
];
beforeEach(() => {
  for (const key of AI_ENV_KEYS) delete process.env[key];
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('getAiConfig', () => {
  test('disabled by default (no env vars set)', () => {
    assert.deepEqual(getAiConfig(), { enabled: false });
  });

  test('disabled with ENABLE_AI=true but no API key', () => {
    process.env.ENABLE_AI = 'true';
    assert.deepEqual(getAiConfig(), { enabled: false });
  });

  test('disabled with an API key but ENABLE_AI unset', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fake';
    assert.deepEqual(getAiConfig(), { enabled: false });
  });

  test('disabled when ENABLE_AI is any value other than the string "true"', () => {
    process.env.ENABLE_AI = '1';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fake';
    assert.deepEqual(getAiConfig(), { enabled: false });
  });

  test('defaults to the anthropic provider with the default model', () => {
    process.env.ENABLE_AI = 'true';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fake';
    assert.deepEqual(getAiConfig(), {
      enabled: true, provider: 'anthropic', apiKey: 'sk-ant-fake', model: 'claude-opus-5',
    });
  });

  test('honors an ANTHROPIC_MODEL override', () => {
    process.env.ENABLE_AI = 'true';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fake';
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-5';
    assert.equal(getAiConfig().model, 'claude-sonnet-5');
  });

  test('switches to openrouter with its default model when selected', () => {
    process.env.ENABLE_AI = 'true';
    process.env.AI_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-fake';
    assert.deepEqual(getAiConfig(), {
      enabled: true, provider: 'openrouter', apiKey: 'sk-or-fake', model: 'qwen/qwen3.7-flash',
    });
  });

  test('honors an OPENROUTER_MODEL override', () => {
    process.env.ENABLE_AI = 'true';
    process.env.AI_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-fake';
    process.env.OPENROUTER_MODEL = 'qwen/qwen3-max';
    assert.equal(getAiConfig().model, 'qwen/qwen3-max');
  });

  test('openrouter selected but only an anthropic key set stays disabled', () => {
    process.env.ENABLE_AI = 'true';
    process.env.AI_PROVIDER = 'openrouter';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fake'; // wrong key for the selected provider
    assert.deepEqual(getAiConfig(), { enabled: false });
  });

  test('an unrecognized AI_PROVIDER falls back to anthropic', () => {
    process.env.ENABLE_AI = 'true';
    process.env.AI_PROVIDER = 'some-typo';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fake';
    assert.equal(getAiConfig().provider, 'anthropic');
  });
});

describe('isAiEnabled', () => {
  test('mirrors getAiConfig().enabled', () => {
    assert.equal(isAiEnabled(), false);
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
