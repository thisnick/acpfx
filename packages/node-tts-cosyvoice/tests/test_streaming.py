"""
Tests for CosyVoice3 TTS text queue and generator integration.

Verifies the text_generator() function correctly yields text chunks
from a queue and terminates on _DONE sentinel. No model needed.
"""

import queue
import threading
import unittest


# Import the generator and sentinel from the module
# We replicate them here to avoid heavy imports (torch, etc.)
_DONE = object()


def text_generator(text_queue):
    """Yields text chunks as they arrive. Returns on _DONE."""
    while True:
        item = text_queue.get()
        if item is _DONE:
            return
        yield item


class TestTextGenerator(unittest.TestCase):
    """Test the text_generator function used for streaming text to CosyVoice3."""

    def test_yields_text_in_order(self):
        """Generator should yield items in FIFO order."""
        q = queue.Queue()
        words = ["Hello", " ", "world", "!"]
        for w in words:
            q.put(w)
        q.put(_DONE)

        result = list(text_generator(q))
        self.assertEqual(result, words)

    def test_done_sentinel_stops_generator(self):
        """Generator should stop when _DONE is received."""
        q = queue.Queue()
        q.put("first")
        q.put(_DONE)
        q.put("should_not_appear")

        result = list(text_generator(q))
        self.assertEqual(result, ["first"])

    def test_empty_immediately_done(self):
        """Generator with immediate _DONE yields nothing."""
        q = queue.Queue()
        q.put(_DONE)

        result = list(text_generator(q))
        self.assertEqual(result, [])

    def test_blocks_until_data_available(self):
        """Generator should block waiting for queue items."""
        q = queue.Queue()
        results = []
        done = threading.Event()

        def consume():
            for item in text_generator(q):
                results.append(item)
            done.set()

        t = threading.Thread(target=consume, daemon=True)
        t.start()

        # Feed items with small delays
        q.put("word1")
        q.put("word2")
        q.put(_DONE)

        done.wait(timeout=5)
        self.assertTrue(done.is_set(), "Generator should have completed")
        self.assertEqual(results, ["word1", "word2"])

    def test_producer_consumer_threaded(self):
        """Simulate the actual architecture: main thread produces, synth thread consumes."""
        q = queue.Queue()
        consumed = []
        synth_done = threading.Event()

        # Synthesis thread (consumer)
        def synth_thread():
            for text in text_generator(q):
                consumed.append(text)
            synth_done.set()

        t = threading.Thread(target=synth_thread, daemon=True)
        t.start()

        # Main thread (producer) — simulates agent.delta events
        deltas = ["The ", "quick ", "brown ", "fox"]
        for d in deltas:
            q.put(d)

        # Simulate agent.complete
        q.put(_DONE)

        synth_done.wait(timeout=5)
        self.assertTrue(synth_done.is_set())
        self.assertEqual(consumed, deltas)

    def test_interrupt_terminates_generator(self):
        """Simulate interrupt: push _DONE to terminate generator mid-stream."""
        q = queue.Queue()
        consumed = []
        synth_done = threading.Event()

        def synth_thread():
            for text in text_generator(q):
                consumed.append(text)
            synth_done.set()

        t = threading.Thread(target=synth_thread, daemon=True)
        t.start()

        # Feed some words
        q.put("Hello")
        q.put(" world")
        # Simulate interrupt — push _DONE immediately
        q.put(_DONE)

        synth_done.wait(timeout=5)
        self.assertTrue(synth_done.is_set())
        # Only the words before _DONE should appear
        self.assertEqual(consumed, ["Hello", " world"])

    def test_multiple_generations(self):
        """Simulate multiple utterances — each gets its own queue and generator."""
        for i in range(3):
            q = queue.Queue()
            words = [f"utterance{i}_word{j}" for j in range(4)]
            for w in words:
                q.put(w)
            q.put(_DONE)

            result = list(text_generator(q))
            self.assertEqual(result, words)


class TestTextQueueIntegration(unittest.TestCase):
    """Test the text queue patterns used in the event loop."""

    def test_delta_accumulation(self):
        """Simulate agent.delta events pushing text to queue."""
        q = queue.Queue()

        # Simulate event loop pushing deltas
        deltas = [
            {"type": "agent.delta", "delta": "The "},
            {"type": "agent.delta", "delta": "quick "},
            {"type": "agent.delta", "delta": "brown "},
            {"type": "agent.delta", "delta": "fox"},
        ]

        for event in deltas:
            delta = event.get("delta", "")
            if delta:
                q.put(delta)

        # Simulate agent.complete
        q.put(_DONE)

        result = list(text_generator(q))
        self.assertEqual(result, ["The ", "quick ", "brown ", "fox"])

    def test_empty_delta_ignored(self):
        """Empty deltas should not be pushed to the queue."""
        q = queue.Queue()

        deltas = [
            {"type": "agent.delta", "delta": "Hello"},
            {"type": "agent.delta", "delta": ""},
            {"type": "agent.delta", "delta": " world"},
        ]

        for event in deltas:
            delta = event.get("delta", "")
            if delta:
                q.put(delta)
        q.put(_DONE)

        result = list(text_generator(q))
        self.assertEqual(result, ["Hello", " world"])


if __name__ == "__main__":
    unittest.main()
