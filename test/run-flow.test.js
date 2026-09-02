const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { runFlow } = require('../src/click-flow.js');

// Fake Playwright page covering everything runFlow touches: navigation,
// slide rendering, locator resolution/click/fill, and timing calls — none
// of it real, so these tests run in milliseconds with no browser and no
// dependency on the real Chrome/CDP connection main() uses.
function makeLocator(count, tag, clickDelayMs = 0) {
  const self = {
    count: async () => count,
    first: () => self,
    tag,
    boundingBox: async () => ({ x: 10, y: 20, width: 100, height: 40 }),
    click: async () => {
      // Real wall-clock time, so a test can observe how much of a
      // narration the action itself consumed.
      if (clickDelayMs) await new Promise((r) => setTimeout(r, clickDelayMs));
      self.clicked = true;
    },
    pressSequentially: async (value) => { self.typed = value; },
  };
  return self;
}

function makeFakePage(locatorCounts = {}, { clickDelayMs = 0 } = {}) {
  const calls = { goto: [], setContent: [], waitForTimeout: [], clicked: [], typed: [], captions: [] };
  const roleLocator = (role, opts) => {
    const loc = makeLocator(locatorCounts[role] ?? 0, `role:${role}:${opts?.name ?? ''}`, clickDelayMs);
    const realClick = loc.click;
    loc.click = async () => { await realClick(); calls.clicked.push(loc.tag); };
    const realType = loc.pressSequentially;
    loc.pressSequentially = async (value) => { await realType(value); calls.typed.push({ tag: loc.tag, value }); };
    return loc;
  };
  return {
    calls,
    goto: async (url) => { calls.goto.push(url); },
    setContent: async (html) => { calls.setContent.push(html); },
    // setCaption calls evaluate(fn, {text, css}); record the text it would
    // have written so caption behaviour is observable without a browser.
    evaluate: async (_fn, arg) => {
      if (arg && typeof arg === 'object' && 'text' in arg) calls.captions.push(arg.text);
    },
    waitForTimeout: async (ms) => { calls.waitForTimeout.push(ms); },
    waitForLoadState: async () => {},
    bringToFront: async () => {},
    getByRole: roleLocator,
    getByText: (text) => roleLocator('text', { name: text }),
    getByPlaceholder: (text) => roleLocator('placeholder', { name: text }),
    getByLabel: (text) => roleLocator('label', { name: text }),
    getByTestId: (id) => roleLocator('testId', { name: id }),
    locator: (sel) => roleLocator('selector', { name: sel }),
  };
}

const noSlides = {};

