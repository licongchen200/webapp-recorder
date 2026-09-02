const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { formatTimestamp, buildCues, toSrt, toVtt } = require('../src/subtitles.js');

describe('formatTimestamp', () => {
  // SRT uses a comma before milliseconds, WebVTT a period. Getting this
  // wrong produces a file players silently ignore rather than reject.
  test('SRT form uses a comma, VTT form a period', () => {
    assert.equal(formatTimestamp(3.3), '00:00:03,300');
    assert.equal(formatTimestamp(3.3, '.'), '00:00:03.300');
  });

  test('pads every field and carries into hours', () => {
    assert.equal(formatTimestamp(0), '00:00:00,000');
    assert.equal(formatTimestamp(61.5), '00:01:01,500');
    assert.equal(formatTimestamp(3661.25), '01:01:01,250');
  });

  test('rounding carries into seconds instead of printing 1000ms', () => {
    assert.equal(formatTimestamp(1.9996), '00:00:02,000');
  });

  test('a negative offset clamps to zero rather than wrapping', () => {
    assert.equal(formatTimestamp(-1), '00:00:00,000');
  });
});

describe('buildCues', () => {
  const events = [
    { offsetSec: 1.0, durationSec: 2.0, text: 'First  line.' },
    { offsetSec: 5.0, durationSec: 1.5, text: 'Second line.' },
    { offsetSec: 8.0, durationSec: 1.0 },                    // no text
    { offsetSec: 9.0, durationSec: 1.0, text: '   ' },        // blank
  ];

  test('uses the event offsets directly — they are already absolute', () => {
    const cues = buildCues(events);
    assert.deepEqual(cues[0], { start: 1.0, end: 3.0, text: 'First line.' });
    assert.deepEqual(cues[1], { start: 5.0, end: 6.5, text: 'Second line.' });
  });

  test('events without usable text produce no cue', () => {
    assert.equal(buildCues(events).length, 2);
    assert.equal(buildCues([]).length, 0);
  });

  test('cues come out in time order even if events are not', () => {
    const cues = buildCues([
      { offsetSec: 9, durationSec: 1, text: 'later' },
      { offsetSec: 2, durationSec: 1, text: 'earlier' },
    ]);
    assert.deepEqual(cues.map((c) => c.text), ['earlier', 'later']);
  });
});

describe('serialisation', () => {
  const cues = [{ start: 0, end: 2, text: 'One.' }, { start: 3, end: 4, text: 'Two.' }];

  test('SRT numbers cues from 1, consecutively', () => {
    const srt = toSrt(cues);
    assert.ok(srt.startsWith('1\n00:00:00,000 --> 00:00:02,000\nOne.'), srt);
    assert.match(srt, /\n2\n00:00:03,000 --> 00:00:04,000\nTwo\./);
  });

  test('VTT carries its required header and period separators', () => {
    const vtt = toVtt(cues);
    assert.ok(vtt.startsWith('WEBVTT\n'), 'a VTT without its header is invalid');
    assert.match(vtt, /00:00:00\.000 --> 00:00:02\.000/);
    assert.ok(!vtt.includes(',000'), 'VTT must not use comma separators');
  });
});
