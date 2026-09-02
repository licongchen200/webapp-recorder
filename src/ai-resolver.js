// Optional AI-assisted element resolution. Only runs when the deterministic
// heuristics in resolveClickable/resolveInput already failed to find a
// match, and only when explicitly opted into via .env — costs real API
// money per fallback call, so it never fires silently.
//
// Approach: extract the visible interactive elements as a compact JSON list
// (role, text, placeholder — not a screenshot) and ask Claude to pick an
// index via a forced tool call. Cheaper, faster, and more precise than
// vision + click-coordinates, and the result becomes a real Playwright
// locator (via a temporary DOM marker), so it plugs into the existing
// clickWithCursor/fillWithCursor animation exactly like any other locator.
const AI_MODEL = 'claude-opus-5';

function isAiEnabled() {
  return process.env.ENABLE_AI === 'true' && !!process.env.ANTHROPIC_API_KEY;
}

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

async function askClaudeForIndex(candidates, description, kind) {
  // Lazy require: keeps @anthropic-ai/sdk optional at runtime for anyone
  // who never enables AI (it's still a normal npm dependency, just unused).
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();

  const response = await client.messages.create({
    model: AI_MODEL,
    max_tokens: 1024,
    tools: [{
      name: 'select_element',
      description: 'Selects the page element that best matches the requested target, by index.',
      input_schema: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'Index of the best-matching element, or -1 if none plausibly match.' },
        },
        required: ['index'],
        additionalProperties: false,
      },
      strict: true,
    }],
    tool_choice: { type: 'tool', name: 'select_element' },
    messages: [{
      role: 'user',
      content: `A user wants to ${kind === 'fill' ? 'type into' : 'click'} the element described as `
        + `"${description}" on a web page.\n\n`
        + `Visible interactive elements (JSON array, one per candidate):\n${JSON.stringify(candidates)}\n\n`
        + `Return the index of the element that best matches "${description}". Return -1 if none plausibly match.`,
    }],
  });

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  return toolUse?.input?.index;
}

async function resolveWithAI(page, description, kind) {
  if (!isAiEnabled()) {
    throw new Error('AI fallback not enabled — set ENABLE_AI=true and ANTHROPIC_API_KEY in .env');
  }

  const candidates = await collectCandidates(page);
  if (candidates.length === 0) {
    throw new Error(`AI fallback: no visible interactive elements found for "${description}"`);
  }

  const index = await askClaudeForIndex(candidates, description, kind);
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

module.exports = { isAiEnabled, withAiFallback, resolveWithAI, collectCandidates };
