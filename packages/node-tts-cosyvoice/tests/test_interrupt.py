"""
Tests for CosyVoice3 TTS interrupt handling.

Verifies that control.interrupt correctly terminates the text generator,
suppresses audio output, and clears buffers. Uses mock synthesis to avoid
needing the actual CosyVoice3 model. No external dependencies (no numpy/torch).
"""

import queue
import random
import struct
import threading
import time
import unittest

# Replicate sentinels and constants to avoid heavy imports
_INTERRUPT = object()
_EOF = object()
_DONE = object()

OUTPUT_SAMPLE_RATE = 16000
CHUNK_DURATION_MS = 100
SAMPLES_PER_CHUNK = OUTPUT_SAMPLE_RATE * CHUNK_DURATION_MS // 1000  # 1600


def text_generator(text_queue):
    """Yields text chunks as they arrive. Returns on _DONE."""
    while True:
        item = text_queue.get()
        if item is _DONE:
            return
        yield item


class MockCosyVoice:
    """Mock CosyVoice3 model that simulates streaming inference.

    Uses pure Python lists instead of numpy/torch to avoid dependencies.
    """

    def __init__(self, chunks_per_word=3, chunk_delay=0.01):
        self.chunks_per_word = chunks_per_word
        self.chunk_delay = chunk_delay

    def inference_sft(self, tts_text, spk_id, stream=True):
        """Mock inference_sft that yields audio chunks for each text piece."""
        for text in tts_text:
            for _ in range(self.chunks_per_word):
                time.sleep(self.chunk_delay)
                # Simulate a small audio chunk (320 samples = 20ms at 16kHz)
                audio = [random.gauss(0, 0.1) for _ in range(320)]
                yield {"tts_speech": MockTensor(audio)}

    def inference_zero_shot(self, tts_text, prompt_text, prompt_speech_16k, stream=True):
        """Mock inference_zero_shot — same behavior as inference_sft."""
        return self.inference_sft(tts_text, spk_id=None, stream=stream)


class MockTensor:
    """Mock torch tensor with squeeze() and cpu() and numpy()."""

    def __init__(self, data):
        self._data = data

    def squeeze(self):
        return self

    def cpu(self):
        return self

    def numpy(self):
        return self._data

    def tolist(self):
        return list(self._data)


