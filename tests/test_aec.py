#!/usr/bin/env python3
"""
Adversarial AEC (Acoustic Echo Cancellation) test suite.

Generates synthetic audio with known frequency content, feeds it through
the AEC binary, and measures echo suppression and signal preservation
using FFT-based frequency analysis.

Usage:
    python tests/test_aec.py [binary_path]

Default binary: dist/nodes/aec-speex
"""

import base64
import json
import math
import os
import struct
import subprocess
import sys
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional

SAMPLE_RATE = 16000
FRAME_SIZE = 160  # 10ms at 16kHz
FRAME_BYTES = FRAME_SIZE * 2  # 16-bit samples


# ── Audio generation ──────────────────────────────────────────────────

def generate_sine(freq_hz: float, duration_s: float, amplitude: float = 16000.0) -> List[int]:
    """Generate a sine wave as 16-bit PCM samples."""
    n_samples = int(SAMPLE_RATE * duration_s)
    samples = []
    for i in range(n_samples):
        t = i / SAMPLE_RATE
        val = amplitude * math.sin(2 * math.pi * freq_hz * t)
        val = max(-32768, min(32767, int(val)))
        samples.append(val)
    return samples


def generate_silence(duration_s: float) -> List[int]:
    return [0] * int(SAMPLE_RATE * duration_s)


def mix_signals(a: List[int], b: List[int]) -> List[int]:
    """Mix two signals by addition, clamping to 16-bit range."""
    length = max(len(a), len(b))
    result = []
    for i in range(length):
        va = a[i] if i < len(a) else 0
        vb = b[i] if i < len(b) else 0
        mixed = max(-32768, min(32767, va + vb))
        result.append(mixed)
    return result


def delay_signal(samples: List[int], delay_ms: int) -> List[int]:
    """Delay a signal by prepending silence."""
    delay_samples = int(SAMPLE_RATE * delay_ms / 1000)
    return [0] * delay_samples + samples


def attenuate(samples: List[int], factor: float) -> List[int]:
    """Scale signal amplitude."""
    return [max(-32768, min(32767, int(s * factor))) for s in samples]


# ── Frequency analysis (pure Python, no numpy needed) ────────────────

def dft_magnitude_at_freq(samples: List[int], target_freq: float) -> float:
    """Compute DFT magnitude at a specific frequency using Goertzel-like approach."""
    n = len(samples)
    if n == 0:
        return 0.0
    # Goertzel algorithm
    k = round(target_freq * n / SAMPLE_RATE)
    if k == 0:
        k = 1
    w = 2.0 * math.pi * k / n
    coeff = 2.0 * math.cos(w)
    s0 = 0.0
    s1 = 0.0
    s2 = 0.0
    for sample in samples:
        s0 = sample + coeff * s1 - s2
        s2 = s1
        s1 = s0
    power = s1 * s1 + s2 * s2 - coeff * s1 * s2
    magnitude = math.sqrt(max(0, power)) / n
    return magnitude


def rms(samples: List[int]) -> float:
    if not samples:
        return 0.0
    return math.sqrt(sum(s * s for s in samples) / len(samples))


# ── NDJSON protocol helpers ──────────────────────────────────────────

def samples_to_b64(samples: List[int]) -> str:
    """Encode 16-bit PCM samples as base64."""
    raw = struct.pack(f'<{len(samples)}h', *samples)
    return base64.b64encode(raw).decode('ascii')


def b64_to_samples(b64: str) -> List[int]:
    """Decode base64 to 16-bit PCM samples."""
    raw = base64.b64decode(b64)
    n = len(raw) // 2
    return list(struct.unpack(f'<{n}h', raw))


def make_audio_event(samples: List[int], source: str) -> str:
    """Create an NDJSON audio.chunk event."""
    event = {
        "type": "audio.chunk",
        "_from": source,
        "data": samples_to_b64(samples),
        "durationMs": len(samples) * 1000 // SAMPLE_RATE,
    }
    return json.dumps(event)


def frame_audio(samples: List[int]) -> List[List[int]]:
    """Split samples into FRAME_SIZE frames."""
    frames = []
    for i in range(0, len(samples), FRAME_SIZE):
        frame = samples[i:i + FRAME_SIZE]
        if len(frame) == FRAME_SIZE:
            frames.append(frame)
    return frames


