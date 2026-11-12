import { Platform } from 'react-native';
import Native from '../modules/commonplace-speech';
import { speaker } from '../../js/speech.js';

// Read-aloud for passages: the shared speaker (js/speech.js) drives the native Kokoro module through this bridge.
// On the web there is no bridge: the speaker falls back to speechSynthesis.
const bridge = Platform.OS === 'web' ? undefined : {
  postMessage: (m: any) => {
    if (m.op === 'read') Native.read(m.id, m.voice, m.chunks.map((c: any) => c.t), m.chunks.map((c: any) => c.gap));
    else Native.stop();
  },
};
if (Platform.OS !== 'web') Native.addListener('speech', (e) => (globalThis as any).commonplaceSpeech?.(e));

// The speaker marks a card's state on `el.dataset.speech`; here the "element" is a stand-in that reports it.
const standIn = (key: string, onState: (key: string, state: string | null) => void) => {
  let value: string | undefined;
  return {
    key,
    querySelector: () => null,
    dataset: new Proxy({} as Record<string, string | undefined>, {
      get: (_, k) => (k === 'speech' ? value : undefined),
      set: (_, k, v) => { if (k === 'speech') { value = v; onState(key, v); } return true; },
      deleteProperty: (_, k) => { if (k === 'speech') { value = undefined; onState(key, null); } return true; },
    }),
  };
};

export const createReader = (onState: (key: string, state: string | null) => void) => {
  const sp = speaker(undefined, bridge);
  return {
    activeKey: (): string | null => sp.active()?.key ?? null,
    state: (): string | null => sp.state(),
    start: (key: string, body: string, verse: boolean, voice?: string) => sp.start(standIn(key, onState), body, verse, voice),
    toggle: () => sp.toggle(),
    stop: () => sp.stop(),
  };
};
export type Reader = ReturnType<typeof createReader>;
