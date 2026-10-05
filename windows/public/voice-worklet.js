// Runs on the audio thread: hands every block of microphone samples to the page.
// Served from public/ because the island's security policy only allows scripts
// from its own origin.

class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      const copy = new Float32Array(channel);
      this.port.postMessage(copy, [copy.buffer]);
    }
    return true;
  }
}

registerProcessor("jimmy-capture", CaptureProcessor);
