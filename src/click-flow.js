const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { withAiFallback } = require('./ai-resolver.js');

// Draws a fake cursor + click-ripple as a page overlay. Playwright's clicks
// are synthetic (dispatched via CDP), so the real OS cursor never moves —
// this is what actually shows up in a screen recording.
const CURSOR_INIT = `
(() => {
  const style = document.createElement('style');
  style.textContent = \`
    #__demo-cursor {
      position: fixed; left: -100px; top: -100px; width: 24px; height: 24px;
      pointer-events: none; z-index: 2147483647;
      background: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'><path d='M2 2 L2 20 L7 15 L10 22 L13 21 L10 14 L17 14 Z' fill='black' stroke='white' stroke-width='1.5'/></svg>") no-repeat;
      transition: left 500ms cubic-bezier(.4,0,.2,1), top 500ms cubic-bezier(.4,0,.2,1);
    }
    .__demo-ripple {
      position: fixed; width: 36px; height: 36px; margin-left: -18px; margin-top: -18px;
      border-radius: 50%; background: rgba(255,90,0,0.35); border: 2px solid rgba(255,90,0,0.85);
      pointer-events: none; z-index: 2147483647;
      animation: __demo-ripple-anim 500ms ease-out forwards;
    }
    @keyframes __demo-ripple-anim {
      from { transform: scale(0.2); opacity: 1; }
      to { transform: scale(1.6); opacity: 0; }
    }
  \`;
  document.head.appendChild(style);
  const cursor = document.createElement('div');
  cursor.id = '__demo-cursor';
  document.body.appendChild(cursor);
})();
`;

// Captures the page's own rendering via page.screenshot() (CDP) on a timer,
// instead of OS-level screen capture — immune to other windows covering the
// screen, no Screen Recording permission, no window-position math needed.
// Records each frame's *actual* elapsed time (not an assumed rate), same as
// the narration timing, so the assembled video always matches real duration.
function startFrameCapture(page, dir, minIntervalMs) {
  fs.mkdirSync(dir, { recursive: true });
  const frames = [];
  const t0 = Date.now();
  let stopped = false;
  let i = 0;
  let tick = 0;

  const loop = (async () => {
    while (!stopped) {
      // Periodically re-assert this tab as frontmost: during a long idle
      // hold (e.g. a large holdMs with no clicks), Chrome's compositor can
      // decide a tab that's lost visibility doesn't need painting and
      // starts returning blank/black screenshots. This is cheap insurance
      // regardless of what actually stole visibility.
      if (tick % 10 === 0) await page.bringToFront().catch(() => {});
      tick++;

      const file = path.join(dir, `frame-${String(i).padStart(6, '0')}.jpg`);
      try {
        await page.screenshot({ path: file, type: 'jpeg', quality: 85 });
        frames.push({ file, tSec: (Date.now() - t0) / 1000 });
        i++;
      } catch {
        // page mid-navigation; skip this tick, try again next loop
      }
      await new Promise((r) => setTimeout(r, minIntervalMs));
    }
  })();

  return {
    stop: async () => {
      stopped = true;
      await loop;
      // Stamp the true end time onto a copy of the last frame, so the
      // assembled video's final hold matches how long the flow actually
      // ran instead of a guessed fallback duration.
      if (frames.length > 0) {
        frames.push({ file: frames[frames.length - 1].file, tSec: (Date.now() - t0) / 1000 });
      }
      return frames;
    },
  };
}

async function moveCursorTo(page, locator) {
  const box = await locator.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.evaluate(({ x, y }) => {
    const c = document.getElementById('__demo-cursor');
    c.style.left = x + 'px';
    c.style.top = y + 'px';
  }, { x, y });
  await page.waitForTimeout(550); // let the move transition play
}

async function rippleAt(page, x, y) {
  await page.evaluate(({ x, y }) => {
    const r = document.createElement('div');
    r.className = '__demo-ripple';
    r.style.left = x + 'px';
    r.style.top = y + 'px';
    document.body.appendChild(r);
    setTimeout(() => r.remove(), 550);
  }, { x, y });
}

