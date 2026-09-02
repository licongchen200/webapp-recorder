// Optional AI-assisted element resolution. Only runs when the deterministic
// heuristics in resolveClickable/resolveInput already failed to find a
// match, and only when explicitly opted into via .env — costs real API
// money per fallback call, so it never fires silently.
//
// Approach: extract the visible interactive elements as a compact JSON list
// (role, text, placeholder — not a screenshot) and ask the model to pick an
// index via a forced tool/function call (see src/llm.js). Cheaper, faster,
// and more precise than vision + click-coordinates, and the result becomes
// a real Playwright locator (via a temporary DOM marker), so it plugs into
// the existing clickWithCursor/fillWithCursor animation exactly like any
// other locator.
const { getAiConfig, isAiEnabled, callTool } = require('./llm.js');

const CANDIDATE_SELECTOR = [
  'button', 'a', 'input', 'textarea', '[contenteditable="true"]',
  '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="option"]',
  '[role="textbox"]', '[role="searchbox"]', '[role="combobox"]',
].join(', ');

// Tags each visible candidate with a temporary data-ai-idx attribute (so it
// can be turned back into a real Playwright locator) and returns a compact
// description of each one for the prompt.
async function collectCandidates(page) {
  return page.evaluate((selector) => {
    const els = Array.from(document.querySelectorAll(selector));
    const candidates = [];
    for (const el of els) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      el.setAttribute('data-ai-idx', String(candidates.length));
      candidates.push({
        index: candidates.length,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || null,
        text: (el.innerText || el.value || '').trim().slice(0, 80),
        placeholder: el.getAttribute('placeholder') || null,
        ariaLabel: el.getAttribute('aria-label') || null,
      });
    }
    return candidates;
  }, CANDIDATE_SELECTOR);
}

const SELECT_ELEMENT_TOOL = {
  name: 'select_element',
  description: 'Selects the page element that best matches the requested target, by index.',
  schema: {
    type: 'object',
    properties: {
      index: { type: 'integer', description: 'Index of the best-matching element, or -1 if none plausibly match.' },
    },
    required: ['index'],
  },
};

function buildPrompt(candidates, description, kind) {
  return `A user wants to ${kind === 'fill' ? 'type into' : 'click'} the element described as `
    + `"${description}" on a web page.\n\n`
    + `Visible interactive elements (JSON array, one per candidate):\n${JSON.stringify(candidates)}\n\n`
    + `Return the index of the element that best matches "${description}". Return -1 if none plausibly match.`;
}

async function resolveWithAI(page, description, kind) {
  const config = getAiConfig();
  if (!config.enabled) {
    throw new Error(
      'AI fallback not enabled — set ENABLE_AI=true, AI_PROVIDER, and the matching API key in .env',
    );
  }

  const candidates = await collectCandidates(page);
  if (candidates.length === 0) {
    throw new Error(`AI fallback: no visible interactive elements found for "${description}"`);
  }

  const result = await callTool(SELECT_ELEMENT_TOOL, buildPrompt(candidates, description, kind), config);
  const index = result?.index;

  if (index === undefined || index === -1 || !candidates[index]) {
    throw new Error(`AI fallback: no confident match for "${description}"`);
  }

  return page.locator(`[data-ai-idx="${index}"]`);
}

// Wraps a deterministic resolver (resolveClickable/resolveInput): on
// failure, retries via AI only if enabled; otherwise rethrows the original
// error untouched — so with AI disabled, behavior is byte-for-byte the
// same as before this feature existed, at zero added cost or latency.
async function withAiFallback(resolveFn, page, description, kind) {
  try {
    return await resolveFn(page, description);
  } catch (err) {
    if (!isAiEnabled()) throw err;
    return resolveWithAI(page, description, kind);
  }
}

module.exports = { getAiConfig, isAiEnabled, withAiFallback, resolveWithAI, collectCandidates };
