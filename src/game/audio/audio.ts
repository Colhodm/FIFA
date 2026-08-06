/**
 * Web Audio engine. Everything is synthesised by default so the MVP ships with no licensed
 * samples; if `public/audio/manifest.json` exists its samples are used instead. Nothing here
 * touches the render thread beyond scheduling nodes.
 */

/** Base-aware URL so the game works when deployed under a subpath. */
export const assetUrl = (path: string): string =>
  `${import.meta.env.BASE_URL.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;

type SampleName = 'kick' | 'whistle' | 'goal' | 'crowd';

interface Manifest {
  samples?: Partial<Record<SampleName, string>>;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private crowdGain: GainNode | null = null;
  private crowdFilter: BiquadFilterNode | null = null;
  private samples = new Map<SampleName, AudioBuffer>();
  private noise: AudioBuffer | null = null;
  enabled = true;

  /** Must be called from a user gesture (browsers block audio otherwise). */
  async resume(): Promise<void> {
    if (!this.ctx) {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(this.ctx.destination);
      this.startCrowd();
      void this.loadManifest();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  suspend(): void {
    void this.ctx?.suspend();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(enabled ? 0.55 : 0, this.ctx.currentTime, 0.05);
    }
  }

  private async loadManifest(): Promise<void> {
    try {
      const res = await fetch(assetUrl('audio/manifest.json'));
      if (!res.ok) return;
      const manifest = (await res.json()) as Manifest;
      await Promise.all(
        Object.entries(manifest.samples ?? {}).map(async ([name, file]) => {
          const buffer = await this.decode(assetUrl(`audio/${file}`));
          if (buffer) this.samples.set(name as SampleName, buffer);
        }),
      );
    } catch {
      // No manifest: synthesised audio only.
    }
  }

  private async decode(url: string): Promise<AudioBuffer | null> {
    if (!this.ctx) return null;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return await this.ctx.decodeAudioData(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  private noiseBuffer(): AudioBuffer {
    const ctx = this.ctx as AudioContext;
    if (this.noise) return this.noise;
    const length = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      // Leaky integrator -> brown-ish noise, closer to a crowd than white noise.
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
    this.noise = buffer;
    return buffer;
  }

  private playSample(name: SampleName, gain: number): boolean {
    const buffer = this.samples.get(name);
    if (!buffer || !this.ctx || !this.master) return false;
    const source = this.ctx.createBufferSource();
    const g = this.ctx.createGain();
    g.gain.value = gain;
    source.buffer = buffer;
    source.connect(g).connect(this.master);
    source.start();
    return true;
  }

  private startCrowd(): void {
    if (!this.ctx || !this.master) return;
    const source = this.ctx.createBufferSource();
    source.buffer = this.noiseBuffer();
    source.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 600;
    filter.Q.value = 0.6;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.05;
    source.connect(filter).connect(gain).connect(this.master);
    source.start();
    this.crowdGain = gain;
    this.crowdFilter = filter;
  }

  /** 0 = quiet stadium, 1 = the ball is in the box. */
  setCrowdIntensity(intensity: number): void {
    if (!this.ctx || !this.crowdGain || !this.crowdFilter) return;
    const t = this.ctx.currentTime;
    this.crowdGain.gain.setTargetAtTime(0.03 + intensity * 0.16, t, 0.8);
    this.crowdFilter.frequency.setTargetAtTime(500 + intensity * 900, t, 0.8);
  }

  kick(intensity = 0.6): void {
    if (!this.ctx || !this.master || !this.enabled) return;
    if (this.playSample('kick', 0.5 + intensity * 0.5)) return;
    const t = this.ctx.currentTime;
    const thump = this.ctx.createOscillator();
    const thumpGain = this.ctx.createGain();
    thump.frequency.setValueAtTime(180, t);
    thump.frequency.exponentialRampToValueAtTime(60, t + 0.09);
    thumpGain.gain.setValueAtTime(0.5 * (0.4 + intensity), t);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    thump.connect(thumpGain).connect(this.master);
    thump.start(t);
    thump.stop(t + 0.14);

    const click = this.ctx.createBufferSource();
    click.buffer = this.noiseBuffer();
    const clickFilter = this.ctx.createBiquadFilter();
    clickFilter.type = 'highpass';
    clickFilter.frequency.value = 1200;
    const clickGain = this.ctx.createGain();
    clickGain.gain.setValueAtTime(0.35 * (0.4 + intensity), t);
    clickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    click.connect(clickFilter).connect(clickGain).connect(this.master);
    click.start(t);
    click.stop(t + 0.08);
  }

  whistle(duration = 0.45): void {
    if (!this.ctx || !this.master || !this.enabled) return;
    if (this.playSample('whistle', 0.7)) return;
    const t = this.ctx.currentTime;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.32, t + 0.03);
    gain.gain.setValueAtTime(0.32, t + duration - 0.06);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    gain.connect(this.master);

    for (const [freq, level] of [
      [2350, 1],
      [3150, 0.55],
    ] as const) {
      const osc = this.ctx.createOscillator();
      const oscGain = this.ctx.createGain();
      oscGain.gain.value = level;
      osc.type = 'sine';
      osc.frequency.value = freq;
      // Trill: the pea in the whistle.
      const lfo = this.ctx.createOscillator();
      const lfoGain = this.ctx.createGain();
      lfo.frequency.value = 28;
      lfoGain.gain.value = freq * 0.02;
      lfo.connect(lfoGain).connect(osc.frequency);
      lfo.start(t);
      lfo.stop(t + duration);
      osc.connect(oscGain).connect(gain);
      osc.start(t);
      osc.stop(t + duration);
    }
  }

  goal(): void {
    if (!this.ctx || !this.master || !this.enabled) return;
    if (this.playSample('goal', 0.9)) return;
    const t = this.ctx.currentTime;
    const source = this.ctx.createBufferSource();
    source.buffer = this.noiseBuffer();
    source.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(500, t);
    filter.frequency.linearRampToValueAtTime(1800, t + 0.7);
    filter.Q.value = 0.8;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.02, t);
    gain.gain.linearRampToValueAtTime(0.5, t + 0.45);
    gain.gain.exponentialRampToValueAtTime(0.01, t + 3.6);
    source.connect(filter).connect(gain).connect(this.master);
    source.start(t);
    source.stop(t + 3.8);
  }

  save(): void {
    this.kick(0.35);
  }

  tackle(): void {
    if (!this.ctx || !this.master || !this.enabled) return;
    const t = this.ctx.currentTime;
    const source = this.ctx.createBufferSource();
    source.buffer = this.noiseBuffer();
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.3, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    source.connect(filter).connect(gain).connect(this.master);
    source.start(t);
    source.stop(t + 0.3);
  }
}

export const audio = new AudioEngine();
