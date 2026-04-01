#!/bin/bash
# Test the audio player by feeding it events via stdin.
# Usage: ./test-player.sh [test-name]
#
# Tests:
#   speech    - play a short TTS audio clip
#   sfx       - play the thinking SFX loop for 5 seconds
#   tool-sfx  - play the tool SFX loop for 5 seconds
#   transition - SFX playing, then speech arrives

set -e

TEST=${1:-speech}
PLAYER="node dist/nodes/audio-player.js"

# Generate a short test tone (1 second, 440Hz) as base64 PCM
generate_tone() {
  python3 -c "
import struct, math, base64, sys
rate=16000; dur=1.0; freq=440; amp=8000
samples = [int(amp * math.sin(2*math.pi*freq*i/rate)) for i in range(int(rate*dur))]
pcm = struct.pack('<' + 'h'*len(samples), *samples)
sys.stdout.write(base64.b64encode(pcm).decode())
"
}

TONE_B64=$(generate_tone)

export ACPFX_SETTINGS='{"speechSource":"tts","thinkingClip":"./sounds/thinking.wav","toolClip":"./sounds/typing.wav","sfxVolume":0.3}'

case $TEST in
  speech)
    echo "=== Test: speech playback ==="
    {
      # Simulate TTS audio chunk with _from: tts
      echo "{\"type\":\"audio.chunk\",\"_from\":\"tts\",\"trackId\":\"tts\",\"format\":\"pcm_s16le\",\"sampleRate\":16000,\"channels\":1,\"data\":\"$TONE_B64\",\"durationMs\":1000}"
      sleep 2
    } | $PLAYER 2>&1
    ;;

  sfx)
    echo "=== Test: thinking SFX loop ==="
    {
      echo '{"type":"agent.thinking","requestId":"test-1"}'
      sleep 5
    } | $PLAYER 2>&1
    ;;

  tool-sfx)
    echo "=== Test: tool SFX loop ==="
    {
      echo '{"type":"agent.tool_start","requestId":"test-1","toolCallId":"t1","title":"Read"}'
      sleep 5
    } | $PLAYER 2>&1
    ;;

  transition)
    echo "=== Test: SFX then speech ==="
    {
      # Start thinking SFX
      echo '{"type":"agent.thinking","requestId":"test-1"}'
      sleep 3
      # Speech arrives — should cut SFX
      echo "{\"type\":\"audio.chunk\",\"_from\":\"tts\",\"trackId\":\"tts\",\"format\":\"pcm_s16le\",\"sampleRate\":16000,\"channels\":1,\"data\":\"$TONE_B64\",\"durationMs\":1000}"
      sleep 2
    } | $PLAYER 2>&1
    ;;

  speech-tool-speech)
    echo "=== Test: speech -> tool -> speech ==="
    {
      # First speech segment (1 second tone at 440Hz)
      echo "{\"type\":\"audio.chunk\",\"_from\":\"tts\",\"trackId\":\"tts\",\"format\":\"pcm_s16le\",\"sampleRate\":16000,\"channels\":1,\"data\":\"$TONE_B64\",\"durationMs\":1000}"
      sleep 0.5
      # Tool starts while speech may still be in buffer
      echo '{"type":"agent.tool_start","requestId":"test-1","toolCallId":"t1","title":"Read"}'
      # Wait for tool sound to play
      sleep 3
      # Tool done
      echo '{"type":"agent.tool_done","requestId":"test-1","toolCallId":"t1","status":"completed"}'
      sleep 0.2
      # Second speech segment (1 second tone at 660Hz)
      TONE2=$(python3 -c "
import struct, math, base64, sys
rate=16000; dur=1.0; freq=660; amp=8000
samples = [int(amp * math.sin(2*math.pi*freq*i/rate)) for i in range(int(rate*dur))]
pcm = struct.pack('<' + 'h'*len(samples), *samples)
sys.stdout.write(base64.b64encode(pcm).decode())
")
      echo "{\"type\":\"audio.chunk\",\"_from\":\"tts\",\"trackId\":\"tts\",\"format\":\"pcm_s16le\",\"sampleRate\":16000,\"channels\":1,\"data\":\"$TONE2\",\"durationMs\":1000}"
      sleep 2
    } | $PLAYER 2>&1
    ;;

  *)
    echo "Unknown test: $TEST"
    echo "Usage: $0 [speech|sfx|tool-sfx|transition]"
    exit 1
    ;;
esac