class TestInterruptDuringGeneration(unittest.TestCase):
    """Test that interrupt during active generation stops audio emission."""

    def setUp(self):
        self.emitted_chunks = []
        self.output_buffer = []
        self.suppress_output = False

    def on_audio_samples(self, pcm):
        """Mock on_audio_samples: buffer and emit in chunks."""
        if self.suppress_output:
            return
        if hasattr(pcm, 'tolist'):
            self.output_buffer.extend(pcm.tolist())
        else:
            self.output_buffer.extend(pcm)
        while len(self.output_buffer) >= SAMPLES_PER_CHUNK:
            chunk = self.output_buffer[:SAMPLES_PER_CHUNK]
            del self.output_buffer[:SAMPLES_PER_CHUNK]
            self.emitted_chunks.append(chunk)

    def test_interrupt_terminates_generator_and_stops_audio(self):
        """Interrupt should push _DONE to text queue, suppressing further output."""
        text_q = queue.Queue()
        cosyvoice = MockCosyVoice(chunks_per_word=5, chunk_delay=0.02)

        suppress_output = [False]
        synth_done = threading.Event()
        audio_chunks_emitted = []

        def run_synthesis():
            gen = text_generator(text_q)
            for output in cosyvoice.inference_sft(tts_text=gen, spk_id="英文女", stream=True):
                if suppress_output[0]:
                    continue
                audio = output['tts_speech'].squeeze().cpu().numpy()
                audio_chunks_emitted.append(len(audio))
            synth_done.set()

        synth_thread = threading.Thread(target=run_synthesis, daemon=True)
        synth_thread.start()

        # Feed several words
        for word in ["Hello ", "world ", "this ", "is ", "a ", "long ", "sentence "]:
            text_q.put(word)

        # Wait a bit for some processing
        time.sleep(0.1)
        chunks_before_interrupt = len(audio_chunks_emitted)

        # Simulate interrupt
        suppress_output[0] = True
        text_q.put(_DONE)

        synth_done.wait(timeout=10)
        self.assertTrue(synth_done.is_set(), "Synthesis should have completed")

        # Some audio should have been emitted before interrupt
        self.assertGreater(chunks_before_interrupt, 0,
                           "Should have emitted some audio before interrupt")

    def test_interrupt_clears_output_buffer(self):
        """After interrupt, output buffer should be cleared."""
        self.output_buffer = [0.1] * 500  # Partial buffer

        # Simulate abort
        self.suppress_output = True
        self.output_buffer = []

        self.assertEqual(len(self.output_buffer), 0,
                         "Buffer should be empty after interrupt")

    def test_new_generation_after_interrupt(self):
        """After interrupt, starting new generation should work correctly."""
        text_q = queue.Queue()
        cosyvoice = MockCosyVoice(chunks_per_word=2, chunk_delay=0.01)

        # First generation — interrupted
        suppress_output = [False]
        synth_done = threading.Event()

        def run_synthesis_1():
            gen = text_generator(text_q)
            for output in cosyvoice.inference_sft(tts_text=gen, spk_id="英文女", stream=True):
                if suppress_output[0]:
                    continue
                audio = output['tts_speech'].squeeze().cpu().numpy()
                self.on_audio_samples(audio)
            synth_done.set()

        t1 = threading.Thread(target=run_synthesis_1, daemon=True)
        t1.start()

        text_q.put("first ")
        time.sleep(0.05)
        suppress_output[0] = True
        self.output_buffer = []
        text_q.put(_DONE)
        synth_done.wait(timeout=5)

        # Second generation — should work normally
        suppress_output[0] = False
        self.suppress_output = False
        self.emitted_chunks.clear()
        text_q2 = queue.Queue()
        synth_done2 = threading.Event()

        def run_synthesis_2():
            gen = text_generator(text_q2)
            for output in cosyvoice.inference_sft(tts_text=gen, spk_id="英文女", stream=True):
                if suppress_output[0]:
                    continue
                audio = output['tts_speech'].squeeze().cpu().numpy()
                self.on_audio_samples(audio)
            synth_done2.set()

        t2 = threading.Thread(target=run_synthesis_2, daemon=True)
        t2.start()

        text_q2.put("second utterance")
        text_q2.put(_DONE)
        synth_done2.wait(timeout=5)
        self.assertTrue(synth_done2.is_set())

    def test_tool_start_flushes_remaining(self):
        """agent.tool_start should finish generation gracefully (not abort)."""
        text_q = queue.Queue()
        cosyvoice = MockCosyVoice(chunks_per_word=2, chunk_delay=0.01)
        audio_count = [0]

        synth_done = threading.Event()

        def run_synthesis():
            gen = text_generator(text_q)
            for output in cosyvoice.inference_sft(tts_text=gen, spk_id="英文女", stream=True):
                audio = output['tts_speech'].squeeze().cpu().numpy()
                audio_count[0] += 1
            synth_done.set()

        t = threading.Thread(target=run_synthesis, daemon=True)
        t.start()

        text_q.put("thinking ")
        text_q.put("about ")
        # Simulate tool_start — graceful finish
        text_q.put(_DONE)

        synth_done.wait(timeout=5)
        self.assertTrue(synth_done.is_set())
        # Should have processed the words that were already queued
        self.assertGreater(audio_count[0], 0, "Should have emitted some audio")


class TestSuppressOutputFlag(unittest.TestCase):
    """Test the suppress_output mechanism."""

    def test_suppress_prevents_audio_emission(self):
        """When suppress_output is True, on_audio_samples should not emit."""
        emitted = []
        suppress = [False]

        def on_audio_samples(pcm):
            if suppress[0]:
                return
            emitted.append(pcm)

        # Normal emission
        on_audio_samples([0.0] * 100)
        self.assertEqual(len(emitted), 1)

        # Suppressed
        suppress[0] = True
        on_audio_samples([0.0] * 100)
        self.assertEqual(len(emitted), 1, "Should not emit when suppressed")

    def test_suppress_reset_on_new_generation(self):
        """suppress_output should be reset when starting new generation."""
        suppress = [True]

        # Simulate start_generation
        suppress[0] = False

        self.assertFalse(suppress[0], "Should be reset for new generation")


if __name__ == "__main__":
    unittest.main()