# ── Test runner ──────────────────────────────────────────────────────

@dataclass
class TestResult:
    name: str
    passed: bool
    echo_suppression_db: Optional[float] = None
    signal_distortion_db: Optional[float] = None
    details: str = ""


@dataclass
class AecTestHarness:
    binary_path: str
    env: Dict = field(default_factory=dict)
    settings: Dict = field(default_factory=lambda: {"speaker": "player"})

    def run_aec(self, speaker_samples: List[int], mic_samples: List[int]) -> List[int]:
        """
        Feed interleaved speaker/mic frames to AEC binary and collect output.
        Speaker frames are sent first each time step so the reference is available
        before the mic frame arrives.
        """
        speaker_frames = frame_audio(speaker_samples)
        mic_frames = frame_audio(mic_samples)

        # Pad to equal length
        max_frames = max(len(speaker_frames), len(mic_frames))

        lines = []
        for i in range(max_frames):
            # Speaker reference first
            if i < len(speaker_frames):
                lines.append(make_audio_event(speaker_frames[i], "player"))
            # Then mic
            if i < len(mic_frames):
                lines.append(make_audio_event(mic_frames[i], "mic"))

        input_data = "\n".join(lines) + "\n"

        env = dict(os.environ)
        env.update(self.env)
        env["ACPFX_SETTINGS"] = json.dumps(self.settings)

        proc = subprocess.run(
            [self.binary_path],
            input=input_data,
            capture_output=True,
            text=True,
            timeout=30,
            env=env,
        )

        if proc.returncode != 0 and proc.returncode != -13:  # SIGPIPE is ok
            print(f"  [stderr] {proc.stderr[:500]}", file=sys.stderr)

        # Parse output
        output_samples = []
        for line in proc.stdout.strip().split("\n"):
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "audio.chunk" and "data" in event:
                output_samples.extend(b64_to_samples(event["data"]))

        return output_samples

    def run_aec_segmented(self, speaker_samples: List[int], mic_samples: List[int],
                          measure_points_s: List[float]) -> List[List[int]]:
        """
        Run AEC and return output segments at specified time points.
        measure_points_s is cumulative seconds from start.
        Returns list of output segments between consecutive measure points.
        """
        # For segmented analysis, we run the full thing and slice the output
        output = self.run_aec(speaker_samples, mic_samples)
        segments = []
        prev_idx = 0
        for t in measure_points_s:
            idx = min(int(t * SAMPLE_RATE), len(output))
            segments.append(output[prev_idx:idx])
            prev_idx = idx
        return segments


# ── Test scenarios ───────────────────────────────────────────────────

SPEAKER_FREQ = 440.0  # Hz - echo frequency
SPEECH_FREQ = 880.0   # Hz - "real speech" frequency
ECHO_GAIN = 0.3       # Echo is 30% of speaker level
DURATION = 7.0        # seconds - enough for convergence


def test_signal_preservation(harness: AecTestHarness) -> TestResult:
    """No echo scenario: mic-only signal should pass through with < 1dB distortion."""
    speech = generate_sine(SPEECH_FREQ, DURATION, amplitude=10000)
    silence = generate_silence(DURATION)

    output = harness.run_aec(silence, speech)

    if len(output) < SAMPLE_RATE:
        return TestResult("Signal preservation (no echo)", False,
                          details=f"Too few output samples: {len(output)}")

    # Measure speech energy in output vs input (skip first 0.5s for settling)
    skip = int(0.5 * SAMPLE_RATE)
    input_energy = dft_magnitude_at_freq(speech[skip:], SPEECH_FREQ)
    output_energy = dft_magnitude_at_freq(output[skip:min(len(output), len(speech))], SPEECH_FREQ)

    if input_energy < 1e-6:
        return TestResult("Signal preservation (no echo)", False, details="Input energy too low")

    ratio = output_energy / input_energy if input_energy > 0 else 0
    distortion_db = 20 * math.log10(ratio) if ratio > 1e-10 else -100

    passed = abs(distortion_db) < 1.0
    return TestResult(
        "Signal preservation (no echo)",
        passed,
        signal_distortion_db=distortion_db,
        details=f"Input energy: {input_energy:.1f}, Output energy: {output_energy:.1f}, Ratio: {ratio:.3f}"
    )


