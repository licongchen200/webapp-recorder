const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { resolveSlideContent } = require('../src/slide-generator.js');

// Only the literal-content paths and the AI-required gating — never a real
// API call for the "generate" path, same policy as the other AI tests.

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  delete process.env.ENABLE_AI;
  delete process.env.ANTHROPIC_API_KEY;
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

const FLOW = { url: 'https://example.com', steps: [{ say: 'Step one.' }, { click: 'Go' }] };

describe('resolveSlideContent — literal content, no AI needed', () => {
  test('a plain string becomes the title with no subtitle or narration', async () => {
    assert.deepEqual(await resolveSlideContent(FLOW, 'My Demo'), {
      title: 'My Demo', subtitle: undefined, say: undefined,
    });
  });

  test('a { title, subtitle, say } object passes through unchanged', async () => {
    const spec = { title: 'My Demo', subtitle: 'A quick tour', say: 'Welcome to the demo.' };
    assert.deepEqual(await resolveSlideContent(FLOW, spec), {
      title: 'My Demo', subtitle: 'A quick tour', say: 'Welcome to the demo.',
    });
  });

  test('a title-only object has no subtitle or narration', async () => {
    assert.deepEqual(await resolveSlideContent(FLOW, { title: 'My Demo' }), {
      title: 'My Demo', subtitle: undefined, say: undefined,
    });
  });
});

describe('resolveSlideContent — generate requires AI', () => {
  test('generate: true throws a clear error when AI is disabled (the default)', async () => {
    await assert.rejects(
      () => resolveSlideContent(FLOW, { generate: true }),
      /Slide "generate" requires AI/,
    );
  });

  test('generate: true is equivalent to spec === true', async () => {
    await assert.rejects(
      () => resolveSlideContent(FLOW, true),
      /Slide "generate" requires AI/,
    );
  });

  test('generate with a hint string still requires AI when disabled', async () => {
    await assert.rejects(
      () => resolveSlideContent(FLOW, { generate: 'make it exciting' }),
      /Slide "generate" requires AI/,
    );
  });
});
