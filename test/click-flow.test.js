const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { resolveClickable, resolveInput, locatorFor, computeHold, escapeHtml, slideHtml } = require('../src/click-flow.js');

// Minimal fake Playwright locator/page — just enough to drive the priority-
// fallback logic without a real browser.
function makeLocator(count, tag) {
  return { count: async () => count, first: () => tag, tag };
}

function makeFakePage(counts) {
  return {
    getByRole: (role) => makeLocator(counts[role] ?? 0, `role:${role}`),
    getByPlaceholder: () => makeLocator(counts.placeholder ?? 0, 'placeholder'),
    getByText: () => makeLocator(counts.text ?? 0, 'text'),
    getByLabel: () => makeLocator(counts.label ?? 0, 'label'),
    getByTestId: (id) => makeLocator(1, `testId:${id}`),
    locator: (sel) => makeLocator(1, `selector:${sel}`),
  };
}

describe('resolveClickable priority order', () => {
  test('falls all the way through to text when nothing else matches', async () => {
    const page = makeFakePage({ text: 1 });
    assert.equal(await resolveClickable(page, 'Save'), 'text');
  });

  test('prefers button over link, menuitem, option, placeholder, and text', async () => {
    const page = makeFakePage({ button: 1, link: 1, menuitem: 1, option: 1, placeholder: 1, text: 1 });
    assert.equal(await resolveClickable(page, 'Save'), 'role:button');
  });

  test('prefers link over menuitem/option/placeholder/text when no button matches', async () => {
    const page = makeFakePage({ link: 1, menuitem: 1, text: 1 });
    assert.equal(await resolveClickable(page, 'Save'), 'role:link');
  });

  test('falls back to placeholder for a search-bar-styled clickable', async () => {
    const page = makeFakePage({ placeholder: 1, text: 1 });
    assert.equal(await resolveClickable(page, 'Search'), 'placeholder');
  });

  test('throws a descriptive error when nothing matches', async () => {
    const page = makeFakePage({});
    await assert.rejects(
      () => resolveClickable(page, 'Nonexistent Button', 20), // short timeout — keep the test fast
      /No clickable element found matching "Nonexistent Button"/,
    );
  });

  test('retries until timeoutMs before giving up (covers a click right after navigation)', async () => {
    // A real Playwright locator re-queries the live DOM on every .count()
    // call — this mock's count() must be re-evaluated per call too, not
    // captured once when the locator is constructed.
    let pollCount = 0;
    const buttonLocator = {
      count: async () => { pollCount++; return pollCount >= 3 ? 1 : 0; }, // "appears" on the 3rd poll
      first: () => 'role:button',
    };
    const page = {
      getByRole: (role) => (role === 'button' ? buttonLocator : makeLocator(0, `role:${role}`)),
      getByPlaceholder: () => makeLocator(0, 'placeholder'),
      getByText: () => makeLocator(0, 'text'),
    };
    assert.equal(await resolveClickable(page, 'Save', 2000), 'role:button');
  });
});

describe('resolveInput priority order', () => {
  test('prefers textbox role over placeholder/label', async () => {
    const page = makeFakePage({ textbox: 1, placeholder: 1, label: 1 });
    assert.equal(await resolveInput(page, 'Search'), 'role:textbox');
  });

  test('prefers combobox role over a same-named button/placeholder match', async () => {
    // Regression case: a trigger *button* can share the input's aria-label,
    // so role-based matches must be tried before getByLabel/getByPlaceholder.
    const page = makeFakePage({ combobox: 1, placeholder: 1, label: 1 });
    assert.equal(await resolveInput(page, 'Search'), 'role:combobox');
  });

  test('falls back to placeholder, then label, when no input role matches', async () => {
    const page = makeFakePage({ placeholder: 1, label: 1 });
    assert.equal(await resolveInput(page, 'Search'), 'placeholder');

    const page2 = makeFakePage({ label: 1 });
    assert.equal(await resolveInput(page2, 'Search'), 'label');
  });

  test('throws a descriptive error when nothing matches', async () => {
    const page = makeFakePage({});
    await assert.rejects(
      () => resolveInput(page, 'Nonexistent Field', 20), // short timeout — keep the test fast
      /No input field found matching "Nonexistent Field"/,
    );
  });
});

describe('locatorFor', () => {
  const page = makeFakePage({ text: 1 });

  test('role/testId/text/selector steps bypass the smart resolver', async () => {
    // These return the raw locator directly (not resolved via .first()) —
    // that resolution only happens inside the click/fill smart matcher.
    assert.equal((await locatorFor(page, { testId: 'submit-btn' })).tag, 'testId:submit-btn');
    assert.equal((await locatorFor(page, { selector: '#foo' })).tag, 'selector:#foo');
  });

  test('a click step delegates to resolveClickable', async () => {
    assert.equal(await locatorFor(page, { click: 'Save' }), 'text');
  });

  test('a step with no locator field returns null', async () => {
    assert.equal(await locatorFor(page, { say: 'just narration' }), null);
  });
});

describe('computeHold', () => {
  test('a plain wait step holds exactly that long, no narration floor applied', () => {
    assert.equal(computeHold({ wait: 500 }, 0), 500);
  });

  test('no wait and no narration holds 0ms', () => {
    assert.equal(computeHold({}, 0), 0);
  });

  test('narration extends the hold past a too-short explicit wait', () => {
    assert.equal(computeHold({ say: 'hi', wait: 100 }, 2000), 2300); // narrationMs + 300
  });

  test('an explicit wait longer than the narration wins', () => {
    assert.equal(computeHold({ say: 'hi', wait: 5000 }, 2000), 5000);
  });
});

describe('escapeHtml', () => {
  test('escapes all five HTML-significant characters', () => {
    assert.equal(escapeHtml(`<script>alert("hi") & 'bye'</script>`),
      '&lt;script&gt;alert(&quot;hi&quot;) &amp; &#39;bye&#39;&lt;/script&gt;');
  });

  test('leaves plain text untouched', () => {
    assert.equal(escapeHtml('Cloudflare Domains Demo'), 'Cloudflare Domains Demo');
  });
});

describe('slideHtml', () => {
  test('includes the escaped title and omits the subtitle paragraph when absent', () => {
    const html = slideHtml('Demo <Title>', undefined);
    assert.match(html, /<h1>Demo &lt;Title&gt;<\/h1>/);
    assert.doesNotMatch(html, /<p>/);
  });

  test('includes an escaped subtitle paragraph when given', () => {
    const html = slideHtml('Title', `A "quick" tour`);
    assert.match(html, /<p>A &quot;quick&quot; tour<\/p>/);
  });
});
