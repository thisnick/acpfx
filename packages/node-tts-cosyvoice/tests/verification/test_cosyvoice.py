"""
Tier 2 Verification Tests for CosyVoice3 TTS Node (@acpfx/tts-cosyvoice)

Black-box tests that exercise the node through its NDJSON stdin/stdout contract.
The node is spawned as a subprocess -- no implementation source code is imported.

Prerequisites:
  1. Download the CosyVoice3 model:
       python3 -c "from huggingface_hub import snapshot_download; snapshot_download('FunAudioLLM/Fun-CosyVoice3-0.5B-2512')"
  2. Ensure `uv` is installed (the bin wrapper requires it).

Run:
  cd <repo-root>
  python3 packages/node-tts-cosyvoice/tests/verification/test_cosyvoice.py

Expected results:
  All tests should pass. The streaming verification test proves that audio
  chunks arrive BEFORE agent.complete is sent, confirming true incremental
  streaming. Audio files are saved to /tmp/cosyvoice_test_*.wav for manual
  inspection.
"""

import base64
import json
import os
import queue
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import wave

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

REPO_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "..")
)
NODE_BIN = os.path.join(
    REPO_ROOT, "packages", "node-tts-cosyvoice", "bin", "tts-cosyvoice"
)

SAMPLE_RATE = 16000
CHANNELS = 1
SAMPLE_WIDTH = 2  # 16-bit PCM

# Timeouts (seconds)
READY_TIMEOUT = 120  # Model loading can be slow
AUDIO_TIMEOUT = 60   # First audio chunk during synthesis
DONE_TIMEOUT = 30    # lifecycle.done after stdin close
INTERRUPT_DRAIN_TIMEOUT = 5  # Silence window after interrupt


# ---------------------------------------------------------------------------
# Test Harness
# ---------------------------------------------------------------------------

