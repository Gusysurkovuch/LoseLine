'use strict';

/* ================= РАННЕР «Побег по крышам» ================= */
/*
 * Собственный аналог бесконечного раннера в духе Subway Surfers:
 * три полосы, прыжок, подкат, монеты, препятствия и временные
 * множители ×2 / ×3 / ×5 / ×10. Вся графика рисуется на Canvas 2D,
 * ничего не копируется из оригинальной игры.
 */
(function () {

  const $ = (id) => document.getElementById(id);

  const Z_FAR = 55;
  const HIT_Z = 0.9;
  const BASE_SPEED = 17;
  const MAX_SPEED = 44;
  const COIN_VALUE = 500;
  const POWER_MS = 12000;
  const JUMP_TIME = 0.72;
  const SLIDE_TIME = 0.62;
  const FLUSH_EVERY = 1.5;
  const BEST_KEY = 'loseline_runner_best_v1';

  let canvas, ctx, stage;
  let W = 320;
  let H = 480;
  let DPR = 1;

  const els = {};

  const state = {
    mode: 'idle', // idle | running | paused | over
    paused: false,
    raf: 0,
    lastFrame: 0,
    elapsed: 0,
    distance: 0,
    speed: BASE_SPEED,
    objects: [],
    spawnTimer: 1.1,
    coinTimer: 0.8,
    powerTimer: 8,
    mult: 1,
    multUntil: 0,
    multLeft: 0,
    pending: 0,
    earned: 0,
    coins: 0,
    flushTimer: FLUSH_EVERY,
    runPhase: 0,
    soundAt: 0,
    player: { lane: 1, x: 1, jump: 0, slide: 0 },
    best: 0,
  };

  /* ---------- Утилиты ---------- */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function readBest() {
    try { return Math.max(0, Math.floor(Number(localStorage.getItem(BEST_KEY)) || 0)); }
    catch (e) { return 0; }
  }

  function saveBest(v) {
    try { localStorage.setItem(BEST_KEY, String(Math.max(0, Math.floor(v)))); } catch (e) {}
  }

  function fmt(n) {
    if (window.App && App.fmt) return App.fmt(n);
    return String(Math.floor(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0');
  }

  function toast(msg) {
    if (window.App && App.toast) App.toast(msg);
  }

  function haptic(type) {
    if (window.App && App.haptic) App.haptic(type);
  }

  function roundRect(x, y, w, h, r) {
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ---------- Проекция ---------- */
  function project(z) {
    const p = clamp(z / Z_FAR, 0, 1);
    const depth = 1 - p;
    const horizon = H * 0.36;
    const y = horizon + (H * 1.0 - horizon) * Math.pow(depth, 1.32);
    const scale = Math.pow(depth, 1.22);
    const half = W * 0.395 * Math.pow(depth, 1.26);
    return { y, scale, half, p };
  }

  function laneX(lane, z) {
    return W / 2 + (lane - 1) * project(z).half * 0.64;
  }

  /* ---------- Размер canvas ---------- */
  function resize() {
    if (!canvas || !stage) return;
    const rect = stage.getBoundingClientRect();
    W = Math.max(220, Math.round(rect.width || 320));
    H = Math.max(300, Math.round(rect.height || 480));
    DPR = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    if (ctx) ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    draw();
  }

  /* ---------- Заработок ---------- */
  function flush() {
    if (state.pending <= 0) return;
    const amount = Math.floor(state.pending);
    state.pending -= amount;
    if (amount > 0 && window.App && App.addBalance) App.addBalance(amount);
  }

  function collectCoin() {
    const value = COIN_VALUE * state.mult;
    state.pending += value;
    state.earned += value;
    state.coins++;
    const now = performance.now();
    if (window.Sound && now - state.soundAt > 95) {
      state.soundAt = now;
      try { Sound.coin(); } catch (e) {}
    }
  }

  function collectPower(mult) {
    const next = Math.max(state.mult, mult);
    const upgraded = next > state.mult;
    state.mult = next;
    state.multUntil = performance.now() + POWER_MS;
    state.multLeft = POWER_MS / 1000;
    haptic('success');
    if (window.Sound) { try { Sound.win('normal'); } catch (e) {} }
    toast('Множитель ×' + mult + ' на 12 секунд' + (upgraded ? '' : ' (продлён)'));
  }

  /* ---------- Спавн ---------- */
  function laneBlocked(lane, z) {
    return state.objects.some((o) =>
      o.kind === 'obstacle' && o.lane === lane && Math.abs(o.z - z) < 2.6
    );
  }

  function spawnObstacles() {
    const free = Math.floor(Math.random() * 3);
    const lanes = [0, 1, 2].filter((l) => l !== free);
    if (Math.random() < 0.5) lanes.reverse();

    const count = Math.random() < 0.4 ? 2 : 1;
    const types = ['low', 'high', 'block'];
    if (state.elapsed > 18) types.push('train');

    for (let i = 0; i < count; i++) {
      const lane = lanes[i];
      let type = types[Math.floor(Math.random() * types.length)];
      // Перекладина требует подката, барьер — прыжка. Не ставим два
      // одинаковых «полных» блока в одну линию на одной полосе.
      state.objects.push({
        kind: 'obstacle',
        type,
        lane,
        z: Z_FAR + i * 2.2,
        prevZ: Z_FAR + i * 2.2,
        done: false,
        seed: Math.random() * 6.28,
      });
    }
  }

  function spawnCoins() {
    let lane = Math.floor(Math.random() * 3);
    const count = 4 + Math.floor(Math.random() * 4);
    for (let i = 0; i < count; i++) {
      if (i > 0 && Math.random() < 0.16) {
        lane = clamp(lane + (Math.random() < 0.5 ? -1 : 1), 0, 2);
      }
      const z = Z_FAR + i * 2.2;
      if (laneBlocked(lane, z)) continue;
      state.objects.push({
        kind: 'coin',
        lane,
        z,
        prevZ: z,
        done: false,
        seed: Math.random() * 6.28,
      });
    }
  }

  function spawnPower() {
    const lane = Math.floor(Math.random() * 3);
    if (laneBlocked(lane, Z_FAR)) return;
    const roll = Math.random();
    const mult = roll < 0.5 ? 2 : roll < 0.78 ? 3 : roll < 0.94 ? 5 : 10;
    state.objects.push({
      kind: 'power',
      mult,
      lane,
      z: Z_FAR,
      prevZ: Z_FAR,
      done: false,
      seed: Math.random() * 6.28,
    });
  }

  /* ---------- Игровые действия ---------- */
  function act(type) {
    if (state.mode !== 'running' || state.paused) return;
    const p = state.player;
    if (type === 'left') {
      if (p.lane > 0) { p.lane--; haptic('light'); }
    } else if (type === 'right') {
      if (p.lane < 2) { p.lane++; haptic('light'); }
    } else if (type === 'jump') {
      if (p.slide <= 0) { p.jump = JUMP_TIME; haptic('medium'); }
    } else if (type === 'slide') {
      p.jump = 0;
      p.slide = SLIDE_TIME;
      haptic('medium');
    }
  }

  function interact(o) {
    o.done = true;
    const lane = state.player.lane;

    if (o.kind === 'coin') {
      if (o.lane === lane) collectCoin();
      return;
    }

    if (o.kind === 'power') {
      if (o.lane === lane) collectPower(o.mult);
      return;
    }

    if (o.kind !== 'obstacle') return;
    if (o.lane !== lane) return;

    if (o.type === 'low' && state.player.jump > 0) return;
    if (o.type === 'high' && state.player.slide > 0) return;

    crash();
  }

  function crash() {
    if (state.mode !== 'running') return;
    state.mode = 'over';
    state.paused = false;
    flush();
    stopLoop();
    if (window.Sound) { try { Sound.lose(); } catch (e) {} }
    haptic('error');
    if (state.distance > state.best) {
      state.best = Math.floor(state.distance);
      saveBest(state.best);
    }
    updateHud();
    showOverlay('over');
    draw();
  }

  /* ---------- Обновление ---------- */
  function update(dt) {
    state.elapsed += dt;
    state.speed = Math.min(MAX_SPEED, BASE_SPEED + state.elapsed * 0.55);
    state.distance += state.speed * dt;
    state.runPhase += dt * (5 + state.speed * 0.12);

    const p = state.player;
    if (p.jump > 0) p.jump = Math.max(0, p.jump - dt);
    if (p.slide > 0) p.slide = Math.max(0, p.slide - dt);
    p.x += (p.lane - p.x) * Math.min(1, dt * 15);

    state.spawnTimer -= dt;
    if (state.spawnTimer <= 0) {
      spawnObstacles();
      state.spawnTimer = Math.max(0.55, 1.45 - state.elapsed * 0.012) + Math.random() * 0.35;
    }

    state.coinTimer -= dt;
    if (state.coinTimer <= 0) {
      spawnCoins();
      state.coinTimer = 1.0 + Math.random() * 1.5;
    }

    state.powerTimer -= dt;
    if (state.powerTimer <= 0) {
      spawnPower();
      state.powerTimer = 11 + Math.random() * 9;
    }

    for (let i = state.objects.length - 1; i >= 0; i--) {
      const o = state.objects[i];
      o.prevZ = o.z;
      o.z -= state.speed * dt;
      if (!o.done && o.prevZ > HIT_Z && o.z <= HIT_Z) interact(o);
      if (o.z < -4) state.objects.splice(i, 1);
    }

    if (state.mult > 1) {
      const left = state.multUntil - performance.now();
      state.multLeft = Math.max(0, left / 1000);
      if (left <= 0) {
        state.mult = 1;
        state.multLeft = 0;
      }
    }

    state.flushTimer -= dt;
    if (state.flushTimer <= 0) {
      flush();
      state.flushTimer = FLUSH_EVERY;
    }

    updateHud();
  }

  function updateHud() {
    if (els.dist) els.dist.textContent = Math.floor(state.distance) + ' м';
    if (els.mult) {
      els.mult.textContent = '×' + state.mult;
      els.mult.classList.toggle('hot', state.mult > 1);
    }
    if (els.earn) els.earn.textContent = fmt(state.earned) + ' 🪙';
    if (els.badge) {
      if (state.mult > 1) {
        els.badge.classList.remove('hidden');
        els.badge.textContent = '×' + state.mult + ' · ' + state.multLeft.toFixed(1) + ' с';
      } else {
        els.badge.classList.add('hidden');
      }
    }
  }

  /* ---------- Отрисовка ---------- */
  function draw() {
    if (!ctx) return;

    // Небо
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#0c091c');
    sky.addColorStop(0.42, '#241445');
    sky.addColorStop(0.68, '#4b2163');
    sky.addColorStop(0.72, '#1a1333');
    sky.addColorStop(1, '#0e0b1d');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    // Звёзды
    for (let i = 0; i < 42; i++) {
      const sx = ((i * 73) % 997) / 997 * W;
      const sy = ((i * 151) % 997) / 997 * H * 0.33;
      ctx.globalAlpha = 0.22 + ((i * 37) % 10) / 22;
      ctx.fillStyle = '#dfe8ff';
      ctx.beginPath();
      ctx.arc(sx, sy, i % 4 === 0 ? 1.5 : 0.9, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Луна
    const mx = W * 0.79;
    const my = H * 0.15;
    const moon = ctx.createRadialGradient(mx, my, 2, mx, my, H * 0.16);
    moon.addColorStop(0, 'rgba(255,231,183,.55)');
    moon.addColorStop(1, 'rgba(255,231,183,0)');
    ctx.fillStyle = moon;
    ctx.beginPath();
    ctx.arc(mx, my, H * 0.16, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffe9c4';
    ctx.beginPath();
    ctx.arc(mx, my, H * 0.043, 0, Math.PI * 2);
    ctx.fill();

    drawSkyline();
    drawRoad();
    drawObjects();
    drawPlayer();
  }

  function drawSkyline() {
    const scroll = state.distance * 0.0035;
    for (let row = 0; row < 2; row++) {
      const baseY = H * (row === 0 ? 0.355 : 0.405);
      const speed = row === 0 ? 0.55 : 1.15;
      ctx.fillStyle = row === 0 ? 'rgba(24,17,50,.78)' : 'rgba(12,9,28,.94)';

      for (let i = 0; i < 22; i++) {
        const bw = W * (0.04 + ((i * 29) % 7) * 0.007);
        const bh = H * (0.05 + ((i * 47) % 11) * 0.012) * (row === 0 ? 0.85 : 1.25);
        let x = ((i * 0.083 - scroll * speed) % 1.35 + 1.35) % 1.35 - 0.16;
        const px = x * W;
        ctx.fillRect(px, baseY - bh, bw, bh);

        if (row === 1) {
          ctx.fillStyle = 'rgba(245,196,81,.35)';
          const cols = Math.max(2, Math.floor(bw / 9));
          for (let c = 0; c < cols; c++) {
            for (let r = 0; r < 3; r++) {
              if (((i + c * 3 + r * 7) % 5) === 0) continue;
              ctx.fillRect(px + 4 + c * 8, baseY - bh + 6 + r * 9, 4, 5);
            }
          }
          ctx.fillStyle = 'rgba(12,9,28,.94)';
        }
      }
    }
  }

  function drawRoad() {
    const far = project(Z_FAR);
    const near = project(0);

    ctx.beginPath();
    ctx.moveTo(W / 2 - far.half, far.y);
    ctx.lineTo(W / 2 + far.half, far.y);
    ctx.lineTo(W / 2 + near.half, near.y);
    ctx.lineTo(W / 2 - near.half, near.y);
    ctx.closePath();

    const road = ctx.createLinearGradient(0, far.y, 0, near.y);
    road.addColorStop(0, '#2a1f4d');
    road.addColorStop(0.6, '#1c1636');
    road.addColorStop(1, '#151129');
    ctx.fillStyle = road;
    ctx.fill();

    // Неоновые бортики
    ctx.strokeStyle = 'rgba(139,92,246,.65)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(W / 2 - far.half, far.y);
    ctx.lineTo(W / 2 - near.half, near.y);
    ctx.moveTo(W / 2 + far.half, far.y);
    ctx.lineTo(W / 2 + near.half, near.y);
    ctx.stroke();

    // Разделители полос
    ctx.strokeStyle = 'rgba(190,170,255,.22)';
    ctx.lineWidth = 1.5;
    for (let b = -1; b <= 1; b += 2) {
      ctx.beginPath();
      ctx.moveTo(W / 2 + b * 0.5 * far.half * 0.64, far.y);
      ctx.lineTo(W / 2 + b * 0.5 * near.half * 0.64, near.y);
      ctx.stroke();
    }

    // Бегущие полосы дороги
    const spacing = 3.2;
    const phase = (state.distance * 1.5) % spacing;
    for (let i = 0; i < 22; i++) {
      const z = i * spacing + (spacing - phase);
      if (z > Z_FAR) break;
      const pr = project(z);
      const alpha = 0.05 + 0.13 * (1 - pr.p);
      ctx.strokeStyle = 'rgba(185,168,255,' + alpha.toFixed(3) + ')';
      ctx.lineWidth = Math.max(1, 2.6 * pr.scale);
      ctx.beginPath();
      ctx.moveTo(W / 2 - pr.half * 0.93, pr.y);
      ctx.lineTo(W / 2 + pr.half * 0.93, pr.y);
      ctx.stroke();
    }
  }

  function drawObjects() {
    const list = state.objects.slice().sort((a, b) => b.z - a.z);
    for (const o of list) {
      if (o.kind === 'coin') drawCoin(o);
      else if (o.kind === 'power') drawPower(o);
      else drawObstacle(o);
    }
  }

  function drawCoin(o) {
    const pr = project(o.z);
    if (pr.scale <= 0.02) return;
    const x = laneX(o.lane, o.z);
    const r = Math.max(2.5, H * 0.032 * pr.scale);
    const y = pr.y - r * 2.1;
    const wobble = 0.5 + 0.5 * Math.abs(Math.cos(state.elapsed * 7 + o.seed));

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(Math.max(0.25, wobble), 1);
    const g = ctx.createRadialGradient(-r * 0.35, -r * 0.35, r * 0.15, 0, 0, r);
    g.addColorStop(0, '#fff9cf');
    g.addColorStop(0.55, '#fbbf24');
    g.addColorStop(1, '#b45309');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.7)';
    ctx.lineWidth = Math.max(1, r * 0.16);
    ctx.stroke();
    ctx.restore();
  }

  function drawPower(o) {
    const pr = project(o.z);
    if (pr.scale <= 0.02) return;
    const x = laneX(o.lane, o.z);
    const r = Math.max(4, H * 0.045 * pr.scale);
    const y = pr.y - r * 2.4;
    const colors = { 2: '#38bdf8', 3: '#a78bfa', 5: '#fb7185', 10: '#facc15' };
    const col = colors[o.mult] || '#facc15';

    ctx.save();
    const glow = ctx.createRadialGradient(x, y, r * 0.2, x, y, r * 2.1);
    glow.addColorStop(0, 'rgba(255,255,255,.35)');
    glow.addColorStop(0.45, col + '88');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, r * 2.1, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#120f24';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(2, r * 0.18);
    ctx.stroke();

    ctx.fillStyle = col;
    ctx.font = '800 ' + Math.max(7, r * 1.05) + 'px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('×' + o.mult, x, y + r * 0.06);
    ctx.restore();
  }

  function drawObstacle(o) {
    const pr = project(o.z);
    if (pr.scale <= 0.02) return;
    const x = laneX(o.lane, o.z);
    const laneW = pr.half * 0.64;
    const y = pr.y;
    const s = pr.scale;

    if (o.type === 'low') {
      const w = laneW * 0.78;
      const h = Math.max(3, H * 0.085 * s);
      ctx.fillStyle = '#c2410c';
      ctx.fillRect(x - w / 2, y - h, w, h);
      ctx.fillStyle = '#fbbf24';
      for (let i = 0; i < 4; i++) {
        ctx.fillRect(x - w / 2 + (i + 0.15) * (w / 4), y - h * 0.82, Math.max(1, w * 0.075), h * 0.58);
      }
      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(x - w / 2, y - h, w, Math.max(2, h * 0.18));
      return;
    }

    if (o.type === 'high') {
      const w = laneW * 0.95;
      const barH = Math.max(3, H * 0.075 * s);
      const top = y - H * 0.32 * s;
      const postW = Math.max(2, w * 0.06);
      ctx.fillStyle = '#334155';
      ctx.fillRect(x - w / 2, y - H * 0.26 * s, postW, H * 0.26 * s);
      ctx.fillRect(x + w / 2 - postW, y - H * 0.26 * s, postW, H * 0.26 * s);

      const grad = ctx.createLinearGradient(x - w / 2, top, x + w / 2, top + barH);
      grad.addColorStop(0, '#f43f5e');
      grad.addColorStop(1, '#be123c');
      ctx.fillStyle = grad;
      ctx.fillRect(x - w / 2, top, w, barH);
      ctx.fillStyle = 'rgba(255,255,255,.72)';
      for (let i = 0; i < 5; i++) {
        ctx.fillRect(x - w / 2 + i * (w / 5), top, Math.max(1, w * 0.03), barH);
      }
      return;
    }

    // block / train
    const w = laneW * 0.84;
    const h = Math.max(5, H * (o.type === 'train' ? 0.34 : 0.26) * s);
    const grad = ctx.createLinearGradient(x - w / 2, y - h, x + w / 2, y);
    if (o.type === 'train') {
      grad.addColorStop(0, '#0ea5e9');
      grad.addColorStop(1, '#1e3a8a');
    } else {
      grad.addColorStop(0, '#7f1d1d');
      grad.addColorStop(1, '#3f0d0d');
    }
    ctx.fillStyle = grad;
    ctx.fillRect(x - w / 2, y - h, w, h);

    // Верхняя грань
    ctx.fillStyle = 'rgba(255,255,255,.12)';
    ctx.beginPath();
    ctx.moveTo(x - w / 2, y - h);
    ctx.lineTo(x - w / 2 + w * 0.14, y - h - h * 0.14);
    ctx.lineTo(x + w / 2 + w * 0.14, y - h - h * 0.14);
    ctx.lineTo(x + w / 2, y - h);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = 'rgba(0,0,0,.34)';
    if (o.type === 'train') {
      for (let i = 0; i < 3; i++) {
        ctx.fillRect(x - w * 0.32, y - h * 0.8 + i * h * 0.24, w * 0.64, h * 0.13);
      }
      ctx.fillStyle = 'rgba(255,255,255,.5)';
      ctx.fillRect(x - w * 0.32, y - h * 0.55, w * 0.64, Math.max(1, h * 0.035));
    } else {
      ctx.fillRect(x - w * 0.34, y - h * 0.72, w * 0.68, h * 0.26);
      ctx.fillStyle = 'rgba(255,255,255,.12)';
      ctx.fillRect(x - w * 0.34, y - h * 0.38, w * 0.68, h * 0.08);
    }
  }

  function drawPlayer() {
    const p = state.player;
    const baseY = H * 0.945;
    const laneHalf = W * 0.395 * 0.64;
    const x = W / 2 + (p.x - 1) * laneHalf;
    const jumpProg = p.jump > 0 ? (1 - p.jump / JUMP_TIME) : 0;
    const jumpH = p.jump > 0 ? Math.sin(clamp(jumpProg, 0, 1) * Math.PI) * H * 0.19 : 0;
    const footY = baseY - jumpH;
    const sliding = p.slide > 0;

    // Тень
    ctx.save();
    ctx.globalAlpha = 0.34;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(x, baseY + H * 0.006, W * 0.05 * (1 - jumpH / (H * 0.32)), H * 0.011, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const bodyW = W * 0.062;
    const bodyH = H * 0.13;
    const headR = W * 0.027;

    if (sliding) {
      const sy = footY - H * 0.045;
      ctx.fillStyle = '#0f766e';
      roundRect(x - bodyW * 1.15, sy - bodyH * 0.35, bodyW * 0.55, bodyH * 0.75, 5);
      ctx.fill();

      ctx.fillStyle = '#22d3ee';
      roundRect(x - bodyW * 0.95, sy - bodyH * 0.45, bodyW * 1.75, bodyH * 0.82, 9);
      ctx.fill();

      ctx.fillStyle = 'rgba(255,255,255,.35)';
      ctx.fillRect(x - bodyW * 0.5, sy - bodyH * 0.13, bodyW * 1.1, bodyH * 0.11);

      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = Math.max(2, W * 0.013);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x + bodyW * 0.55, sy + bodyH * 0.15);
      ctx.lineTo(x + bodyW * 1.2, sy + bodyH * 0.32);
      ctx.stroke();

      ctx.fillStyle = '#ffd7b0';
      ctx.beginPath();
      ctx.arc(x + bodyW * 1.08, sy - bodyH * 0.22, headR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1f2937';
      ctx.beginPath();
      ctx.arc(x + bodyW * 1.08, sy - bodyH * 0.28, headR * 0.95, Math.PI, 0);
      ctx.fill();
      return;
    }

    const hipY = footY - H * 0.088;
    const shoulderY = footY - H * 0.185;
    const swing = Math.sin(state.runPhase) * (p.jump > 0 ? 0.35 : 1);

    // Рюкзак
    ctx.fillStyle = '#0f766e';
    roundRect(x - bodyW * 0.82, shoulderY + bodyH * 0.05, bodyW * 0.55, bodyH * 0.72, 5);
    ctx.fill();

    // Ноги
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = Math.max(2, W * 0.013);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - bodyW * 0.22, hipY);
    ctx.lineTo(x - bodyW * 0.22 + swing * bodyW * 0.6, footY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + bodyW * 0.22, hipY);
    ctx.lineTo(x + bodyW * 0.22 - swing * bodyW * 0.6, footY);
    ctx.stroke();

    // Куртка
    ctx.fillStyle = '#22d3ee';
    roundRect(x - bodyW * 0.5, shoulderY, bodyW, bodyH, 8);
    ctx.fill();

    // Светлая полоса
    ctx.fillStyle = 'rgba(255,255,255,.38)';
    ctx.fillRect(x - bodyW * 0.36, shoulderY + bodyH * 0.24, bodyW * 0.72, bodyH * 0.1);

    // Руки
    ctx.strokeStyle = '#0ea5b7';
    ctx.lineWidth = Math.max(2, W * 0.012);
    const armSwing = -swing * 0.9;
    ctx.beginPath();
    ctx.moveTo(x - bodyW * 0.42, shoulderY + bodyH * 0.2);
    ctx.lineTo(x - bodyW * 0.66 + armSwing * bodyW * 0.35, shoulderY + bodyH * 0.68);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + bodyW * 0.42, shoulderY + bodyH * 0.2);
    ctx.lineTo(x + bodyW * 0.66 - armSwing * bodyW * 0.35, shoulderY + bodyH * 0.68);
    ctx.stroke();

    // Голова
    ctx.fillStyle = '#ffd7b0';
    ctx.beginPath();
    ctx.arc(x, shoulderY - headR * 0.9, headR, 0, Math.PI * 2);
    ctx.fill();

    // Волосы
    ctx.fillStyle = '#1f2937';
    ctx.beginPath();
    ctx.arc(x, shoulderY - headR * 1.02, headR * 0.98, Math.PI, 0);
    ctx.fill();

    // Глаз
    ctx.fillStyle = '#111827';
    ctx.beginPath();
    ctx.arc(x + headR * 0.34, shoulderY - headR * 0.9, Math.max(1, headR * 0.12), 0, Math.PI * 2);
    ctx.fill();
  }

  /* ---------- Оверлей ---------- */
  function showOverlay(kind) {
    const box = els.overlay;
    if (!box) return;
    const title = els.ovTitle;
    const text = els.ovText;
    const startBtn = els.startBtn;
    const resumeBtn = els.resumeBtn;

    if (kind === 'running') {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');

    if (kind === 'paused') {
      if (title) title.textContent = 'ПАУЗА';
      if (text) text.textContent = 'Забег приостановлен. Заработок уже сохранён на балансе.';
      if (startBtn) startBtn.classList.add('hidden');
      if (resumeBtn) resumeBtn.classList.remove('hidden');
    } else if (kind === 'over') {
      if (title) title.textContent = 'ЗАБЕГ ОКОНЧЕН';
      if (text) {
        text.textContent = 'Дистанция: ' + Math.floor(state.distance) + ' м · Монет: ' +
          state.coins + ' · Заработано: ' + fmt(state.earned) + ' 🪙' +
          (state.best ? ' · Рекорд: ' + state.best + ' м' : '');
      }
      if (startBtn) { startBtn.classList.remove('hidden'); startBtn.textContent = 'ЕЩЁ РАЗ'; }
      if (resumeBtn) resumeBtn.classList.add('hidden');
    } else {
      if (title) title.textContent = 'Побег по крышам';
      if (text) {
        text.textContent = 'Собирай монеты, перепрыгивай барьеры, подкатывайся под перекладины и меняй полосу. ' +
          'Множители ×2 / ×3 / ×5 / ×10 действуют ограниченное время.';
      }
      if (startBtn) { startBtn.classList.remove('hidden'); startBtn.textContent = 'НАЧАТЬ БЕГ'; }
      if (resumeBtn) resumeBtn.classList.add('hidden');
    }
  }

  function hideOverlay() {
    if (els.overlay) els.overlay.classList.add('hidden');
  }

  /* ---------- Жизненный цикл ---------- */
  function startLoop() {
    if (state.raf) return;
    state.lastFrame = performance.now();
    state.raf = requestAnimationFrame(loop);
  }

  function stopLoop() {
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
  }

  function loop(now) {
    state.raf = 0;
    const dt = Math.min(0.05, Math.max(0, (now - state.lastFrame) / 1000));
    state.lastFrame = now;

    if (state.mode === 'running' && !state.paused) {
      update(dt);
      if (state.mode === 'running' && !state.paused) {
        state.raf = requestAnimationFrame(loop);
      }
    }
    draw();
  }

  function startRun() {
    flush();
    state.mode = 'running';
    state.paused = false;
    state.elapsed = 0;
    state.distance = 0;
    state.speed = BASE_SPEED;
    state.objects = [];
    state.spawnTimer = 1.1;
    state.coinTimer = 0.8;
    state.powerTimer = 8;
    state.mult = 1;
    state.multUntil = 0;
    state.multLeft = 0;
    state.pending = 0;
    state.earned = 0;
    state.coins = 0;
    state.flushTimer = FLUSH_EVERY;
    state.runPhase = 0;
    state.player = { lane: 1, x: 1, jump: 0, slide: 0 };
    state.best = readBest();

    hideOverlay();
    updateHud();
    stopLoop();
    startLoop();
    haptic('medium');
  }

  function pauseGame(auto) {
    if (state.mode !== 'running' || state.paused) return;
    state.paused = true;
    flush();
    stopLoop();
    updateHud();
    showOverlay('paused');
    draw();
    if (!auto) haptic('light');
  }

  function resumeGame() {
    if (state.mode !== 'running') { startRun(); return; }
    if (!state.paused) return;
    state.paused = false;
    hideOverlay();
    startLoop();
    haptic('light');
  }

  function quit() {
    flush();
    if (state.mode === 'running') pauseGame(true);
    if (window.App) App.showScreen('menu');
  }

  /* ---------- Инициализация ---------- */
  function init() {
    canvas = $('runnerCanvas');
    stage = $('runnerStage');
    els.dist = $('runnerDist');
    els.mult = $('runnerMult');
    els.earn = $('runnerEarn');
    els.badge = $('runnerMultBadge');
    els.overlay = $('runnerOverlay');
    els.ovTitle = $('runnerOverlayTitle');
    els.ovText = $('runnerOverlayText');
    els.startBtn = $('runnerStartBtn');
    els.resumeBtn = $('runnerResumeBtn');
    els.pauseBtn = $('runnerPauseBtn');
    els.quitBtn = $('runnerQuitBtn');

    if (!canvas) return;
    ctx = canvas.getContext('2d');
    if (!ctx) return;

    state.best = readBest();
    resize();
    showOverlay('idle');
    updateHud();

    window.addEventListener('resize', resize);
    if (window.ResizeObserver && stage) {
      try { new ResizeObserver(resize).observe(stage); } catch (e) {}
    }

    if (els.startBtn) {
      els.startBtn.addEventListener('click', () => { startRun(); });
    }
    if (els.resumeBtn) {
      els.resumeBtn.addEventListener('click', () => { resumeGame(); });
    }
    if (els.pauseBtn) {
      els.pauseBtn.addEventListener('click', () => {
        if (state.mode === 'running' && !state.paused) pauseGame(false);
        else if (state.paused) resumeGame();
      });
    }
    if (els.quitBtn) els.quitBtn.addEventListener('click', quit);

    document.querySelectorAll('[data-runner-act]').forEach((btn) => {
      btn.addEventListener('click', () => act(btn.dataset.runnerAct));
    });

    // Клавиатура
    document.addEventListener('keydown', (e) => {
      const active = document.getElementById('screen-runner');
      if (!active || !active.classList.contains('active')) return;
      if (state.mode !== 'running') return;

      const k = e.key;
      if (k === 'ArrowLeft' || k === 'a' || k === 'A' || k === 'ф' || k === 'Ф') { e.preventDefault(); act('left'); }
      else if (k === 'ArrowRight' || k === 'd' || k === 'D' || k === 'в' || k === 'В') { e.preventDefault(); act('right'); }
      else if (k === 'ArrowUp' || k === 'w' || k === 'W' || k === 'ц' || k === 'Ц' || k === ' ') { e.preventDefault(); act('jump'); }
      else if (k === 'ArrowDown' || k === 's' || k === 'S' || k === 'ы' || k === 'Ы') { e.preventDefault(); act('slide'); }
      else if (k === 'Escape' || k === 'p' || k === 'P') {
        e.preventDefault();
        if (state.paused) resumeGame(); else pauseGame(false);
      }
    });

    // Свайпы по игровому полю: телефон — пальцем, ПК — мышью (стрелки и клавиатура тоже работают)
    const swipeArea = stage || canvas;
    let swipeId = null, swipeX = 0, swipeY = 0;
    const SWIPE_MIN = 26;

    const clearSwipe = () => { swipeId = null; };

    swipeArea.addEventListener('pointerdown', (e) => {
      if (swipeId !== null) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // Не перехватываем нажатия по оверлею «Старт / Пауза / Конец»
      if (els.overlay && !els.overlay.classList.contains('hidden')) return;
      swipeId = e.pointerId;
      swipeX = e.clientX;
      swipeY = e.clientY;
      if (swipeArea.setPointerCapture) {
        try { swipeArea.setPointerCapture(e.pointerId); } catch (err) {}
      }
    });

    swipeArea.addEventListener('pointerup', (e) => {
      if (swipeId === null || e.pointerId !== swipeId) return;
      const dx = e.clientX - swipeX;
      const dy = e.clientY - swipeY;
      clearSwipe();
      if (swipeArea.releasePointerCapture) {
        try { swipeArea.releasePointerCapture(e.pointerId); } catch (err) {}
      }
      if (state.mode !== 'running' || state.paused) return;
      const ax = Math.abs(dx), ay = Math.abs(dy);
      if (Math.max(ax, ay) < SWIPE_MIN) return;
      if (ax > ay) act(dx < 0 ? 'left' : 'right');
      else act(dy < 0 ? 'jump' : 'slide');
    });

    const cancelSwipe = (e) => {
      if (swipeId !== null && e.pointerId === swipeId) clearSwipe();
    };
    swipeArea.addEventListener('pointercancel', cancelSwipe);
    swipeArea.addEventListener('lostpointercapture', cancelSwipe);

    // Автопауза при уходе с экрана / сворачивании
    window.addEventListener('screenchange', (e) => {
      const screen = e && e.detail ? e.detail.screen : '';
      if (screen !== 'runner' && state.mode === 'running' && !state.paused) pauseGame(true);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && state.mode === 'running' && !state.paused) pauseGame(true);
    });
    window.addEventListener('beforeunload', flush);
  }

  function onOpen() {
    if (!canvas) return;
    resize();
    updateHud();
    if (state.mode === 'running') {
      if (!state.paused) pauseGame(true);
      else showOverlay('paused');
    } else if (state.mode === 'over') {
      showOverlay('over');
    } else {
      showOverlay('idle');
    }
    draw();
  }

  window.Runner = { init, onOpen, startRun, pauseGame, resumeGame, flush, act };
})();