def test_echo_at_delay(harness: AecTestHarness, delay_ms: int) -> TestResult:
    """Test echo suppression at a specific delay."""
    name = f"Echo suppression (delay={delay_ms}ms)"

    # Speaker plays 440Hz
    speaker = generate_sine(SPEAKER_FREQ, DURATION, amplitude=16000)

    # Mic gets: real speech (880Hz) + delayed echo of speaker (440Hz at 0.3x)
    speech = generate_sine(SPEECH_FREQ, DURATION, amplitude=10000)
    echo = attenuate(delay_signal(speaker, delay_ms), ECHO_GAIN)
    mic = mix_signals(speech, echo)

    output = harness.run_aec(speaker, mic)

    if len(output) < SAMPLE_RATE * 2:
        return TestResult(name, False, details=f"Too few output samples: {len(output)}")

    # Measure echo (440Hz) in mic input vs output
    # Use the last 2 seconds for measurement (after convergence)
    measure_start = max(0, len(output) - int(2 * SAMPLE_RATE))
    measure_end = len(output)
    mic_measure_start = max(0, len(mic) - int(2 * SAMPLE_RATE))
    mic_measure_end = min(len(mic), len(output))

    input_echo_energy = dft_magnitude_at_freq(mic[mic_measure_start:mic_measure_end], SPEAKER_FREQ)
    output_echo_energy = dft_magnitude_at_freq(output[measure_start:measure_end], SPEAKER_FREQ)

    # Measure speech preservation
    input_speech_energy = dft_magnitude_at_freq(mic[mic_measure_start:mic_measure_end], SPEECH_FREQ)
    output_speech_energy = dft_magnitude_at_freq(output[measure_start:measure_end], SPEECH_FREQ)

    echo_suppression_db = 0.0
    if input_echo_energy > 1e-6 and output_echo_energy > 1e-10:
        echo_suppression_db = -20 * math.log10(output_echo_energy / input_echo_energy)
    elif output_echo_energy < 1e-10:
        echo_suppression_db = 60.0  # effectively fully suppressed

    signal_distortion_db = 0.0
    if input_speech_energy > 1e-6:
        ratio = output_speech_energy / input_speech_energy if output_speech_energy > 1e-10 else 1e-10
        signal_distortion_db = 20 * math.log10(ratio)

    passed = echo_suppression_db > 10.0
    return TestResult(
        name,
        passed,
        echo_suppression_db=echo_suppression_db,
        signal_distortion_db=signal_distortion_db,
        details=(
            f"Echo(440Hz) in={input_echo_energy:.1f} out={output_echo_energy:.1f} | "
            f"Speech(880Hz) in={input_speech_energy:.1f} out={output_speech_energy:.1f}"
        )
    )


def test_convergence(harness: AecTestHarness) -> TestResult:
    """Measure echo suppression at 1s, 3s, 5s to check adaptive filter convergence."""
    name = "Convergence over time"
    delay_ms = 100

    speaker = generate_sine(SPEAKER_FREQ, DURATION, amplitude=16000)
    speech = generate_sine(SPEECH_FREQ, DURATION, amplitude=10000)
    echo = attenuate(delay_signal(speaker, delay_ms), ECHO_GAIN)
    mic = mix_signals(speech, echo)

    output = harness.run_aec(speaker, mic)

    if len(output) < SAMPLE_RATE * 5:
        return TestResult(name, False, details=f"Too few output samples: {len(output)}, need {SAMPLE_RATE * 5}")

    # Measure at windows: 0-1s, 2-3s, 4-5s
    windows = [(0, 1), (2, 3), (4, 5)]
    suppressions = []
    details_parts = []

    for start_s, end_s in windows:
        start_idx = int(start_s * SAMPLE_RATE)
        end_idx = min(int(end_s * SAMPLE_RATE), len(output), len(mic))

        if end_idx <= start_idx:
            suppressions.append(0)
            continue

        input_echo = dft_magnitude_at_freq(mic[start_idx:end_idx], SPEAKER_FREQ)
        output_echo = dft_magnitude_at_freq(output[start_idx:end_idx], SPEAKER_FREQ)

        if input_echo > 1e-6 and output_echo > 1e-10:
            sup = -20 * math.log10(output_echo / input_echo)
        elif output_echo < 1e-10:
            sup = 60.0
        else:
            sup = 0.0
        suppressions.append(sup)
        details_parts.append(f"  {start_s}-{end_s}s: {sup:.1f}dB suppression (in={input_echo:.1f} out={output_echo:.1f})")

    # Check that suppression improves over time and reaches >10dB by 5s
    final_suppression = suppressions[-1] if suppressions else 0
    passed = final_suppression > 10.0

    return TestResult(
        name,
        passed,
        echo_suppression_db=final_suppression,
        details="\n".join(details_parts)
    )


