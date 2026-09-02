// Resolves the content (title + optional subtitle + optional narration) for
// an intro/outro title card. Called during pre-synthesis (before recording
// starts), same as narration TTS — any AI generation is slow/variable and
// must never run live during the recording itself.
//
// Four ways to specify a flow's "intro"/"outro" field:
//   "Some title text"                             — literal, no AI, free
//   { title: "...", subtitle: "...", say: "..." } — literal, no AI, free
//   true                                            — LLM writes title,
//   { generate: true | "<hint>", say?: "..." }       subtitle, and narration
//                                                     from the flow's own
//                                                     step narration (+
//                                                     optional hint) —
//                                                     requires the AI
//                                                     fallback to be
//                                                     configured (same .env
//                                                     as ai-resolver.js). An
//                                                     explicit "say" always
//                                                     wins over generated
//                                                     narration.
const { getAiConfig, callTool } = require('./llm.js');

const GENERATE_SLIDE_TOOL = {
  name: 'generate_slide',
  description: 'Generates title-card text (and optional spoken narration) for a demo video slide.',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short, punchy title, ideally under 8 words.' },
      subtitle: { type: 'string', description: 'Optional one-sentence subtitle elaborating on the title. Omit if it adds nothing.' },
      narration: { type: 'string', description: 'Optional 1-2 sentence spoken narration line for this slide, phrased naturally for text-to-speech (can differ from the title/subtitle wording). Omit if not useful.' },
    },
    required: ['title'],
  },
};

async function generateSlideContent(flow, hint, config) {
  const narration = flow.steps.map((s) => s.say).filter(Boolean).join(' ');
  const prompt = 'Write short title-card text (and, if it helps, a spoken narration line) for a demo video.\n'
    + `Page: ${flow.url}\n`
    + `What the demo does (from its own narration): ${narration || '(no narration provided)'}\n`
    + (hint ? `Extra guidance: ${hint}\n` : '')
    + 'Keep the title under 8 words.';

  const result = await callTool(GENERATE_SLIDE_TOOL, prompt, config);
  if (!result?.title) throw new Error('Slide generation returned no title');
  return { title: result.title, subtitle: result.subtitle, narration: result.narration };
}

// Returns { title, subtitle, say } — say is the (optional) narration text,
// ready to be handed to the TTS synthesizer alongside step narration.
async function resolveSlideContent(flow, spec) {
  if (typeof spec === 'string') return { title: spec, subtitle: undefined, say: undefined };

  const normalized = spec === true ? { generate: true } : spec;
  if (!normalized.generate) {
    return { title: normalized.title, subtitle: normalized.subtitle, say: normalized.say };
  }

  const config = getAiConfig();
  if (!config.enabled) {
    throw new Error(
      'Slide "generate" requires AI — set ENABLE_AI=true and a provider key in .env, '
      + 'or give a literal "title" instead.',
    );
  }
  const hint = typeof normalized.generate === 'string' ? normalized.generate : '';
  const generated = await generateSlideContent(flow, hint, config);
  return {
    title: generated.title,
    subtitle: generated.subtitle,
    say: normalized.say || generated.narration, // an explicit "say" always wins
  };
}

module.exports = { resolveSlideContent };
