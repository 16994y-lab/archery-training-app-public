export type TimerSignal = 'prepare' | 'shoot' | 'warning' | 'stop' | 'scoring';

type SignalTone = {
  pulses: number;
  hz: number;
  endHz?: number;
  duration: number;
  gap: number;
  volume: number;
};

const tones: Record<TimerSignal, SignalTone> = {
  prepare: { pulses: 2, hz: 1000, duration: .24, gap: .11, volume: .40 },
  shoot: { pulses: 1, hz: 1220, duration: .31, gap: .11, volume: .45 },
  warning: { pulses: 1, hz: 620, endHz: 440, duration: .15, gap: .11, volume: .29 },
  stop: { pulses: 2, hz: 790, duration: .27, gap: .12, volume: .45 },
  scoring: { pulses: 3, hz: 920, duration: .23, gap: .11, volume: .40 },
};

const floor = .0001;
const attack = .014;
const activationTimeout = 1500;

type AudioConstructor = new () => AudioContext;
type PlayingTone = { oscillator: OscillatorNode; gain: GainNode };

export function createTimerSound() {
  let context: AudioContext | null = null;
  let opening: Promise<boolean> | null = null;
  let failed = false;
  const playing = new Set<PlayingTone>();

  function disconnect(tone: PlayingTone) {
    playing.delete(tone);
    tone.oscillator.disconnect();
    tone.gain.disconnect();
  }

  function stopTones() {
    for (const tone of playing) {
      tone.oscillator.onended = null;
      try { tone.oscillator.stop(); } catch { /* The tone may already have ended. */ }
      disconnect(tone);
    }
  }

  function isReady() {
    return context?.state === 'running' && !failed;
  }

  // Call synchronously from a tap or key press. Only playback awaits activation.
  function unlock(): Promise<boolean> {
    try {
      const host = globalThis as typeof globalThis & { webkitAudioContext?: AudioConstructor };
      const Constructor = host.AudioContext ?? host.webkitAudioContext;
      if (!Constructor) return Promise.resolve(false);
      if (!context || context.state === 'closed') context = new Constructor();
      const target = context;
      if (target.state === 'running') {
        failed = false;
        return Promise.resolve(true);
      }
      if (opening) return opening;

      let timeout: ReturnType<typeof setTimeout> | undefined;
      const resumed = target.resume();
      const bounded = new Promise<boolean>(resolve => {
        timeout = setTimeout(() => resolve(false), activationTimeout);
      });
      const attempt = Promise.race([resumed.then(() => true), bounded])
        .catch(() => false)
        .then(resumedInTime => {
          clearTimeout(timeout);
          if (context !== target) return false;
          failed = !resumedInTime || target.state !== 'running';
          return !failed;
        })
        .finally(() => { if (opening === attempt) opening = null; });
      opening = attempt;
      return attempt;
    } catch {
      failed = true;
      return Promise.resolve(false);
    }
  }

  function play(kind: TimerSignal) {
    const output = context;
    if (!output || !isReady()) return;
    try {
      stopTones();
      const signal = tones[kind];
      const start = output.currentTime + .025;
      for (let pulse = 0; pulse < signal.pulses; pulse++) {
        const at = start + pulse * (signal.duration + signal.gap);
        const end = at + signal.duration;
        const oscillator = output.createOscillator();
        const gain = output.createGain();
        const tone = { oscillator, gain };
        playing.add(tone);
        oscillator.onended = () => disconnect(tone);
        oscillator.type = 'triangle';
        oscillator.frequency.setValueAtTime(signal.hz, at);
        if (signal.endHz !== undefined) oscillator.frequency.exponentialRampToValueAtTime(signal.endHz, end);
        gain.gain.setValueAtTime(floor, at);
        gain.gain.linearRampToValueAtTime(signal.volume, at + attack);
        gain.gain.setValueAtTime(signal.volume, at + signal.duration * .58);
        gain.gain.exponentialRampToValueAtTime(floor, end);
        oscillator.connect(gain).connect(output.destination);
        oscillator.start(at);
        oscillator.stop(end);
      }
    } catch {
      failed = true;
      stopTones();
    }
  }

  function close() {
    const target = context;
    context = null;
    opening = null;
    failed = false;
    stopTones();
    if (target && target.state !== 'closed') void target.close().catch(() => {});
  }

  return { unlock, play, close, isReady };
}