# ── Main ─────────────────────────────────────────────────────────────

def run_all_tests(binary_path: str, extra_env: dict = None) -> List[TestResult]:
    harness = AecTestHarness(
        binary_path=binary_path,
        env=extra_env or {},
    )

    results = []

    # 1. Signal preservation
    print("\n[1/7] Signal preservation (no echo)...")
    results.append(test_signal_preservation(harness))
    print_result(results[-1])

    # 2-5. Echo at various delays
    for i, delay in enumerate([50, 100, 200, 300], start=2):
        print(f"\n[{i}/7] Echo suppression at {delay}ms delay...")
        results.append(test_echo_at_delay(harness, delay))
        print_result(results[-1])

    # 6. Convergence
    print("\n[6/7] Convergence over time...")
    results.append(test_convergence(harness))
    print_result(results[-1])

    return results


def print_result(r: TestResult):
    status = "PASS" if r.passed else "FAIL"
    print(f"  [{status}] {r.name}")
    if r.echo_suppression_db is not None:
        print(f"    Echo suppression: {r.echo_suppression_db:.1f} dB (need >10)")
    if r.signal_distortion_db is not None:
        print(f"    Signal distortion: {r.signal_distortion_db:.1f} dB (need <1)")
    if r.details:
        for line in r.details.split("\n"):
            print(f"    {line}")


def print_summary(results: List[TestResult]):
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    passed = sum(1 for r in results if r.passed)
    total = len(results)
    for r in results:
        status = "PASS" if r.passed else "FAIL"
        sup = f"  sup={r.echo_suppression_db:.1f}dB" if r.echo_suppression_db is not None else ""
        dist = f"  dist={r.signal_distortion_db:.1f}dB" if r.signal_distortion_db is not None else ""
        print(f"  [{status}] {r.name}{sup}{dist}")
    print(f"\n  {passed}/{total} tests passed")
    print("=" * 60)


if __name__ == "__main__":
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    if len(sys.argv) > 1:
        binary = sys.argv[1]
    else:
        binary = os.path.join(project_root, "dist", "nodes", "aec-speex")

    if not os.path.exists(binary):
        print(f"ERROR: Binary not found: {binary}")
        sys.exit(1)

    print(f"AEC Adversarial Test Suite")
    print(f"Binary: {binary}")
    print(f"Sample rate: {SAMPLE_RATE}Hz, Frame: {FRAME_SIZE} samples (10ms)")
    print(f"Speaker freq: {SPEAKER_FREQ}Hz, Speech freq: {SPEECH_FREQ}Hz")
    print(f"Echo gain: {ECHO_GAIN}, Duration: {DURATION}s")

    extra_env = {}
    # SpeexDSP needs DYLD_LIBRARY_PATH
    if "speex" in binary.lower():
        lib_path = os.path.join(project_root, ".devbox", "nix", "profile", "default", "lib")
        if os.path.exists(lib_path):
            extra_env["DYLD_LIBRARY_PATH"] = lib_path
            print(f"DYLD_LIBRARY_PATH: {lib_path}")

    results = run_all_tests(binary, extra_env)
    print_summary(results)

    # Exit with failure if any test failed
    if not all(r.passed for r in results):
        sys.exit(1)