async function clickWithCursor(page, locator) {
  await moveCursorTo(page, locator);
  const box = await locator.boundingBox();
  await rippleAt(page, box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(150);
  await locator.click();
  await page.waitForTimeout(300);
  // A click can trigger an SPA route change that repaints well after the
  // click resolves; without this the recording can end mid-transition.
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
}

async function fillWithCursor(page, locator, value) {
  await moveCursorTo(page, locator);
  const box = await locator.boundingBox();
  await rippleAt(page, box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(150);
  await locator.click();
  await locator.pressSequentially(value, { delay: 60 }); // visible typing effect
  await page.waitForTimeout(300);
}

// Tries each candidate locator in priority order and uses the first one that
// actually matches something on the page right now — lets a step just name
// what a person would see ("Domains", "Search domains...") instead of
// requiring a prior DOM-inspection/recording pass to find exact selectors.
// Retries for up to timeoutMs: a bare .count() is a one-shot snapshot with
// no auto-wait, so a click attempted right after navigation (e.g. right
// after an intro slide's goto()) can hit the DOM before an SPA has
// rendered — this is what Playwright's own locator actions auto-wait for.
async function firstMatch(candidates, description, kind, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const loc of candidates) {
      if (await loc.count() > 0) return loc.first();
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`No ${kind} found matching "${description}"`);
}

function resolveClickable(page, description, timeoutMs) {
  return firstMatch([
    page.getByRole('button', { name: description }),
    page.getByRole('link', { name: description }),
    page.getByRole('menuitem', { name: description }),
    page.getByRole('option', { name: description }), // e.g. a search/combobox result row
    page.getByPlaceholder(description), // e.g. a search-bar-styled input, no real text node
    page.getByText(description, { exact: false }),
  ], description, 'clickable element', timeoutMs);
}

function resolveInput(page, description, timeoutMs) {
  return firstMatch([
    // Role-based first: guaranteed to be an actual form control, unlike
    // getByLabel/getByPlaceholder which can accidentally match a *button*
    // whose aria-label happens to equal the description (e.g. a search
    // trigger button left behind, now hidden under the opened popup).
    page.getByRole('textbox', { name: description }),
    page.getByRole('searchbox', { name: description }),
    page.getByRole('combobox', { name: description }), // e.g. an autocomplete/search-palette input
    page.getByPlaceholder(description),
    page.getByLabel(description),
  ], description, 'input field', timeoutMs);
}

// Step shape: a locator via one of —
//   { click: "<visible label>" }          — smart match: button, then link, then text
//   { fill: "<field label/placeholder>", value: "<text>" } — smart match input, types it
//   { role, name?, exact? } / { testId } / { text, exact? } / { selector }  — precise, for
//     when a step needs disambiguating (e.g. two elements share the same label)
// plus optional "say" (narration text) and "wait" (minimum hold time in ms after the step).
async function locatorFor(page, step) {
  if (step.role) return page.getByRole(step.role, step.name ? { name: step.name, exact: !!step.exact } : undefined);
  if (step.testId) return page.getByTestId(step.testId);
  if (step.text) return page.getByText(step.text, { exact: !!step.exact });
  if (step.selector) return page.locator(step.selector);
  if (step.click) return resolveClickable(page, step.click);
  return null;
}

// How long to hold after a step: an explicit "wait" is a floor; narration
// (when present) extends that floor so the audio never gets cut off.
function computeHold(step, narrationMs) {
  const minWait = step.wait || 0;
  return step.say ? Math.max(minWait, narrationMs + 300) : minWait;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// A polished, theme-neutral title card — a soft gradient, a small accent
// bar, and real typographic hierarchy, but no app-specific branding, so it
// works the same for any flow.
function slideHtml(title, subtitle) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;
      background:radial-gradient(circle at 25% 20%, #1e293b 0%, #0f172a 55%, #0a0f1c 100%);
      color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
      display:flex;align-items:center;justify-content:center;}
    .card{max-width:920px;padding:0 64px;text-align:center;}
    .accent{width:72px;height:5px;margin:0 auto 32px;border-radius:3px;
      background:linear-gradient(90deg,#38bdf8,#818cf8);}
    h1{font-size:60px;font-weight:800;letter-spacing:-0.02em;line-height:1.15;margin:0;}
    p{font-size:23px;font-weight:400;color:#94a3b8;margin:22px 0 0;line-height:1.55;}
  </style></head><body>
    <div class="card">
      <div class="accent"></div>
      <h1>${escapeHtml(title)}</h1>
      ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}
    </div>
  </body></html>`;
}

// Renders a pre-resolved intro/outro slide (see synthesize-narration.js —
// content and any AI generation are resolved *before* recording starts,
// same as step narration) on the same page/tab already being
// screenshotted — the continuously-running frame capture picks it up
// naturally, no separate frame-splicing needed. Narration (if any) is
// logged into narrationEvents at the moment the slide appears, same
// mechanism as step narration.
async function showSlide(page, slideData, defaultWaitMs, startMs, narrationEvents) {
  if (!slideData) return;
  const { title, subtitle, narration, wait } = slideData;
  // page.setContent() can fail outright ("requires TrustedHTML assignment")
  // on a page whose own CSP enforces Trusted Types (Cloudflare's dashboard
  // does, at least on some routes) — about:blank has no CSP, so land there
  // first regardless of what page the flow is currently on.
  await page.goto('about:blank');
  await page.setContent(slideHtml(title, subtitle));

  let hold = wait ?? defaultWaitMs;
  if (narration) {
    const offsetSec = (Date.now() - startMs) / 1000;
    narrationEvents.push({ offsetSec, file: narration.file, durationSec: narration.durationSec });
    hold = Math.max(hold, narration.durationSec * 1000 + 300);
  }
  await page.waitForTimeout(hold);
}

// Drives one flow (intro slide -> goto -> steps -> outro slide) against an
// already-connected page, collecting narration events as it goes. This is
// the actual orchestration logic — split out from main() so it's testable
// with a fake page, independent of the real Chrome/CDP connection (which
// isn't something a unit test should depend on).
async function runFlow(page, flow, { startMs, narrationPlan, slidesPlan }) {
  const narrationEvents = [];

  await showSlide(page, slidesPlan.intro, 3000, startMs, narrationEvents);

  await page.goto(flow.url);
  await page.evaluate(CURSOR_INIT); // apply to the already-loaded document too

  let stepIndex = 0;
  for (const step of flow.steps) {
    let narrationMs = 0;
    if (step.say) {
      const offsetSec = (Date.now() - startMs) / 1000;
      const planned = narrationPlan[stepIndex];
      if (!planned) throw new Error(`No pre-synthesized narration for step ${stepIndex}`);
      narrationEvents.push({ offsetSec, file: planned.file, durationSec: planned.durationSec });
      narrationMs = planned.durationSec * 1000;
    }

    if (step.fill !== undefined) {
      // AI fallback (opt-in via .env) only wraps the smart click/fill
      // resolvers — role/testId/text/selector steps stay AI-free since
      // they're already a precise escape hatch.
      const input = await withAiFallback(resolveInput, page, step.fill, 'fill');
      await fillWithCursor(page, input, step.value ?? '');
    } else if (step.click) {
      const locator = await withAiFallback(resolveClickable, page, step.click, 'click');
      await clickWithCursor(page, locator);
    } else {
      const locator = await locatorFor(page, step);
      if (locator) await clickWithCursor(page, locator);
    }

    const hold = computeHold(step, narrationMs);
    if (hold > 0) await page.waitForTimeout(hold);

    stepIndex++;
  }

  await page.waitForTimeout(flow.holdMs ?? 2000); // hold the final frame

  await showSlide(page, slidesPlan.outro, 2500, startMs, narrationEvents);

  return narrationEvents;
}

// Attaches to the already-open, already-logged-in Chrome (debug port 9222)
// instead of launching a fresh automated browser — reuses its trusted
// session/fingerprint so any bot-detection (Cloudflare, Google SSO, etc.)
// doesn't re-trigger on a page that's already fully authenticated.
async function main() {
  try {
    process.loadEnvFile(); // loads .env from cwd if present — optional, no error if missing
  } catch {
    // no .env file — fine, AI fallback (ENABLE_AI) just stays disabled
  }

  const flowPath = process.argv[2];
  if (!flowPath) throw new Error('Usage: node click-flow.js <flow.json>');
  const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));

  const startMs = process.env.START_MS ? Number(process.env.START_MS) : Date.now();
  const narrationLog = process.env.NARRATION_LOG
    || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cf-narration-')), 'events.json');
  const framesDir = process.env.FRAMES_DIR
    || fs.mkdtempSync(path.join(os.tmpdir(), 'cf-frames-'));
  const framesManifest = process.env.FRAMES_MANIFEST || path.join(framesDir, 'frames.json');
  // Pre-generated by synthesize-narration.js *before* recording starts, so no
  // slow/variable `say`/ffprobe calls run during the actual recording.
  const narrationPlan = process.env.NARRATION_PLAN
    ? JSON.parse(fs.readFileSync(process.env.NARRATION_PLAN, 'utf8'))
    : [];
  const slidesPlan = process.env.SLIDES_PLAN
    ? JSON.parse(fs.readFileSync(process.env.SLIDES_PLAN, 'utf8'))
    : {};

  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const context = browser.contexts()[0];
  const page = context.pages()[0] || (await context.newPage());
  await page.bringToFront();
  await context.addInitScript(CURSOR_INIT); // re-applies on any in-flow navigation

  const capture = startFrameCapture(page, framesDir, 100); // ~10fps
  const narrationEvents = await runFlow(page, flow, { startMs, narrationPlan, slidesPlan });
  const frames = await capture.stop();

  fs.writeFileSync(framesManifest, JSON.stringify(frames));
  fs.writeFileSync(narrationLog, JSON.stringify(narrationEvents));

  await browser.close(); // just detaches, doesn't close your Chrome
}

if (require.main === module) {
  main();
}

module.exports = {
  firstMatch, resolveClickable, resolveInput, locatorFor, computeHold,
  escapeHtml, slideHtml, runFlow,
};
