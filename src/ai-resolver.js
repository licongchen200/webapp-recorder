// Optional AI-assisted element resolution. Only runs when the deterministic
// heuristics in resolveClickable/resolveInput already failed to find a
// match, and only when explicitly opted into via .env — costs real API
// money per fallback call, so it never fires silently.
//
// Approach: extract the visible interactive elements as a compact JSON list
// (role, text, placeholder — not a screenshot) and ask the model to pick an
// index via a forced tool/function call. Cheaper, faster, and more precise
// than vision + click-coordinates, and the result becomes a real Playwright
// locator (via a temporary DOM marker), so it plugs into the existing
// clickWithCursor/fillWithCursor animation exactly like any other locator.
//
// Two providers, picked via AI_PROVIDER in .env:
//   "anthropic"  (default) — Claude, via the official @anthropic-ai/sdk
//   "openrouter"            — any OpenRouter-hosted model (e.g. Qwen),
//                             via OpenRouter's OpenAI-compatible HTTP API
//                             (plain fetch — no SDK needed for that)
const DEFAULT_MODEL = {
  anthropic: 'claude-opus-5',
  openrouter: 'qwen/qwen3.7-flash',
};

// Reads .env-provided config; returns { enabled: false } unless AI is fully
// configured for the selected provider (ENABLE_AI=true + that provider's key).
function getAiConfig() {
  if (process.env.ENABLE_AI !== 'true') return { enabled: false };
  const provider = process.env.AI_PROVIDER === 'openrouter' ? 'openrouter' : 'anthropic';
  const apiKey = provider === 'openrouter' ? process.env.OPENROUTER_API_KEY : process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { enabled: false };
  const model = (provider === 'openrouter' ? process.env.OPENROUTER_MODEL : process.env.ANTHROPIC_MODEL)
    || DEFAULT_MODEL[provider];
  return { enabled: true, provider, apiKey, model };
}

function isAiEnabled() {
  return getAiConfig().enabled;
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

function buildPrompt(candidates, description, kind) {
  return `A user wants to ${kind === 'fill' ? 'type into' : 'click'} the element described as `
    + `"${description}" on a web page.\n\n`
    + `Visible interactive elements (JSON array, one per candidate):\n${JSON.stringify(candidates)}\n\n`
    + `Return the index of the element that best matches "${description}". Return -1 if none plausibly match.`;
}

const SELECT_ELEMENT_DESCRIPTION = 'Selects the page element that best matches the requested target, by index.';
const INDEX_PARAM_DESCRIPTION = 'Index of the best-matching element, or -1 if none plausibly match.';

async function askClaudeForIndex(candidates, description, kind, config) {
  // Lazy require: keeps @anthropic-ai/sdk optional at runtime for anyone
  // who never enables AI (it's still a normal npm dependency, just unused).
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.apiKey });

  const response = await client.messages.create({
    model: config.model,
    max_tokens: 1024,
    tools: [{
      name: 'select_element',
      description: SELECT_ELEMENT_DESCRIPTION,
      input_schema: {
        type: 'object',
        properties: { index: { type: 'integer', description: INDEX_PARAM_DESCRIPTION } },
        required: ['index'],
        additionalProperties: false,
      },
      strict: true,
    }],
    tool_choice: { type: 'tool', name: 'select_element' },
    messages: [{ role: 'user', content: buildPrompt(candidates, description, kind) }],
  });

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  return toolUse?.input?.index;
}

async function askOpenRouterForIndex(candidates, description, kind, config) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: buildPrompt(candidates, description, kind) }],
      tools: [{
        type: 'function',
        function: {
          name: 'select_element',
          description: SELECT_ELEMENT_DESCRIPTION,
          parameters: {
            type: 'object',
            properties: { index: { type: 'integer', description: INDEX_PARAM_DESCRIPTION } },
            required: ['index'],
          },
        },
      }],
      tool_choice: { type: 'function', function: { name: 'select_element' } },
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) return undefined;
  return JSON.parse(toolCall.function.arguments).index;
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

  const index = config.provider === 'openrouter'
    ? await askOpenRouterForIndex(candidates, description, kind, config)
    : await askClaudeForIndex(candidates, description, kind, config);

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
