// Shared LLM client for any optional AI feature (element-resolution
// fallback, slide-text generation, ...). Provider selection, enable/disable
// gating, and the actual Claude/OpenRouter request plumbing live here once
// so every feature that needs a structured (tool-call) response reuses the
// same two provider implementations instead of duplicating them.
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

// toolDef: { name, description, schema } where schema is a JSON Schema
// object ({ type: 'object', properties, required }) — provider-specific
// wrapping (input_schema vs parameters, additionalProperties, etc.) is
// handled here so callers only ever write the plain schema once.
async function callToolClaude(toolDef, promptText, config) {
  // Lazy require: keeps @anthropic-ai/sdk optional at runtime for anyone
  // who never enables AI (it's still a normal npm dependency, just unused).
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.apiKey });

  const response = await client.messages.create({
    model: config.model,
    max_tokens: 1024,
    tools: [{
      name: toolDef.name,
      description: toolDef.description,
      input_schema: { ...toolDef.schema, additionalProperties: false },
      strict: true,
    }],
    tool_choice: { type: 'tool', name: toolDef.name },
    messages: [{ role: 'user', content: promptText }],
  });

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  return toolUse?.input;
}

async function callToolOpenRouter(toolDef, promptText, config) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: promptText }],
      tools: [{
        type: 'function',
        function: { name: toolDef.name, description: toolDef.description, parameters: toolDef.schema },
      }],
      tool_choice: { type: 'function', function: { name: toolDef.name } },
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
  return toolCall ? JSON.parse(toolCall.function.arguments) : undefined;
}

// Calls the configured provider with a forced tool/function call and
// returns the parsed arguments object (e.g. { index: 3 } or { title: "..." }).
async function callTool(toolDef, promptText, config) {
  return config.provider === 'openrouter'
    ? callToolOpenRouter(toolDef, promptText, config)
    : callToolClaude(toolDef, promptText, config);
}

module.exports = { getAiConfig, isAiEnabled, callTool };
