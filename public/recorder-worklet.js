// The microphone, in batches of 1,024 samples (about 21 ms), handed to the page as they fill.
class Recorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(1024);
    this.at = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) {
      for (let i = 0; i < input.length; i++) {
        this.batch[this.at++] = input[i];
        if (this.at === this.batch.length) {
          this.port.postMessage(this.batch.slice());
          this.at = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('recorder', Recorder);
