# webapp-recorder

Scripted, narrated screen recordings of any logged-in web app. Describe a
click path in plain labels — no DOM inspection, no codegen/recording
session, no exact selectors required.

## Setup (once per machine)

```bash
npm install          # installs Playwright
npx playwright install chromium   # only needed if you don't already have Chrome
brew install ffmpeg  # if not already installed
```

macOS only — it uses `say` for narration and reads Chrome's window/rendering
directly.

## Usage (each recording)

**1. Launch a real Chrome with a debug port**, using a dedicated profile so
it doesn't touch your everyday browsing session:

```bash
open -a "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir="$HOME/chrome-recorder-profile"
```

**2. Log in manually** in that window — SSO, 2FA, whatever the app needs.
This is a real login in a real browser, so nothing about it looks automated;
it's the same window the recording will drive later. Leave it open on the
page you want the recording to start from.

**3. Write a flow** describing the steps in plain labels — whatever text you
see on screen:

```json
{
  "url": "https://example.com/dashboard",
  "voice": "Samantha",
  "steps": [
    { "say": "Let's check the billing page." },
    { "click": "Settings" },
    { "click": "Billing", "say": "Open Billing from the menu." },
    { "fill": "Search invoices", "value": "March", "wait": 1500 }
  ],
  "holdMs": 3000
}
```

Save it anywhere, e.g. `flows/my-flow.json`.

**4. Record it:**

```bash
./record.sh flows/my-flow.json
```

The finished video lands in `videos/` (e.g. `videos/my-flow-20260901-223714.mov`).

**5. Re-run anytime** the login session is still valid — just call
`./record.sh` again (same or a different flow file) without repeating steps
1–2. If the tab's session expires, redo steps 1–2.

If a step can't find its target (wrong label, or an app with poor
accessibility markup), see **Known limits** below before rewriting the flow.

## How it works

- Attaches to a Chrome tab you logged into manually (`--remote-debugging-port=9222`),
  so SSO/2FA/bot-detection (Cloudflare, Google, etc.) never sees automation —
  it's a real login, done once.
- Each step's `click`/`fill` target is resolved at runtime by trying several
  strategies in order (button → link → menuitem → option → placeholder → text
  for clicks; textbox → searchbox → combobox → placeholder → label for
  fills) and using whichever one actually matches something on the page —
  the same way a person would describe "the Billing button", not a CSS path.
- Records the page's own rendering via `page.screenshot()` over CDP, not the
  OS screen — immune to other windows covering the screen, no Screen
  Recording permission needed.
- Narration is synthesized up front (before recording starts), then muxed
  onto the video at the recorded timestamp for each step. Two engines —
  macOS's built-in `say` (default, zero setup) or Piper (`npm run tts:setup`
  once; free, local, neural, noticeably smoother — set `"tts": "piper"` in
  the flow).
- A step's `wait` (explicit hold) and narration duration both extend how
  long the page stays visible before moving on.

## Step reference

| Field | Meaning |
|---|---|
| `click: "<label>"` | Click whatever matches this label (button, link, menu item, search result, or a search-bar-styled input) |
| `fill: "<label>", value: "<text>"` | Type into whatever input matches this label, with a visible typing animation |
| `role`, `testId`, `text`, `selector` | Precise locator escape hatches, for when a label is ambiguous |
| `say: "<narration>"` | Text-to-speech narration for this step |
| `wait: <ms>` | Minimum hold time after the step |
| `holdMs` (top-level) | How long to hold the final frame before stopping |
| `voice` (top-level) | `say` voice name (`say -v '?'` lists options). Ignored if `tts: "piper"` |
| `tts` (top-level) | `"say"` (default) or `"piper"` — narration engine |
| `piperModel` (top-level) | Path to a Piper `.onnx` voice model. Defaults to `tts-models/en_US-lessac-high.onnx` |

### Better narration quality

macOS's default `say` voices (e.g. `Samantha`) are serviceable but robotic.
Two ways to improve, free:

- **macOS Enhanced/Premium voices** — System Settings → search "Spoken
  Content" (location varies by macOS version) → System Voice → Manage
  Voices → download an Enhanced/Premium voice (e.g. `Ava (Premium)`). Zero
  code changes — just put the exact name in `voice`. Requires the GUI;
  there's no CLI installer for these.
- **Piper (recommended, more reliable to set up)** — free local neural TTS,
  runs offline, no account or API key:
  ```bash
  npm run tts:setup
  ```
  Then set `"tts": "piper"` in your flow. Noticeably smoother than compact
  `say` voices; not quite ElevenLabs-tier, but no cost and no network call.

## Known limits

- The label-matching resolver is deterministic by default (plain Playwright
  locators, no AI, zero cost) — it needs the actual visible text/label, not
  a paraphrase, and works best on apps with reasonable accessibility markup.
  Apps that are icon-only, canvas-rendered, or have no semantic roles at all
  will need a precise `role`/`testId`/`selector` step instead of
  `click`/`fill`, or the optional AI fallback below.
- Occasionally an app's label renders with unexpected whitespace/punctuation
  (e.g. `"Overview—Domains"` with no spaces) — if a step can't find its
  target, a one-time DOM inspection of that element is the fix, not a
  rewrite of the flow.

## Optional AI fallback

Off by default, zero behavior change unless you opt in. When a `click`/`fill`
step's deterministic resolver finds nothing, it can retry once via an LLM:
the visible interactive elements on the page (role, text, placeholder — not
a screenshot) are sent as a compact list, and the model picks the best match
by index via a forced tool call, which becomes a real Playwright locator.
This is what makes an icon-only button or a non-standard custom widget
usable from a plain-language `click`/`fill` description without hand-writing
a `selector`.

Two providers:

| Provider | `AI_PROVIDER` | Key | Default model |
|---|---|---|---|
| Anthropic (Claude) | `anthropic` (default) | `ANTHROPIC_API_KEY` | `claude-opus-5` |
| OpenRouter (any hosted model) | `openrouter` | `OPENROUTER_API_KEY` | `qwen/qwen3.7-flash` |

**Enable it:**

```bash
cp .env.example .env
# then edit .env, e.g. for OpenRouter/Qwen:
#   ENABLE_AI=true
#   AI_PROVIDER=openrouter
#   OPENROUTER_API_KEY=sk-or-...
```

`ENABLE_AI=true` plus the selected provider's key are both required —
missing either leaves it off (and the wrong provider's key being set doesn't
count: `AI_PROVIDER=openrouter` with only `ANTHROPIC_API_KEY` set stays
disabled). Override the model per provider with `ANTHROPIC_MODEL` /
`OPENROUTER_MODEL`. Costs a small amount of real API spend per fallback
call (fractions of a cent — a Qwen fallback call runs about $0.00002),
only when the free heuristics already failed — never on a step that
resolves normally. `.env` is gitignored; never commit your key.
