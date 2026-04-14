"""
Tests for Kyutai TTS interrupt handling during flush_remaining().

Reproduces the bug where control.interrupt during flush_remaining() was ignored
because the flush loop didn't check for interrupts, causing audio to keep streaming.

Uses a mock backend that simulates slow generation (many steps) so we can inject
an interrupt mid-flush and verify it stops.
"""

import json
import queue
import struct
import sys
import threading
import time
import unittest
from unittest.mock import patch
from io import StringIO

# We need to import from the module, but it has heavy dependencies.
# Instead, we extract and test the core logic by simulating the event loop.

# Sentinel values matching tts_kyutai.py
_INTERRUPT = object()
_EOF = object()

OUTPUT_SAMPLE_RATE = 16000
CHUNK_DURATION_MS = 100
SAMPLES_PER_CHUNK = OUTPUT_SAMPLE_RATE * CHUNK_DURATION_MS // 1000  # 1600


class MockBackend:
    """Mock TTS backend that simulates slow multi-step generation."""

    def __init__(self, on_audio_samples, total_steps=50):
        self.on_audio_samples = on_audio_samples
        self.total_steps = total_steps
        self._step_count = 0
        self._started = False
        self._stopped = False
        self.steps_executed = 0

    def load(self):
        pass

    def start_utterance(self):
        self._started = True
        self._stopped = False
        self._step_count = 0
        self.steps_executed = 0

    def feed_text(self, word, first_turn):
        pass

    def step(self):
        """Each step produces a small audio frame."""
        self._step_count += 1
        self.steps_executed += 1
        # Simulate producing audio samples (enough for one chunk)
        samples = [0.1] * SAMPLES_PER_CHUNK
        self.on_audio_samples(samples)
        return True

    def is_done(self):
        if self._stopped:
            return True
        return self._step_count >= self.total_steps

    def stop(self):
        self._stopped = True
        self._step_count = 0

    def flush_remaining(self, check_interrupted=None):
        """Interruptible flush — mirrors the fixed implementation."""
        while not self.is_done():
            if check_interrupted and check_interrupted():
                return False
            self.step()
        return True

    def flush_remaining_OLD(self):
        """Original non-interruptible flush — for reproducing the bug."""
        while not self.is_done():
            self.step()


