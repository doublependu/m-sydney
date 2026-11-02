// Works out the game's sounds off the main thread: it takes seconds on a slow phone, and would otherwise be a freeze at the
// player's first touch. The synthesis only needs somewhere to write samples, so a stand-in for the audio context will do.
import { createSynthResources } from './audio-synthesis.js';
import { createEventResources } from './audio-events.js';

function standInContext(sampleRate) {
  return {
    sampleRate,
    createBuffer(count, length, rate) {
      const channels = Array.from({ length: count }, () => new Float32Array(length));
      return { numberOfChannels: count, length, sampleRate: rate, getChannelData: (i) => channels[i], channels };
    },
    createPeriodicWave: (...waveArgs) => ({ waveArgs })
  };
}

self.onmessage = ({ data: { sampleRate } }) => {
  const context = standInContext(sampleRate);
  const resources = createEventResources(context, createSynthResources(context));
  const transfer = [];
  const pack = (value) => {
    if (value?.getChannelData) {
      transfer.push(...value.channels.map((c) => c.buffer));
      return { channels: value.channels, sampleRate: value.sampleRate };
    }
    if (Array.isArray(value)) return value.map(pack);
    if (value?.waveArgs) return value;
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, pack(v)]));
    return value;
  };
  self.postMessage(pack(resources), transfer);
};
