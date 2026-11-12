import { requireNativeModule } from 'expo';

export type SpeechEvent = { id: number; event: 'first' | 'chunk' | 'done' | 'error'; i: number; message: string };
type Native = {
  read(id: number, voice: string, texts: string[], gaps: number[]): void;
  stop(): void;
  tapeLoad(url: string, start: number, end: number): Promise<boolean>;
  tapeHold(f: number): void;
  tapeMove(f: number): void;
  tapeRelease(): void;
  tapePeaks(n: number): number[];
  audioPeaks(url: string, start: number, end: number, n: number): Promise<number[]>;
  tapeUnload(): void;
  addListener(name: 'speech', cb: (e: SpeechEvent) => void): { remove(): void };
};

export default requireNativeModule<Native>('CommonplaceSpeech');
