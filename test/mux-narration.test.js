const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildFilterComplex } = require('../src/mux-narration.js');

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
