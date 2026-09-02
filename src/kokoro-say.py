#!/usr/bin/env python3
"""Minimal CLI wrapper around kokoro-onnx — the library has no built-in CLI
(unlike piper), so this mirrors piper's `say -o file text` shape: model,
voices, and voice/speed come from argv, the text to speak comes from stdin,
and a WAV is written to the given output path.

Usage: kokoro-say.py <model.onnx> <voices.bin> <voice> <speed> <out.wav>
"""
import sys

from kokoro_onnx import Kokoro
import soundfile as sf

model_path, voices_path, voice, speed, out_path = sys.argv[1:6]
text = sys.stdin.read()

kokoro = Kokoro(model_path, voices_path)
samples, sample_rate = kokoro.create(text, voice=voice, speed=float(speed), lang="en-us")
sf.write(out_path, samples, sample_rate)
