const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startFrameCapture } = require('../src/click-flow.js');

// The assembled video's timeline starts at the first captured frame, so the
// capture's own origin is the ONLY clock narration offsets may be measured
// against. These tests pin that contract.
//
// The bug they guard: narration offsets used to come from a START_MS stamped
// by record.sh before node even booted, while frames were stamped from
// inside startFrameCapture — which runs after node startup, `require
// ('playwright')` and the CDP connect (measured at 0.4–0.5s+ on this
// machine). Every narration clip landed that much late, for the whole video.
function fakePage() {
  return { screenshot: async () => {}, bringToFront: async () => {} };
}

describe('startFrameCapture', () => {
  test('exposes t0, stamped when capture starts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-test-'));
    const before = Date.now();
    const capture = startFrameCapture(fakePage(), dir, 10);
    const after = Date.now();

    assert.ok(typeof capture.t0 === 'number', 't0 must be exposed for narration to share');
    assert.ok(capture.t0 >= before && capture.t0 <= after, 't0 is the capture-start instant');
    await capture.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('frame timestamps are measured from t0, so the first frame is ~zero', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-test-'));
    const capture = startFrameCapture(fakePage(), dir, 10);
    await new Promise((r) => setTimeout(r, 150));
    const frames = await capture.stop();

    assert.ok(frames.length > 1, `expected several frames, got ${frames.length}`);
    assert.ok(frames[0].tSec < 0.1, `first frame should sit at ~0s from t0, got ${frames[0].tSec}`);
    for (let i = 1; i < frames.length; i++) {
      assert.ok(frames[i].tSec >= frames[i - 1].tSec, 'frame times must be non-decreasing');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