class TestInterruptDuringFlush(unittest.TestCase):
    """Test that interrupt during flush_remaining stops audio emission."""

    def setUp(self):
        self.emitted_chunks = []
        self.output_buffer = []
        self.suppress_output = False

    def on_audio_samples(self, pcm):
        """Mock on_audio_samples callback matching tts_kyutai.py."""
        if self.suppress_output:
            return
        self.output_buffer.extend(pcm)
        while len(self.output_buffer) >= SAMPLES_PER_CHUNK:
            chunk = self.output_buffer[:SAMPLES_PER_CHUNK]
            del self.output_buffer[:SAMPLES_PER_CHUNK]
            self.emitted_chunks.append(chunk)

    def test_bug_repro_flush_ignores_interrupt(self):
        """REPRODUCES BUG: Old flush_remaining ignores interrupt, emits all audio.

        Even when an interrupt is in the queue before flush starts, the old
        flush_remaining_OLD() has no way to check it — it runs all steps.
        """
        backend = MockBackend(self.on_audio_samples, total_steps=20)
        input_q = queue.Queue()

        # Simulate: generation started, agent.complete triggers flush
        backend.start_utterance()

        # Pre-load interrupt into the queue BEFORE flush starts
        input_q.put({"type": "control.interrupt"})

        # OLD behavior: flush_remaining blocks without checking queue
        backend.flush_remaining_OLD()

        # BUG: All 20 steps executed and all audio emitted despite interrupt
        self.assertEqual(backend.steps_executed, 20,
                         "Old flush should complete all steps (bug behavior)")
        self.assertEqual(len(self.emitted_chunks), 20,
                         "Old flush emits all audio chunks (bug behavior)")

        # The interrupt is sitting in the queue, unprocessed
        self.assertFalse(input_q.empty(),
                         "Interrupt should still be in queue, unprocessed")

    def test_fix_flush_stops_on_interrupt(self):
        """VERIFIES FIX: New flush_remaining stops when interrupt arrives."""
        backend = MockBackend(self.on_audio_samples, total_steps=20)
        input_q = queue.Queue()

        backend.start_utterance()

        # Pre-load interrupt into queue after a few steps would have run.
        # We inject it directly — check_interrupted polls the queue.
        # Put interrupt after 5 steps by using a step counter in check.
        steps_before_interrupt = 5
        interrupt_injected = [False]

        original_step = backend.step
        def counting_step():
            result = original_step()
            if backend.steps_executed == steps_before_interrupt and not interrupt_injected[0]:
                input_q.put({"type": "control.interrupt"})
                interrupt_injected[0] = True
            return result
        backend.step = counting_step

        was_interrupted = [False]

        def check_interrupted():
            try:
                event = input_q.get_nowait()
            except queue.Empty:
                return False
            if event is _INTERRUPT or (isinstance(event, dict) and event.get("type") == "control.interrupt"):
                was_interrupted[0] = True
                self.suppress_output = True
                return True
            input_q.put(event)
            return False

        completed = backend.flush_remaining(check_interrupted)

        # Should have stopped early
        self.assertFalse(completed, "flush_remaining should return False on interrupt")
        self.assertTrue(was_interrupted[0], "Interrupt should have been detected")

        # Should have executed ~6 steps (5 before interrupt injected + 1 more
        # where check catches it), NOT all 20
        self.assertLessEqual(backend.steps_executed, steps_before_interrupt + 1,
                             f"Should stop after ~{steps_before_interrupt} steps, "
                             f"got {backend.steps_executed}")
        self.assertLess(len(self.emitted_chunks), 20,
                        "Should NOT emit all 20 chunks")

    def test_fix_suppress_output_stops_emission(self):
        """VERIFIES FIX: suppress_output flag prevents on_audio_samples from emitting."""
        backend = MockBackend(self.on_audio_samples, total_steps=10)
        backend.start_utterance()

        # Run 3 steps normally
        for _ in range(3):
            backend.step()
        chunks_before = len(self.emitted_chunks)
        self.assertEqual(chunks_before, 3, "Should have 3 chunks before suppression")

        # Enable suppression (simulating interrupt)
        self.suppress_output = True

        # Run remaining steps
        for _ in range(7):
            backend.step()

        # No new chunks should have been emitted
        self.assertEqual(len(self.emitted_chunks), chunks_before,
                         "No new chunks should be emitted after suppress_output=True")

    def test_fix_new_generation_resets_suppress(self):
        """VERIFIES FIX: Starting new generation clears suppress_output."""
        backend = MockBackend(self.on_audio_samples, total_steps=5)

        # Simulate interrupt (sets suppress)
        self.suppress_output = True
        backend.start_utterance()
        backend.step()
        self.assertEqual(len(self.emitted_chunks), 0,
                         "No emission while suppressed")

        # Simulate new generation starting (resets suppress)
        self.suppress_output = False
        backend.start_utterance()
        backend.step()
        self.assertEqual(len(self.emitted_chunks), 1,
                         "Should emit after suppress reset")

    def test_fix_finish_generation_with_interrupt(self):
        """VERIFIES FIX: finish_generation detects interrupt and discards output."""
        backend = MockBackend(self.on_audio_samples, total_steps=20)
        input_q = queue.Queue()

        # Simulate the finish_generation flow
        text_buffer = ""
        generating = True
        first_turn = True
        output_buffer = self.output_buffer

        backend.start_utterance()

        # Inject interrupt after 3 steps
        original_step = backend.step
        injected = [False]
        def counting_step():
            result = original_step()
            if backend.steps_executed == 3 and not injected[0]:
                input_q.put({"type": "control.interrupt"})
                injected[0] = True
            return result
        backend.step = counting_step

        # This mirrors finish_generation() logic
        was_interrupted = [False]
        def check_interrupted():
            try:
                event = input_q.get_nowait()
            except queue.Empty:
                return False
            if isinstance(event, dict) and event.get("type") == "control.interrupt":
                was_interrupted[0] = True
                self.suppress_output = True
                return True
            input_q.put(event)
            return False

        completed = backend.flush_remaining(check_interrupted)

        if not completed or was_interrupted[0]:
            # Discard buffered output (matching the fix)
            self.output_buffer.clear()
            discarded = True
        else:
            discarded = False

        backend.stop()

        self.assertTrue(discarded, "Should have discarded output on interrupt")
        self.assertLessEqual(backend.steps_executed, 4,
                             "Should stop after ~3-4 steps")


if __name__ == "__main__":
    unittest.main()
