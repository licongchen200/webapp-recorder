const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildFilterComplex, audioEndSec } = require('../src/mux-narration.js');

describe('buildFilterComplex', () => {
  test('delays each clip to its recorded offset and mixes without volume ducking', () => {
    const events = [
      { offsetSec: 0, file: 'a.aiff', durationSec: 2 },
      { offsetSec: 3.5, file: 'b.aiff', durationSec: 1 },
    ];
    const filter = buildFilterComplex(events);
    assert.equal(
      filter,
      '[1:a]adelay=delays=0:all=1[a0];[2:a]adelay=delays=3500:all=1[a1];'
      + '[a0][a1]amix=inputs=2:duration=longest:normalize=0[aout]',
    );
  });

  test('rounds fractional-millisecond offsets to the nearest ms', () => {
    const events = [{ offsetSec: 1.2345, file: 'a.aiff', durationSec: 1 }];
    const filter = buildFilterComplex(events);
    assert.match(filter, /adelay=delays=1235:/); // 1234.5ms rounds up
  });

  test('input indices are 1-based (input 0 is always the video)', () => {
    const events = [
      { offsetSec: 0, file: 'a.aiff', durationSec: 1 },
      { offsetSec: 1, file: 'b.aiff', durationSec: 1 },
      { offsetSec: 2, file: 'c.aiff', durationSec: 1 },
    ];
    const filter = buildFilterComplex(events);
    assert.match(filter, /\[1:a\]/);
    assert.match(filter, /\[2:a\]/);
    assert.match(filter, /\[3:a\]/);
    assert.match(filter, /amix=inputs=3:/);
  });
});

// Regression: -shortest silently cut a narration that outran the recording —
// the video just stopped mid-sentence with no warning. Now the last frame is
// held to cover it, and the fast copy path is kept when it isn't needed.
describe('audio overrun', () => {
  test('audioEndSec is the end of the last clip, not the last offset', () => {
    assert.equal(audioEndSec([
      { offsetSec: 0, durationSec: 2 },
      { offsetSec: 5, durationSec: 3 },
    ]), 8);
    assert.equal(audioEndSec([]), 0);
  });

  test('no padding requested keeps the graph audio-only, so video can be copied', () => {
    const f = buildFilterComplex([{ offsetSec: 1, durationSec: 2 }]);
    assert.ok(!f.includes('tpad'), 'no video filter when nothing overruns');
    assert.ok(!f.includes('[vout]'));
  });

  test('padding holds the last video frame in the same graph', () => {
    const f = buildFilterComplex([{ offsetSec: 1, durationSec: 2 }], 1.5);
    assert.match(f, /\[0:v\]tpad=stop_mode=clone:stop_duration=1\.500\[vout\]/);
    assert.match(f, /\[aout\]/, 'audio mix is still produced');
  });
});
