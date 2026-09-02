const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildConcatLines } = require('../src/assemble-video.js');

describe('buildConcatLines', () => {
  test('computes each frame duration from the gap to the next frame', () => {
    const frames = [
      { file: 'a.jpg', tSec: 0 },
      { file: 'b.jpg', tSec: 0.5 },
      { file: 'c.jpg', tSec: 1.8 },
    ];
    assert.deepEqual(buildConcatLines(frames), [
      "file 'a.jpg'", 'duration 0.500',
      "file 'b.jpg'", 'duration 1.300',
      "file 'c.jpg'", 'duration 0.300', // last real frame: fallback hold
      "file 'c.jpg'",                   // ffmpeg concat quirk: repeat last file
    ]);
  });

  test('a single frame still produces a valid (if short) concat list', () => {
    const frames = [{ file: 'only.jpg', tSec: 0 }];
    assert.deepEqual(buildConcatLines(frames), [
      "file 'only.jpg'", 'duration 0.300',
      "file 'only.jpg'",
    ]);
  });

  test('throws on an empty frame list rather than emitting an unplayable video', () => {
    assert.throws(() => buildConcatLines([]), /No frames captured/);
  });
});