describe('runFlow', () => {
  test('navigates to flow.url and clicks each step in order', async () => {
    const page = makeFakePage({ button: 1 });
    const flow = {
      url: 'https://example.com/dashboard',
      steps: [{ click: 'Settings' }, { click: 'Billing' }],
    };
    await runFlow(page, flow, { startMs: Date.now(), narrationPlan: [], slidesPlan: noSlides });

    assert.deepEqual(page.calls.goto, ['https://example.com/dashboard']);
    assert.equal(page.calls.clicked.length, 2);
  });

  test('a fill step types the value via pressSequentially, not click alone', async () => {
    const page = makeFakePage({ textbox: 1 });
    const flow = {
      url: 'https://example.com',
      steps: [{ fill: 'Search', value: 'invoices' }],
    };
    await runFlow(page, flow, { startMs: Date.now(), narrationPlan: [], slidesPlan: noSlides });

    assert.deepEqual(page.calls.typed, [{ tag: 'role:textbox:Search', value: 'invoices' }]);
  });

  test('narration events are recorded from the pre-synthesized plan, one per "say" step', async () => {
    const page = makeFakePage({ button: 1 });
    const flow = {
      url: 'https://example.com',
      steps: [
        { say: 'First step.' },
        { click: 'Next', say: 'Second step.' },
      ],
    };
    const narrationPlan = [
      { file: 'narr-0.aiff', durationSec: 1.5 },
      { file: 'narr-1.aiff', durationSec: 2.0 },
    ];
    const events = await runFlow(page, flow, { startMs: Date.now(), narrationPlan, slidesPlan: noSlides });

    assert.equal(events.length, 2);
    assert.equal(events[0].file, 'narr-0.aiff');
    assert.equal(events[0].durationSec, 1.5);
    assert.equal(events[1].file, 'narr-1.aiff');
    assert.ok(events[1].offsetSec >= events[0].offsetSec, 'offsets should be non-decreasing in step order');
  });

  test('a "say" step with no matching plan entry throws a clear error instead of silently skipping narration', async () => {
    const page = makeFakePage({});
    const flow = { url: 'https://example.com', steps: [{ say: 'Missing plan entry.' }] };
    await assert.rejects(
      () => runFlow(page, flow, { startMs: Date.now(), narrationPlan: [], slidesPlan: noSlides }),
      /No pre-synthesized narration for step 0/,
    );
  });

  test('renders the intro slide before goto, and the outro slide after all steps', async () => {
    const page = makeFakePage({ button: 1 });
    const flow = { url: 'https://example.com', steps: [{ click: 'Go' }] };
    const slidesPlan = {
      intro: { title: 'Welcome', subtitle: undefined, narration: null, wait: 10 },
      outro: { title: 'Thanks', subtitle: undefined, narration: null, wait: 10 },
    };
    await runFlow(page, flow, { startMs: Date.now(), narrationPlan: [], slidesPlan });

    assert.equal(page.calls.setContent.length, 2);
    assert.match(page.calls.setContent[0], /Welcome/);
    assert.match(page.calls.setContent[1], /Thanks/);
    // intro's about:blank, then the real navigation, then outro's about:blank
    // (about:blank avoids setContent's TrustedHTML CSP failure — see click-flow.js)
    assert.deepEqual(page.calls.goto, ['about:blank', 'https://example.com', 'about:blank']);
  });

  test('no slides shown at all when intro/outro are absent from the plan', async () => {
    const page = makeFakePage({ button: 1 });
    const flow = { url: 'https://example.com', steps: [{ click: 'Go' }] };
    await runFlow(page, flow, { startMs: Date.now(), narrationPlan: [], slidesPlan: noSlides });

    assert.equal(page.calls.setContent.length, 0);
    assert.deepEqual(page.calls.goto, ['https://example.com']);
  });

  test('slide narration is included in the returned events, alongside step narration', async () => {
    const page = makeFakePage({ button: 1 });
    const flow = { url: 'https://example.com', steps: [{ click: 'Go', say: 'A step.' }] };
    const slidesPlan = {
      intro: { title: 'Welcome', narration: { file: 'intro-narr.aiff', durationSec: 2 }, wait: 10 },
      outro: null,
    };
    const events = await runFlow(page, flow, {
      startMs: Date.now(),
      narrationPlan: [{ file: 'step-narr.aiff', durationSec: 1 }],
      slidesPlan,
    });

    assert.equal(events.length, 2);
    assert.equal(events[0].file, 'intro-narr.aiff'); // intro narrates before the step runs
    assert.equal(events[1].file, 'step-narr.aiff');
  });

  // Regression: the narration clock starts when the step starts, but the
  // hold runs after the action. Holding the clip's FULL length there added
  // the action's whole duration (networkidle alone can be 4s) as dead air
  // to every narrated step.
  test('the post-step hold subtracts narration time the action already consumed', async () => {
    const page = makeFakePage({ button: 1 }, { clickDelayMs: 500 });
    const flow = {
      url: 'https://example.com',
      holdMs: 0,
      steps: [{ click: 'Go', say: 'Two seconds of narration.' }],
    };
    await runFlow(page, flow, {
      startMs: Date.now(),
      narrationPlan: [{ file: 'narr-0.aiff', durationSec: 2.0 }],
      slidesPlan: noSlides,
    });

    const longestHold = Math.max(...page.calls.waitForTimeout);
    // Full-length behaviour would be 2000 + 300 = 2300. Having consumed
    // ~500ms in the click, the hold should be ~1800.
    assert.ok(
      longestHold < 2100,
      `hold should be reduced by the ~500ms the action took, got ${longestHold}ms`,
    );
    // ...but never so short that the clip gets cut off.
    assert.ok(longestHold > 1300, `hold should still cover the rest of the clip, got ${longestHold}ms`);
  });

  // Captions are drawn as a page overlay, so they land in the screenshot at
  // the instant it's captured and cannot drift from the narration.
  test('a narrated step shows its line, re-asserts it after the action, then clears', async () => {
    const page = makeFakePage({ button: 1 });
    const flow = {
      url: 'https://example.com',
      holdMs: 0,
      steps: [{ click: 'Go', say: 'Open the billing page.' }],
    };
    await runFlow(page, flow, {
      startMs: Date.now(),
      narrationPlan: [{ file: 'n0.wav', durationSec: 0.2 }],
      slidesPlan: noSlides,
    });

    const shown = page.calls.captions.filter((c) => c === 'Open the billing page.');
    assert.equal(shown.length, 2, 'set before the action and re-asserted after it (navigation wipes the overlay)');
    assert.equal(page.calls.captions.at(-1), '', 'cleared once the line is over');
  });

  test('captions: false on the flow suppresses them entirely', async () => {
    const page = makeFakePage({ button: 1 });
    const flow = {
      url: 'https://example.com',
      holdMs: 0,
      captions: false,
      steps: [{ click: 'Go', say: 'Not shown on screen.' }],
    };
    await runFlow(page, flow, {
      startMs: Date.now(),
      narrationPlan: [{ file: 'n0.wav', durationSec: 0.2 }],
      slidesPlan: noSlides,
    });

    assert.ok(!page.calls.captions.includes('Not shown on screen.'));
  });

  test('captions: false on one step suppresses only that step', async () => {
    const page = makeFakePage({ button: 1 });
    const flow = {
      url: 'https://example.com',
      holdMs: 0,
      steps: [
        { click: 'A', say: 'Shown.' },
        { click: 'B', say: 'Hidden.', captions: false },
      ],
    };
    await runFlow(page, flow, {
      startMs: Date.now(),
      narrationPlan: [
        { file: 'n0.wav', durationSec: 0.2 },
        { file: 'n1.wav', durationSec: 0.2 },
      ],
      slidesPlan: noSlides,
    });

    assert.ok(page.calls.captions.includes('Shown.'));
    assert.ok(!page.calls.captions.includes('Hidden.'));
    // The narration itself is unaffected — only the on-screen text is.
    assert.equal(page.calls.captions.filter((c) => c === 'Shown.').length, 2);
  });

  test('an un-narrated step still honours its explicit wait', async () => {
    const page = makeFakePage({ button: 1 }, { clickDelayMs: 200 });
    const flow = { url: 'https://example.com', holdMs: 0, steps: [{ click: 'Go', wait: 1500 }] };
    await runFlow(page, flow, { startMs: Date.now(), narrationPlan: [], slidesPlan: noSlides });

    assert.equal(Math.max(...page.calls.waitForTimeout), 1500);
  });
});
