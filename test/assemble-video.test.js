const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildConcatLines, parseResolution } = require('../src/assemble-video.js');

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

describe('parseResolution', () => {
  test('converts "WxH" to ffmpeg scale filter syntax "W:H"', () => {
    assert.equal(parseResolution('1920x1080'), '1920:1080');
  });

  test('preserves -1/-2 auto-scale-preserving-aspect-ratio dimensions', () => {
    assert.equal(parseResolution('1280x-2'), '1280:-2');
    assert.equal(parseResolution('-1x720'), '-1:720');
  });

  test('rejects a malformed resolution string with a clear error', () => {
    assert.throws(() => parseResolution('1920,1080'), /Invalid "resolution"/);
    assert.throws(() => parseResolution('1920'), /Invalid "resolution"/);
    assert.throws(() => parseResolution('big'), /Invalid "resolution"/);
  });
});
