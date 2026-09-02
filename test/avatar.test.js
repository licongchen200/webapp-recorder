const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { resolveConfig, buildFilterComplex, POSITIONS } = require('../src/avatar.js');

const events = [
  { offsetSec: 1.0, file: 'narr-0.wav' },
  { offsetSec: 5.25, file: 'narr-1.wav' },
];
const clips = [{ mp4: 'a0.mp4', sec: 2.0 }, { mp4: 'a1.mp4', sec: 3.0 }];
const cfg = { position: 'bottom-right', size: 280, margin: 48 };

describe('avatar overlay', () => {
  test('each clip is time-shifted to its narration offset and shown only for its own window', () => {
    const f = buildFilterComplex(events, clips, cfg);

    assert.match(f, /setpts=PTS\+1\.000\/TB\[av0\]/);
    assert.match(f, /setpts=PTS\+5\.250\/TB\[av1\]/);
    // window = offset .. offset + clip duration
    assert.match(f, /enable='between\(t,1\.000,3\.000\)'/);
    assert.match(f, /enable='between\(t,5\.250,8\.250\)'/);
  });

  test('overlays chain off the base video and end on [vout]', () => {
    const f = buildFilterComplex(events, clips, cfg);

    assert.match(f, /\[0:v\]\[still\]overlay=/, 'still composites onto the screencast first');
    assert.match(f, /\[base\]\[av0\]overlay=/, 'first clip composites onto the still layer');
    assert.match(f, /\[v0\]\[av1\]overlay=/, 'second clip composites onto the first result');
    assert.ok(f.trim().endsWith('[vout]'), 'last overlay must produce the mapped label');
    assert.equal(f.match(/\[vout\]/g).length, 1, 'exactly one [vout]');
  });

  // Regression: gating only the clips made the avatar disappear between
  // narration lines — which is exactly when navigations and slide changes
  // happen, so it vanished on every screen switch.
  test('a still layer is on screen for the whole video, ungated', () => {
    const f = buildFilterComplex(events, clips, cfg);
    const stillOverlay = f.split(';').find((p) => p.includes('[still]overlay='));

    assert.ok(stillOverlay, 'there must be a still overlay');
    assert.ok(!stillOverlay.includes('enable='), 'the still must NOT be time-gated');
    // Clip inputs shift to 2.. because input 1 is now the still.
    assert.match(f, /\[2:v\]/);
    assert.match(f, /\[3:v\]/);
  });

  // Regression: without eof_action=pass the filtergraph ends when the first
  // (short) avatar clip does, truncating the whole screencast to it.
  test('overlays pass through after their clip ends instead of ending the video', () => {
    const f = buildFilterComplex(events, clips, cfg);
    // one per clip, plus the still layer
    assert.equal(f.match(/eof_action=pass/g).length, events.length + 1);
    assert.equal(f.match(/repeatlast=0/g).length, events.length + 1);
  });

  test('circular cutout alpha uses the configured diameter', () => {
    const f = buildFilterComplex(events, clips, { ...cfg, size: 300 });
    assert.match(f, /scale=300:300/);
    assert.match(f, /pow\(X-300\/2,2\)\+pow\(Y-300\/2,2\),pow\(300\/2,2\)/);
  });

  test('every corner keeps the avatar inset by the margin, never flush to an edge', () => {
    for (const [name, fn] of Object.entries(POSITIONS)) {
      const [x, y] = fn(280, 48);
      assert.ok(x.includes('48'), `${name} x must include the margin, got ${x}`);
      assert.ok(y.includes('48'), `${name} y must include the margin, got ${y}`);
    }
    assert.deepEqual(POSITIONS['bottom-right'](280, 48), ['W-280-48', 'H-280-48']);
    assert.deepEqual(POSITIONS['top-left'](280, 48), ['48', '48']);
  });

  test('config defaults: disabled unless asked, wav2lip engine, inset corner', () => {
    assert.equal(resolveConfig({}).enabled, false);
    assert.equal(resolveConfig({ avatar: { enabled: true } }).engine, 'wav2lip');
    assert.equal(resolveConfig({ avatar: { enabled: true } }).position, 'bottom-right');
    assert.equal(resolveConfig({ avatar: { enabled: true } }).margin, 48);
    // margin: 0 is a deliberate choice and must survive the ?? default
    assert.equal(resolveConfig({ avatar: { enabled: true, margin: 0 } }).margin, 0);
  });
});