class CosyVoiceTestHarness:
    """Spawn the CosyVoice TTS node and communicate via NDJSON."""

    def __init__(self):
        self.proc = None
        self.events = queue.Queue()
        self._reader_thread = None
        self._stderr_lines = []
        self._stderr_thread = None

    def start(self, settings=None):
        env = os.environ.copy()
        env["ACPFX_NODE_NAME"] = "tts-test"
        if settings:
            env["ACPFX_SETTINGS"] = json.dumps(settings)

        self.proc = subprocess.Popen(
            [NODE_BIN],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            text=True,
            cwd=REPO_ROOT,
        )

        # Stdout reader thread
        def stdout_reader():
            for line in self.proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    self.events.put(json.loads(line))
                except json.JSONDecodeError:
                    pass

        self._reader_thread = threading.Thread(target=stdout_reader, daemon=True)
        self._reader_thread.start()

        # Stderr reader thread (for diagnostics on failure)
        def stderr_reader():
            for line in self.proc.stderr:
                self._stderr_lines.append(line.rstrip("\n"))

        self._stderr_thread = threading.Thread(target=stderr_reader, daemon=True)
        self._stderr_thread.start()

    def send(self, event):
        """Write an NDJSON event to the node's stdin."""
        self.proc.stdin.write(json.dumps(event) + "\n")
        self.proc.stdin.flush()

    def wait_for(self, event_type, timeout=30):
        """Wait for a specific event type, returning the event dict."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                event = self.events.get(timeout=0.1)
                if event.get("type") == event_type:
                    return event
            except queue.Empty:
                continue
        raise TimeoutError(
            f"Timed out after {timeout}s waiting for '{event_type}'\n"
            f"stderr tail:\n" + "\n".join(self._stderr_lines[-20:])
        )

    def collect_events(self, timeout=5):
        """Drain the event queue for `timeout` seconds, returning all events."""
        collected = []
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                collected.append(self.events.get(timeout=0.1))
            except queue.Empty:
                continue
        return collected

    def collect_until(self, event_type, timeout=30):
        """Collect all events until `event_type` is seen or timeout."""
        collected = []
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                event = self.events.get(timeout=0.1)
                collected.append(event)
                if event.get("type") == event_type:
                    return collected
            except queue.Empty:
                continue
        return collected

    def stop(self):
        """Close stdin and wait for the process to exit."""
        if self.proc and self.proc.stdin and not self.proc.stdin.closed:
            try:
                self.proc.stdin.close()
            except BrokenPipeError:
                pass
        if self.proc:
            try:
                self.proc.wait(timeout=DONE_TIMEOUT)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)

    def kill(self):
        """Force-kill the process."""
        if self.proc:
            self.proc.kill()
            try:
                self.proc.wait(timeout=5)
            except Exception:
                pass

    @property
    def stderr_output(self):
        return "\n".join(self._stderr_lines)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def decode_audio_chunks(events):
    """Extract and decode base64 PCM audio from audio.chunk events.

    Returns raw PCM bytes (int16 LE).
    """
    pcm_data = bytearray()
    for ev in events:
        if ev.get("type") != "audio.chunk":
            continue
        data = ev.get("data")
        if data:
            pcm_data.extend(base64.b64decode(data))
    return bytes(pcm_data)


def save_wav(pcm_bytes, path, sample_rate=SAMPLE_RATE, channels=CHANNELS):
    """Write raw PCM int16 LE bytes to a WAV file."""
    with wave.open(path, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(SAMPLE_WIDTH)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_bytes)


def pcm_duration_seconds(pcm_bytes):
    """Compute duration in seconds from raw PCM int16 LE bytes."""
    num_samples = len(pcm_bytes) // SAMPLE_WIDTH
    return num_samples / SAMPLE_RATE


def make_delta(text, seq=None):
    """Create an agent.delta event."""
    ev = {"type": "agent.delta", "delta": text}
    if seq is not None:
        ev["seq"] = seq
    return ev


def make_complete(text="", seq=None):
    """Create an agent.complete event."""
    ev = {"type": "agent.complete", "text": text}
    if seq is not None:
        ev["seq"] = seq
    return ev


def make_interrupt():
    """Create a control.interrupt event."""
    return {"type": "control.interrupt"}


def make_tool_start():
    """Create an agent.tool_start event."""
    return {"type": "agent.tool_start", "name": "test_tool"}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestContractCompliance(unittest.TestCase):
    """Test 1: Manifest flag, lifecycle.ready, lifecycle.done."""

    def test_manifest_flag(self):
        """--acpfx-manifest outputs valid JSON with correct consumes/emits and exits."""
        result = subprocess.run(
            [NODE_BIN, "--acpfx-manifest"],
            capture_output=True,
            text=True,
            timeout=30,
            cwd=REPO_ROOT,
        )
        self.assertEqual(result.returncode, 0, f"Exit code should be 0, stderr: {result.stderr}")

        manifest = json.loads(result.stdout.strip())

        # Must have name
        self.assertIn("name", manifest)

        # Must consume the standard TTS inputs
        consumes = manifest.get("consumes", [])
        for required in ["agent.delta", "agent.complete", "agent.tool_start", "control.interrupt"]:
            self.assertIn(required, consumes, f"Must consume {required}")

        # Must emit audio and lifecycle events
        emits = manifest.get("emits", [])
        for required in ["audio.chunk", "lifecycle.ready", "lifecycle.done"]:
            self.assertIn(required, emits, f"Must emit {required}")

    def test_lifecycle_ready(self):
        """Node emits lifecycle.ready within timeout after startup."""
        harness = CosyVoiceTestHarness()
        try:
            harness.start()
            event = harness.wait_for("lifecycle.ready", timeout=READY_TIMEOUT)
            self.assertEqual(event["type"], "lifecycle.ready")
        finally:
            harness.kill()

    def test_lifecycle_done_on_eof(self):
        """Node emits lifecycle.done when stdin is closed."""
        harness = CosyVoiceTestHarness()
        try:
            harness.start()
            harness.wait_for("lifecycle.ready", timeout=READY_TIMEOUT)
            harness.proc.stdin.close()
            event = harness.wait_for("lifecycle.done", timeout=DONE_TIMEOUT)
            self.assertEqual(event["type"], "lifecycle.done")
        finally:
            harness.kill()


class TestStreamingVerification(unittest.TestCase):
    """Test 2: Prove the node streams audio incrementally, not buffering until complete."""

    def test_audio_arrives_before_complete(self):
        """Send word-by-word deltas with delays. First audio.chunk must arrive
        BEFORE agent.complete is sent. This is the CRITICAL streaming test."""
        harness = CosyVoiceTestHarness()
        try:
            harness.start()
            harness.wait_for("lifecycle.ready", timeout=READY_TIMEOUT)

            # Long paragraph sent word-by-word with 50ms gaps
            text = (
                "The quick brown fox jumps over the lazy dog. "
                "She sells sea shells by the sea shore. "
                "How much wood would a woodchuck chuck if a woodchuck could chuck wood."
            )
            words = text.split()

            for i, word in enumerate(words):
                # Add leading space for all words after the first
                delta_text = word if i == 0 else " " + word
                harness.send(make_delta(delta_text))
                time.sleep(0.05)  # 50ms between words

            # Wait for at least one audio.chunk BEFORE sending agent.complete
            first_audio = harness.wait_for("audio.chunk", timeout=AUDIO_TIMEOUT)
            first_audio_time = time.time()
            self.assertEqual(first_audio["type"], "audio.chunk",
                             "Must receive audio.chunk BEFORE agent.complete is sent")
            self.assertIn("data", first_audio, "audio.chunk must have data field")

            # Verify audio metadata
            self.assertEqual(first_audio.get("sampleRate", 16000), SAMPLE_RATE)
            self.assertEqual(first_audio.get("channels", 1), CHANNELS)

            # NOW send agent.complete
            harness.send(make_complete(text))

            # Collect remaining audio
            remaining = harness.collect_events(timeout=AUDIO_TIMEOUT)
            all_audio = [first_audio] + [e for e in remaining if e.get("type") == "audio.chunk"]

            self.assertGreater(len(all_audio), 1,
                               "Should produce multiple audio chunks for a long paragraph")

            # Decode and verify audio
            pcm = decode_audio_chunks(all_audio)
            duration = pcm_duration_seconds(pcm)
            self.assertGreater(duration, 0.5,
                               f"Total audio should be >0.5s, got {duration:.2f}s")

            # Save for manual inspection
            wav_path = "/tmp/cosyvoice_test_streaming.wav"
            save_wav(pcm, wav_path)
            print(f"\n  [Streaming test] Audio saved to {wav_path} "
                  f"({duration:.2f}s, {len(all_audio)} chunks)")

        finally:
            harness.stop()


class TestSpeechCorrectness(unittest.TestCase):
    """Test 3: Synthesize known text and verify audio format/duration."""

    def test_audio_format_and_duration(self):
        """Synthesize 'Hello world, how are you today?' and verify output."""
        harness = CosyVoiceTestHarness()
        try:
            harness.start()
            harness.wait_for("lifecycle.ready", timeout=READY_TIMEOUT)

            test_text = "Hello world, how are you today?"
            words = test_text.split()
            for i, word in enumerate(words):
                delta_text = word if i == 0 else " " + word
                harness.send(make_delta(delta_text))
                time.sleep(0.05)

            harness.send(make_complete(test_text))

            # Collect all audio chunks until synthesis is done
            events = harness.collect_events(timeout=AUDIO_TIMEOUT)
            audio_events = [e for e in events if e.get("type") == "audio.chunk"]

            self.assertGreater(len(audio_events), 0,
                               "Must produce at least one audio.chunk")

            # Check audio metadata on all chunks
            for chunk in audio_events:
                sr = chunk.get("sampleRate", SAMPLE_RATE)
                ch = chunk.get("channels", CHANNELS)
                fmt = chunk.get("format", "pcm_s16le")
                self.assertEqual(sr, SAMPLE_RATE,
                                 f"sampleRate must be {SAMPLE_RATE}, got {sr}")
                self.assertEqual(ch, CHANNELS,
                                 f"channels must be {CHANNELS}, got {ch}")
                self.assertEqual(fmt, "pcm_s16le",
                                 f"format must be pcm_s16le, got {fmt}")

            # Decode and check duration
            pcm = decode_audio_chunks(audio_events)
            duration = pcm_duration_seconds(pcm)

            # "Hello world, how are you today?" should be ~1-5 seconds
            self.assertGreater(duration, 0.3,
                               f"Audio too short: {duration:.2f}s for '{test_text}'")
            self.assertLess(duration, 30.0,
                            f"Audio too long: {duration:.2f}s for '{test_text}'")

            # Verify PCM is not silence (at least some non-zero samples)
            samples = struct.unpack(f"<{len(pcm) // 2}h", pcm)
            max_amplitude = max(abs(s) for s in samples)
            self.assertGreater(max_amplitude, 100,
                               f"Audio appears silent (max amplitude={max_amplitude})")

            # Save for manual inspection
            wav_path = "/tmp/cosyvoice_test_speech.wav"
            save_wav(pcm, wav_path)
            print(f"\n  [Speech test] Audio saved to {wav_path} "
                  f"({duration:.2f}s, {len(audio_events)} chunks, "
                  f"max_amplitude={max_amplitude})")

        finally:
            harness.stop()


class TestInterruptHandling(unittest.TestCase):
    """Test 4: Interrupt stops audio emission and synthesis resumes after."""

    def test_interrupt_stops_audio(self):
        """Send deltas, wait for audio, then interrupt. No NEW audio after settling."""
        harness = CosyVoiceTestHarness()
        try:
            harness.start()
            harness.wait_for("lifecycle.ready", timeout=READY_TIMEOUT)

            # Start generating a long sentence
            text = (
                "This is a longer sentence that should produce many audio chunks "
                "and give us enough time to interrupt the synthesis before it finishes "
                "generating all of the audio output for this particular utterance."
            )
            for i, word in enumerate(text.split()):
                delta_text = word if i == 0 else " " + word
                harness.send(make_delta(delta_text))
                time.sleep(0.03)

            # Wait for first audio chunk to confirm synthesis started
            first_audio = harness.wait_for("audio.chunk", timeout=AUDIO_TIMEOUT)
            self.assertIsNotNone(first_audio, "Synthesis must start producing audio")

            # Send interrupt and record the timestamp
            interrupt_time = time.time()
            harness.send(make_interrupt())

            # Grace period: allow chunks already in the stdout pipe buffer to drain.
            # These were emitted BEFORE the node processed the interrupt.
            pipe_drain = harness.collect_events(timeout=2)
            pipe_audio = [e for e in pipe_drain if e.get("type") == "audio.chunk"]
            pipe_drain_end = time.time()

            # Now collect for 3 more seconds -- no NEW audio should arrive
            post_settle = harness.collect_events(timeout=3)
            post_audio = [e for e in post_settle if e.get("type") == "audio.chunk"]

            # After settling, zero new audio chunks
            self.assertEqual(
                len(post_audio), 0,
                f"Expected ZERO audio chunks after interrupt settled, got {len(post_audio)}. "
                f"({len(pipe_audio)} chunks in pipe-drain grace period, which is OK.)"
            )

            print(f"\n  [Interrupt test] interrupt sent at t=0, "
                  f"{len(pipe_audio)} chunks in pipe drain "
                  f"(0-{pipe_drain_end - interrupt_time:.1f}s), "
                  f"{len(post_audio)} chunks after settling (0 allowed)")

        finally:
            harness.stop()

    def test_synthesis_resumes_after_interrupt(self):
        """After interrupt, new deltas should produce audio again."""
        harness = CosyVoiceTestHarness()
        try:
            harness.start()
            harness.wait_for("lifecycle.ready", timeout=READY_TIMEOUT)

            # First utterance -- must be long enough to produce audio via streaming
            # before we interrupt. CosyVoice3 needs sufficient text tokens before
            # its LLM starts decoding speech tokens.
            first_text = (
                "This is a longer sentence that should produce many audio chunks "
                "and give us enough time to interrupt the synthesis before it finishes "
                "generating all of the audio output for this particular utterance."
            )
            for i, word in enumerate(first_text.split()):
                delta_text = word if i == 0 else " " + word
                harness.send(make_delta(delta_text))
                time.sleep(0.03)
            harness.wait_for("audio.chunk", timeout=AUDIO_TIMEOUT)

            # Interrupt
            harness.send(make_interrupt())

            # Grace period for pipe drain + let interrupt settle
            harness.collect_events(timeout=3)

            # Second utterance after interrupt -- long enough for streaming
            second_text = (
                "Good morning, how is everything going today? "
                "I hope you are having a wonderful day so far and "
                "that everything is proceeding according to your plans."
            )
            for i, word in enumerate(second_text.split()):
                delta_text = word if i == 0 else " " + word
                harness.send(make_delta(delta_text))
                time.sleep(0.03)
            harness.send(make_complete(second_text))

            # Must get audio from second utterance
            second_audio = harness.wait_for("audio.chunk", timeout=AUDIO_TIMEOUT)
            self.assertIsNotNone(second_audio,
                                 "Synthesis must resume after interrupt")

            remaining = harness.collect_events(timeout=AUDIO_TIMEOUT)
            all_second_audio = [second_audio] + [
                e for e in remaining if e.get("type") == "audio.chunk"
            ]
            pcm = decode_audio_chunks(all_second_audio)
            duration = pcm_duration_seconds(pcm)
            self.assertGreater(duration, 0.3,
                               f"Second utterance audio too short: {duration:.2f}s")

            print(f"\n  [Resume test] Second utterance: {duration:.2f}s, "
                  f"{len(all_second_audio)} chunks")

        finally:
            harness.stop()


class TestAgentCompleteWithFullText(unittest.TestCase):
    """Test 5: agent.complete with text field (no prior deltas)."""

    def test_complete_without_deltas(self):
        """Send agent.complete with text field directly. Must produce audio."""
        harness = CosyVoiceTestHarness()
        try:
            harness.start()
            harness.wait_for("lifecycle.ready", timeout=READY_TIMEOUT)

            test_text = "This is a complete sentence sent all at once."
            harness.send(make_complete(test_text))

            # Should produce audio
            events = harness.collect_events(timeout=AUDIO_TIMEOUT)
            audio_events = [e for e in events if e.get("type") == "audio.chunk"]

            self.assertGreater(len(audio_events), 0,
                               "agent.complete with text must produce audio")

            pcm = decode_audio_chunks(audio_events)
            duration = pcm_duration_seconds(pcm)
            self.assertGreater(duration, 0.3,
                               f"Audio too short: {duration:.2f}s")

            wav_path = "/tmp/cosyvoice_test_complete_only.wav"
            save_wav(pcm, wav_path)
            print(f"\n  [Complete-only test] {duration:.2f}s, "
                  f"{len(audio_events)} chunks, saved to {wav_path}")

        finally:
            harness.stop()


class TestEdgeCases(unittest.TestCase):
    """Test 6: Edge cases that must not crash the node."""

    def test_empty_delta(self):
        """Empty agent.delta should not crash the node."""
        harness = CosyVoiceTestHarness()
        try:
            harness.start()
            harness.wait_for("lifecycle.ready", timeout=READY_TIMEOUT)

            # Send empty delta
            harness.send(make_delta(""))
            time.sleep(0.5)

            # Send real content after -- node must still work
            harness.send(make_delta("Hello"))
            harness.send(make_complete("Hello"))

            events = harness.collect_events(timeout=AUDIO_TIMEOUT)
            audio_events = [e for e in events if e.get("type") == "audio.chunk"]
            self.assertGreater(len(audio_events), 0,
                               "Node must still produce audio after empty delta")

        finally:
            harness.stop()

    def test_very_short_text(self):
        """Very short text ('Hi') should produce audio."""
        harness = CosyVoiceTestHarness()
        try:
            harness.start()
            harness.wait_for("lifecycle.ready", timeout=READY_TIMEOUT)

            harness.send(make_delta("Hi"))
            harness.send(make_complete("Hi"))

            events = harness.collect_events(timeout=AUDIO_TIMEOUT)
            audio_events = [e for e in events if e.get("type") == "audio.chunk"]
            self.assertGreater(len(audio_events), 0,
                               "Very short text 'Hi' must produce audio")

            pcm = decode_audio_chunks(audio_events)
            duration = pcm_duration_seconds(pcm)
            self.assertGreater(duration, 0.1,
                               f"Audio for 'Hi' too short: {duration:.2f}s")

            print(f"\n  [Short text test] 'Hi' -> {duration:.2f}s, "
                  f"{len(audio_events)} chunks")

        finally:
            harness.stop()

    def test_tool_start_during_synthesis(self):
        """agent.tool_start during synthesis should stop audio, then resume on new deltas."""
        harness = CosyVoiceTestHarness()
        try:
            harness.start()
            harness.wait_for("lifecycle.ready", timeout=READY_TIMEOUT)

            # Start synthesis -- long enough text to produce audio via streaming
            text = (
                "Let me think about this for a moment while I process your request "
                "and figure out the best way to handle this particular situation "
                "that you have presented to me just now."
            )
            for i, word in enumerate(text.split()):
                delta_text = word if i == 0 else " " + word
                harness.send(make_delta(delta_text))
                time.sleep(0.03)

            # Wait for audio to start
            harness.wait_for("audio.chunk", timeout=AUDIO_TIMEOUT)

            # Send tool_start -- should stop synthesis
            harness.send(make_tool_start())

            # Grace period for pipe buffer drain
            pipe_drain = harness.collect_events(timeout=2)
            pipe_audio = [e for e in pipe_drain if e.get("type") == "audio.chunk"]

            # After settling, zero new audio chunks
            post_settle = harness.collect_events(timeout=3)
            post_audio = [e for e in post_settle if e.get("type") == "audio.chunk"]

            self.assertEqual(
                len(post_audio), 0,
                f"Expected ZERO audio chunks after tool_start settled, got {len(post_audio)}. "
                f"({len(pipe_audio)} chunks in pipe-drain grace period, which is OK.)"
            )

            print(f"\n  [Tool start test] {len(pipe_audio)} chunks in pipe drain, "
                  f"{len(post_audio)} chunks after settling (0 allowed)")

            # Now send tool_done + new deltas to verify synthesis resumes
            harness.send({"type": "agent.tool_done", "tool": "test_tool",
                          "result": "done"})
            time.sleep(0.1)

            text2 = (
                "Here is my response after the tool call completed successfully. "
                "I found the information you were looking for and I am happy to "
                "share it with you right now."
            )
            for i, word in enumerate(text2.split()):
                delta_text = word if i == 0 else " " + word
                harness.send(make_delta(delta_text))
                time.sleep(0.03)
            harness.send(make_complete())

            # Must produce audio for the new utterance
            harness.wait_for("audio.chunk", timeout=AUDIO_TIMEOUT)
            print("  [Tool start test] Synthesis resumed after tool_start -- OK")

        finally:
            harness.stop()

    def test_multiple_sequential_utterances(self):
        """Multiple sequential utterances (delta+complete cycles) all produce audio."""
        harness = CosyVoiceTestHarness()
        try:
            harness.start()
            harness.wait_for("lifecycle.ready", timeout=READY_TIMEOUT)

            utterances = [
                "First sentence here.",
                "Second sentence follows.",
                "Third and final sentence.",
            ]

            for u_idx, text in enumerate(utterances):
                words = text.split()
                for i, word in enumerate(words):
                    delta_text = word if i == 0 else " " + word
                    harness.send(make_delta(delta_text))
                    time.sleep(0.05)
                harness.send(make_complete(text))

                # Wait for audio from this utterance
                events = harness.collect_events(timeout=AUDIO_TIMEOUT)
                audio_events = [e for e in events if e.get("type") == "audio.chunk"]
                self.assertGreater(
                    len(audio_events), 0,
                    f"Utterance {u_idx + 1} ('{text}') must produce audio"
                )

                pcm = decode_audio_chunks(audio_events)
                duration = pcm_duration_seconds(pcm)
                print(f"\n  [Sequential test] Utterance {u_idx + 1}: "
                      f"{duration:.2f}s, {len(audio_events)} chunks")

        finally:
            harness.stop()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # Check the bin exists
    if not os.path.isfile(NODE_BIN):
        print(f"ERROR: Node binary not found at {NODE_BIN}", file=sys.stderr)
        print("Make sure you're running from the repo root.", file=sys.stderr)
        sys.exit(1)

    # Check it's executable
    if not os.access(NODE_BIN, os.X_OK):
        print(f"ERROR: {NODE_BIN} is not executable", file=sys.stderr)
        sys.exit(1)

    print("=" * 70)
    print("CosyVoice3 TTS Verification Tests")
    print("=" * 70)
    print(f"Node binary: {NODE_BIN}")
    print(f"Sample rate: {SAMPLE_RATE} Hz")
    print(f"Ready timeout: {READY_TIMEOUT}s (model loading may be slow)")
    print("=" * 70)

    unittest.main(verbosity=2)
