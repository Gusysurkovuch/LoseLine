'use strict';

/* ================= ЗВУКИ (Web Audio, без внешних файлов) ================= */
(function () {

  const MUTE_KEY = 'tugriki_sound_muted';
  let ctx = null;
  let master = null;
  let muted = false;

  /* --- фоновая аркадная музыка --- */
  let musicGain = null;
  let musicTimer = null;
  let musicNext = 0;
  let musicStep = 0;
  let musicWanted = false;

  const MUSIC_BPM = 104;
  const MUSIC_STEP = 60 / MUSIC_BPM / 4; // длительность 16-й ноты
  // простая прогрессия Am → F → C → G
  const MUSIC_BARS = [
    { bass: 110.00, arp: [440.00, 523.25, 659.25, 523.25] },
    { bass: 87.31,  arp: [349.23, 440.00, 523.25, 440.00] },
    { bass: 130.81, arp: [523.25, 659.25, 783.99, 659.25] },
    { bass: 98.00,  arp: [392.00, 493.88, 587.33, 493.88] },
  ];

  try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch (e) {}

  /** Ленивое создание AudioContext (только после действия пользователя). */
  function ensure() {
    if (muted) return null;
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try {
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0.5;
        master.connect(ctx.destination);
      } catch (e) {
        return null;
      }
    }
    if (ctx.state === 'suspended') {
      try { ctx.resume(); } catch (e) {}
    }
    return ctx;
  }

  function tone(freq, dur, type, vol, slideTo, delay) {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime + (delay || 0);
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(Math.max(20, freq), t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, vol || 0.15), t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  function noise(dur, vol, freq, delay) {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime + (delay || 0);
    const len = Math.max(1, Math.floor(c.sampleRate * dur));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource();
    src.buffer = buf;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq || 1800;
    bp.Q.value = 1.1;
    const g = c.createGain();
    g.gain.value = vol || 0.12;
    src.connect(bp);
    bp.connect(g);
    g.connect(master);
    src.start(t0);
  }

  /* ---------- Музыка: планировщик нот ---------- */
  function musicTone(freq, at, dur, type, vol, slideTo) {
    if (!ctx || !musicGain) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type || 'triangle';
    osc.frequency.setValueAtTime(Math.max(20, freq), at);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), at + dur);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0005, vol || 0.03), at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(g);
    g.connect(musicGain);
    osc.start(at);
    osc.stop(at + dur + 0.03);
  }

  function musicNoise(at, dur, vol, freq, filterType) {
    if (!ctx || !musicGain) return;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = filterType || 'highpass';
    f.frequency.value = freq || 6000;
    f.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.value = vol || 0.015;
    src.connect(f);
    f.connect(g);
    g.connect(musicGain);
    src.start(at);
  }

  function scheduleMusicStep(at) {
    const bar = MUSIC_BARS[Math.floor(musicStep / 16) % MUSIC_BARS.length];
    const s = musicStep % 16;

    // бас — четвертями
    if (s % 4 === 0) {
      musicTone(bar.bass, at, 0.23, 'triangle', 0.055);
      musicTone(bar.bass / 2, at, 0.25, 'sine', 0.040);
    }
    // арпеджио — восьмыми
    if (s % 2 === 0) {
      const note = bar.arp[(s / 2) % bar.arp.length];
      musicTone(note, at, 0.12, 'square', 0.015);
      musicTone(note * 2, at + 0.015, 0.07, 'sine', 0.008);
    }
    // барабаны
    if (s % 4 === 0) musicTone(150, at, 0.10, 'sine', 0.085, 50);
    if (s === 4 || s === 12) musicNoise(at, 0.085, 0.026, 1800, 'bandpass');
    if (s % 2 === 1) musicNoise(at, 0.03, 0.014, 7200, 'highpass');

    musicStep++;
  }

  function musicTick() {
    if (!musicWanted || muted || !ctx) return;
    // после сворачивания вкладки не пытаемся «догнать» ушедшее время
    if (musicNext < ctx.currentTime - 0.4) musicNext = ctx.currentTime + 0.05;
    while (musicNext < ctx.currentTime + 0.18) {
      scheduleMusicStep(musicNext);
      musicNext += MUSIC_STEP;
    }
  }

  function startMusic() {
    musicWanted = true;
    if (muted || musicTimer) return;
    const c = ensure();
    if (!c) return;
    if (!musicGain) {
      musicGain = c.createGain();
      musicGain.gain.value = 0.9;
      musicGain.connect(master);
    } else {
      try { musicGain.gain.cancelScheduledValues(c.currentTime); } catch (e) {}
      musicGain.gain.setValueAtTime(0.9, c.currentTime);
    }
    musicStep = 0;
    musicNext = c.currentTime + 0.08;
    musicTimer = setInterval(musicTick, 50);
    musicTick();
  }

  function stopMusic() {
    musicWanted = false;
    if (musicTimer) {
      clearInterval(musicTimer);
      musicTimer = null;
    }
    if (musicGain && ctx) {
      try {
        musicGain.gain.cancelScheduledValues(ctx.currentTime);
        musicGain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.03);
      } catch (e) {}
    }
  }

  /** Пауза без потери намерения играть (вкладка скрыта, открыт стрим). */
  function pauseMusic() {
    if (musicTimer) {
      clearInterval(musicTimer);
      musicTimer = null;
    }
    if (musicGain && ctx) {
      try {
        musicGain.gain.cancelScheduledValues(ctx.currentTime);
        musicGain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.05);
      } catch (e) {}
    }
  }

  function resumeMusic() {
    if (musicWanted && !muted && !musicTimer) startMusic();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseMusic();
    else resumeMusic();
  });

  const Sound = {
    get muted() { return muted; },

    toggle() {
      muted = !muted;
      try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e) {}
      if (!muted) {
        ensure();
        Sound.ui();
        startMusic();
      } else {
        stopMusic();
      }
      return muted;
    },

    /* --- UI --- */
    ui() { tone(520, 0.05, 'triangle', 0.10, 380); },

    /* --- Слоты --- */
    spin() {
      tone(140, 0.5, 'sawtooth', 0.055, 520);
      noise(0.35, 0.05, 900);
    },
    reelStop(i) {
      tone(110 + (i || 0) * 14, 0.10, 'triangle', 0.16, 55);
      noise(0.05, 0.09, 700 + (i || 0) * 120);
    },
    scatter() {
      [660, 880, 1100].forEach((f, i) => tone(f, 0.14, 'sine', 0.13, null, i * 0.07));
    },

    /* --- Выигрыши --- */
    coin() {
      tone(1046, 0.07, 'sine', 0.12);
      tone(1568, 0.09, 'sine', 0.10, null, 0.05);
    },
    win(level) {
      const seq = level === 'big'
        ? [523, 659, 784, 1046, 1318]
        : [523, 659, 784, 1046];
      seq.forEach((f, i) => tone(f, 0.16, 'triangle', 0.15, null, i * 0.085));
      if (level === 'big') {
        tone(1568, 0.5, 'sine', 0.11, null, 0.45);
        noise(0.25, 0.05, 3000, 0.02);
      }
    },
    lose() {
      tone(220, 0.18, 'sine', 0.10, 150);
      tone(150, 0.28, 'sine', 0.09, 90, 0.12);
    },
    push() {
      tone(330, 0.12, 'triangle', 0.10);
      tone(330, 0.12, 'triangle', 0.08, null, 0.14);
    },

    /* --- Карты / рулетка --- */
    card() { noise(0.06, 0.14, 2400); tone(320, 0.04, 'triangle', 0.05, 240); },
    rouletteSpin(dur) {
      let t = 0;
      const total = 26;
      for (let i = 0; i < total; i++) {
        const p = i / total;
        tone(1000 + Math.random() * 300, 0.025, 'square', 0.045, null, t);
        t += 0.06 + p * p * 0.34;
        if (t > (dur || 4.4) - 0.15) break;
      }
    },

    /* --- фоновая музыка --- */
    startMusic,
    stopMusic,
    pauseMusic,
    resumeMusic,
  };

  window.Sound = Sound;

  // Музыка запускается только после первого действия пользователя
  // (требование браузеров к автозапуску AudioContext).
  function armMusic(e) {
    if (e && e.target && e.target.closest && e.target.closest('#soundBtn')) return;
    document.removeEventListener('pointerdown', armMusic, true);
    document.removeEventListener('keydown', armMusic, true);
    if (!muted) startMusic();
  }
  document.addEventListener('pointerdown', armMusic, true);
  document.addEventListener('keydown', armMusic, true);
})();
