const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { runFlow } = require('../src/click-flow.js');

// Fake Playwright page covering everything runFlow touches: navigation,
// slide rendering, locator resolution/click/fill, and timing calls — none
// of it real, so these tests run in milliseconds with no browser and no
// dependency on the real Chrome/CDP connection main() uses.
function makeLocator(count, tag) {
  const self = {
    count: async () => count,
    first: () => self,
    tag,
    boundingBox: async () => ({ x: 10, y: 20, width: 100, height: 40 }),
    click: async () => { self.clicked = true; },
    pressSequentially: async (value) => { self.typed = value; },
  };
  return self;
}

function makeFakePage(locatorCounts = {}) {
  const calls = { goto: [], setContent: [], waitForTimeout: [], clicked: [], typed: [] };
  const roleLocator = (role, opts) => {
    const loc = makeLocator(locatorCounts[role] ?? 0, `role:${role}:${opts?.name ?? ''}`);
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
    evaluate: async () => {},
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
});
