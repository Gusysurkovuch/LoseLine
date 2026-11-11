'use strict';

/* ================= СЛОТЫ «Пирамида удачи» ================= */
(function () {

  // Выплаты — множители к ставке НА ЛИНИЮ (общая ставка / 20).
  // Скаттер платит от ОБЩЕЙ ставки. RTP ≈ 93% (с фриспинами).
  const SYMBOLS = {
    wild:     { label: '🏺', pay: { 3: 200, 4: 1500, 5: 7500 }, cls: 's-wild', name: 'Пирамида (вайлд)' },
    scatter:  { label: '🪲', pay: { 3: 3, 4: 15, 5: 75 }, cls: 's-scatter', name: 'Скарабей' },
    ankh:     { label: '☥', pay: { 3: 150, 4: 600, 5: 3000 }, cls: 's-ankh', name: 'Анх' },
    eye:      { label: '👁️', pay: { 3: 120, 4: 450, 5: 1800 }, cls: 's-eye', name: 'Око Хора' },
    snake:    { label: '🐍', pay: { 3: 75, 4: 300, 5: 1200 }, cls: 's-snake', name: 'Змея' },
    scorpion: { label: '🦂', pay: { 3: 60, 4: 225, 5: 900 }, cls: 's-scorpion', name: 'Скорпион' },
    urn:      { label: '🏺', pay: { 3: 45, 4: 180, 5: 750 }, cls: 's-urn', name: 'Амфора' },
    A:        { label: 'A', pay: { 3: 30, 4: 120, 5: 450 }, cls: 's-card', name: 'Туз' },
    K:        { label: 'K', pay: { 3: 30, 4: 90, 5: 375 }, cls: 's-card', name: 'Король' },
    Q:        { label: 'Q', pay: { 3: 22, 4: 75, 5: 300 }, cls: 's-card', name: 'Дама' },
    J:        { label: 'J', pay: { 3: 22, 4: 60, 5: 225 }, cls: 's-card', name: 'Валет' },
    ten:      { label: '10', pay: { 3: 15, 4: 45, 5: 180 }, cls: 's-card', name: 'Десятка' },
  };

  const WEIGHTS = {
    wild: 2, scatter: 2, ankh: 5, eye: 7, snake: 9, scorpion: 9,
    urn: 11, A: 13, K: 13, Q: 13, J: 13, ten: 13,
  };

  const ORDER = Object.keys(SYMBOLS);
  const TOTAL_WEIGHT = ORDER.reduce((s, k) => s + WEIGHTS[k], 0);

  // 20 линий: для каждого барабана (0..4) номер ряда (0..2)
  const LINES = [
    [1, 1, 1, 1, 1],
    [0, 0, 0, 0, 0],
    [2, 2, 2, 2, 2],
    [0, 1, 2, 1, 0],
    [2, 1, 0, 1, 2],
    [0, 0, 1, 0, 0],
    [2, 2, 1, 2, 2],
    [1, 0, 0, 0, 1],
    [1, 2, 2, 2, 1],
    [0, 1, 1, 1, 0],
    [2, 1, 1, 1, 2],
    [0, 1, 0, 1, 0],
    [2, 1, 2, 1, 2],
    [1, 0, 1, 0, 1],
    [1, 2, 1, 2, 1],
    [0, 0, 1, 2, 2],
    [2, 2, 1, 0, 0],
    [0, 2, 0, 2, 0],
    [2, 0, 2, 0, 2],
    [1, 1, 0, 1, 1],
  ];

  const LINES_COUNT = LINES.length;
  const STRIP_LEN = 24;     // сколько символов в ленте барабана
  const REEL_GAP = 8;       // должен совпадать с CSS gap
  const STOP_BASE = 980;    // первый барабан останавливается через 0.98 с
  const STOP_STEP = 160;    // каждый следующий — позже на 0.16 с

  let grid = [];
  let cellEls = [];
  let spinning = false;
  let freeSpins = 0;
  let freeBet = 0;
  let bet = null;
  let meterShown = 0;
  let autoOn = false;
  let autoToken = 0;

  const $ = (id) => document.getElementById(id);
  let reelsEl, reelsFrameEl, paylinesEl, slotMachineEl, slotWinEl, slotBetEl;
  let spinBtn, statusEl, bannerEl, freeLeftEl, paytableEl, autoBtn;

  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  function pickSymbol() {
    let r = Math.random() * TOTAL_WEIGHT;
    for (let i = 0; i < ORDER.length; i++) {
      const k = ORDER[i];
      r -= WEIGHTS[k];
      if (r < 0) return k;
    }
    return ORDER[ORDER.length - 1];
  }

  function makeGrid() {
    return Array.from({ length: 5 }, () =>
      Array.from({ length: 3 }, () => pickSymbol())
    );
  }

  /* ---------- Отрисовка ---------- */
  function buildReels() {
    reelsEl.innerHTML = '';
    cellEls = [];
    for (let reel = 0; reel < 5; reel++) {
      const col = document.createElement('div');
      col.className = 'reel-col';

      const strip = document.createElement('div');
      strip.className = 'reel-strip';

      const visible = [];
      for (let i = 0; i < STRIP_LEN; i++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        strip.appendChild(cell);
        if (i < 3) visible.push(cell); // при остановке видны первые 3
      }

      col.appendChild(strip);
      reelsEl.appendChild(col);
      cellEls.push(visible);
    }
    sizeReels();
  }

  function sizeReels() {
    if (!reelsEl || !reelsEl.children.length) return;
    const w = reelsEl.children[0].getBoundingClientRect().width;
    if (w < 10) return; // экран ещё скрыт
    const h = Math.round(w * 3 + REEL_GAP * 2);
    for (const col of reelsEl.children) col.style.height = h + 'px';
  }

  function stripOf(reel) {
    return reelsEl.children[reel].querySelector('.reel-strip');
  }

  function paintCell(cell, key, animate) {
    const s = SYMBOLS[key];
    cell.textContent = s.label;
    cell.className = 'cell ' + s.cls + (s.cls === 's-card' ? ' card-sym' : '');
    if (animate) {
      cell.classList.remove('pop');
      void cell.offsetWidth;
      cell.classList.add('pop');
    }
  }

  /** Заполняет ленту: первые 3 — финальный результат, остальные — случайные. */
  function fillStrip(reel, finalSymbols) {
    const strip = stripOf(reel);
    const kids = strip.children;
    for (let i = 0; i < kids.length; i++) {
      const key = i < 3 ? finalSymbols[i] : pickSymbol();
      paintCell(kids[i], key, false);
    }
    return strip;
  }

  function fillAllStrips(g) {
    for (let reel = 0; reel < 5; reel++) fillStrip(reel, g[reel]);
  }

  function clearHighlight() {
    document.querySelectorAll('#reels .cell').forEach(c => c.classList.remove('win', 'scatter-win'));
  }

  /* ---------- Линии выигрыша ---------- */
  function clearPaylines() {
    if (paylinesEl) paylinesEl.innerHTML = '';
  }

  function drawPaylines(wins) {
    clearPaylines();
    if (!paylinesEl || !reelsFrameEl || !wins || !wins.length) return;
    const frame = reelsFrameEl.getBoundingClientRect();
    if (!frame.width || !frame.height) return;

    wins.slice(0, LINES_COUNT).forEach((w, idx) => {
      const pts = [];
      for (let reel = 0; reel < w.count; reel++) {
        const row = w.line[reel];
        const r = cellEls[reel][row].getBoundingClientRect();
        const x = ((r.left + r.width / 2 - frame.left) / frame.width) * 100;
        const y = ((r.top + r.height / 2 - frame.top) / frame.height) * 100;
        pts.push(x.toFixed(2) + ',' + y.toFixed(2));
      }
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      line.setAttribute('points', pts.join(' '));
      line.setAttribute('class', 'pl-line');
      line.setAttribute('pathLength', '100');
      line.style.animationDelay = (idx * 70) + 'ms';
      paylinesEl.appendChild(line);
    });
  }

  /* ---------- Математика ---------- */
  function lineSequence(g, line) {
    return line.map((row, reel) => g[reel][row]);
  }

  function evaluate(g, totalBet) {
    const lineBet = totalBet / LINES_COUNT;
    let totalWin = 0;
    const wins = [];

    for (const line of LINES) {
      const seq = lineSequence(g, line);
      let base = null;
      for (const s of seq) {
        if (s !== 'wild' && s !== 'scatter') { base = s; break; }
      }
      if (!base) base = 'wild';
      if (base === 'scatter') continue;

      let count = 0;
      for (let i = 0; i < 5; i++) {
        if (seq[i] === base || seq[i] === 'wild') count++;
        else break;
      }
      if (count < 3) continue;

      const pay = (SYMBOLS[base].pay[count] || 0) * lineBet;
      if (pay > 0) {
        totalWin += pay;
        wins.push({ line, count, base, pay });
      }
    }

    // Скаттеры — независимо от линий
    let scatters = 0;
    for (let reel = 0; reel < 5; reel++) {
      for (let row = 0; row < 3; row++) if (g[reel][row] === 'scatter') scatters++;
    }
    if (scatters >= 3) {
      const n = Math.min(scatters, 5);
      totalWin += SYMBOLS.scatter.pay[n] * totalBet;
    }

    return { totalWin, wins, scatters };
  }

  function highlight(wins, scatters) {
    clearHighlight();
    for (const w of wins) {
      for (let reel = 0; reel < w.count; reel++) {
        const row = w.line[reel];
        cellEls[reel][row].classList.add('win');
      }
    }
    if (scatters >= 3) {
      for (let reel = 0; reel < 5; reel++) {
        for (let row = 0; row < 3; row++) {
          if (grid[reel][row] === 'scatter') cellEls[reel][row].classList.add('scatter-win');
        }
      }
    }
  }

  /* ---------- Статус / метры ---------- */
  function setStatus(text, isWin) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle('win', !!isWin);
  }

  function updateBetLabel(v) {
    if (slotBetEl) slotBetEl.textContent = App.fmt(v);
  }

  function setWinMeter(value, animate) {
    if (!slotWinEl) return;
    const from = meterShown;
    meterShown = Math.max(0, Math.round(value) || 0);
    if (animate && meterShown > from) {
      App.countUp(slotWinEl, from, meterShown, 650);
      const meter = slotWinEl.closest('.meter');
      if (meter) {
        meter.classList.remove('hot');
        void meter.offsetWidth;
        meter.classList.add('hot');
      }
    } else {
      slotWinEl._cuId = (slotWinEl._cuId || 0) + 1;
      slotWinEl.textContent = App.fmt(meterShown);
    }
  }

  function updateFreeBanner() {
    if (!bannerEl) return;
    if (freeSpins > 0) {
      bannerEl.classList.remove('hidden');
      if (freeLeftEl) freeLeftEl.textContent = String(freeSpins);
    } else {
      bannerEl.classList.add('hidden');
    }
  }

  /* ---------- Спин ---------- */
  async function spin() {
    if (spinning) return false;
    if (window.Cloud && Cloud.isBanned && Cloud.isBanned()) {
      stopAuto();
      return false;
    }

    const isFree = freeSpins > 0;
    const stake = isFree ? freeBet : bet.value;

    if (!isFree) {
      if (!App.takeBet(stake)) return false;
    } else {
      freeSpins--;
      updateFreeBanner();
    }

    spinning = true;
    if (spinBtn) spinBtn.disabled = true;
    if (bet) bet.lock(true);
    clearHighlight();
    clearPaylines();
    setWinMeter(0, false);
    setStatus(isFree ? 'Фриспин! Крутим…' : 'Барабаны крутятся…', false);
    if (slotMachineEl) slotMachineEl.classList.add('spinning');

    sizeReels();
    grid = makeGrid();

    /* --- Подготовка лент: финальный результат + случайные символы --- */
    const strips = [];
    for (let reel = 0; reel < 5; reel++) {
      const col = reelsEl.children[reel];
      const strip = fillStrip(reel, grid[reel]);
      const w = col.getBoundingClientRect().width || (reelsEl.getBoundingClientRect().width / 5);
      const step = w + REEL_GAP;

      col.classList.remove('stopped');
      col.classList.add('spinning');

      strip.style.transition = 'none';
      strip.style.transform = 'translateY(' + (-(STRIP_LEN - 3) * step).toFixed(2) + 'px)';
      void strip.offsetHeight;
      strips.push(strip);
    }

    /* --- Запуск: ленты едут вниз и плавно тормозят --- */
    for (let reel = 0; reel < 5; reel++) {
      const dur = STOP_BASE + reel * STOP_STEP;
      strips[reel].style.transition = 'transform ' + dur + 'ms cubic-bezier(.22,.61,.36,1)';
      strips[reel].style.transform = 'translateY(0)';
    }

    if (window.Sound) Sound.spin();
    App.haptic('medium');

    /* --- Остановка по одному барабану --- */
    let elapsed = 0;
    for (let reel = 0; reel < 5; reel++) {
      const stopAt = STOP_BASE + reel * STOP_STEP;
      await wait(stopAt - elapsed);
      elapsed = stopAt;

      const col = reelsEl.children[reel];
      col.classList.remove('spinning');
      col.classList.add('stopped');
      // страховка: гарантируем конечное положение даже при троттлинге анимаций
      const strip = strips[reel];
      strip.style.transition = 'none';
      strip.style.transform = 'translateY(0)';
      if (window.Sound) Sound.reelStop(reel);
      App.haptic('light');

      for (let row = 0; row < 3; row++) {
        const cell = cellEls[reel][row];
        cell.classList.remove('pop');
        void cell.offsetWidth;
        cell.classList.add('pop');
      }
    }

    if (slotMachineEl) slotMachineEl.classList.remove('spinning');
    await wait(120);

    const res = evaluate(grid, stake);
    let win = res.totalWin;
    if (isFree && win > 0) win *= 2; // множитель фриспинов

    highlight(res.wins, res.scatters);
    drawPaylines(res.wins);

    if (res.scatters >= 3) {
      if (freeSpins === 0) freeBet = stake;
      freeSpins += 10;
      updateFreeBanner();
      if (window.Sound) Sound.scatter();
      App.haptic('success');
    }

    if (win > 0) {
      App.addBalance(win);
      setWinMeter(win, true);
      setStatus('ВЫИГРЫШ: ' + App.fmt(win) + ' 🪙', true);
      App.haptic('success');

      if (slotMachineEl) {
        slotMachineEl.classList.remove('win-glow');
        void slotMachineEl.offsetWidth;
        slotMachineEl.classList.add('win-glow');
      }

      const ratio = win / stake;
      const level = ratio >= 10 ? 'big' : 'normal';
      if (window.Sound) Sound.win(level);

      App.spawnCoins(slotMachineEl, Math.min(28, 10 + Math.round(ratio * 2)));
      App.floatWin('+' + App.fmt(win), slotMachineEl);

      if (ratio >= 50) {
        App.bigWin('LEGENDARY WIN', win);
        App.shake(slotMachineEl);
      } else if (ratio >= 25) {
        App.bigWin('MEGA WIN', win);
        App.shake(slotMachineEl);
      } else if (ratio >= 10) {
        App.bigWin('BIG WIN', win);
      }
    } else {
      setStatus('Без выигрыша. Попробуй ещё!', false);
    }

    if (res.scatters >= 3) {
      App.toast('🪲 Скарабей! +10 фриспинов (×2)');
    }

    spinning = false;
    if (spinBtn) spinBtn.disabled = false;
    if (bet) bet.lock(false);
    return true;
  }

  /* ---------- Авто-прокрутка ---------- */
  function slotsActive() {
    const el = document.getElementById('screen-slots');
    return !!el && el.classList.contains('active');
  }

  function setAutoUI() {
    if (!autoBtn) return;
    autoBtn.classList.toggle('on', autoOn);
    autoBtn.textContent = autoOn ? '⏹ СТОП АВТО' : '♾️ АВТО-ПРОКРУТКА';
    autoBtn.setAttribute('aria-pressed', autoOn ? 'true' : 'false');
  }

  function stopAuto(msg) {
    autoOn = false;
    autoToken++;
    setAutoUI();
    if (msg) App.toast(msg);
  }

  async function autoLoop(token) {
    while (autoOn && token === autoToken) {
      if (!slotsActive()) { stopAuto(); return; }
      if (window.Cloud && Cloud.isBanned && Cloud.isBanned()) { stopAuto(); return; }

      const stake = freeSpins > 0 ? 0 : bet.value;
      if (stake > 0 && App.State.balance < stake) {
        stopAuto('Недостаточно тугриков — авто остановлено');
        return;
      }

      const ok = await spin();
      if (!ok) {
        stopAuto('Недостаточно тугриков — авто остановлено');
        return;
      }
      if (!autoOn || token !== autoToken) return;
      await wait(480);
    }
  }

  function toggleAuto() {
    if (autoOn) { stopAuto('Авто-прокрутка остановлена'); return; }
    if (!slotsActive()) { App.toast('Сначала открой слоты'); return; }
    if (window.Cloud && Cloud.isBanned && Cloud.isBanned()) return;

    autoOn = true;
    autoToken++;
    setAutoUI();
    App.haptic('medium');
    autoLoop(autoToken);
  }

  /* ---------- Таблица выплат ---------- */
  function buildPaytable() {
    if (!paytableEl) return;
    const rows = [];
    for (const key of ORDER) {
      const s = SYMBOLS[key];
      const p = s.pay;
      const line = key === 'scatter'
        ? `<div class="pt-row"><span>${s.label} ${s.name}</span><span>3/${p[3]}× · 4/${p[4]}× · 5/${p[5]}× ставки</span></div>`
        : `<div class="pt-row"><span>${s.label} ${s.name}</span><span>${p[3]} / ${p[4]} / ${p[5]}×</span></div>`;
      rows.push(line);
    }
    paytableEl.innerHTML = rows.join('');
  }

  /* ---------- Init ---------- */
  function init() {
    reelsEl = $('reels');
    reelsFrameEl = $('reelsFrame');
    paylinesEl = $('paylines');
    slotMachineEl = $('slotMachine');
    slotWinEl = $('slotWinValue');
    slotBetEl = $('slotBetLabel');
    spinBtn = $('spinBtn');
    statusEl = $('slotStatus');
    bannerEl = $('freeBanner');
    freeLeftEl = $('freeLeft');
    paytableEl = $('paytableList');
    autoBtn = $('autoSpinBtn');
    if (!reelsEl || !spinBtn) return;

    bet = App.initBetControl($('slotsBet'), {
      initial: 100,
      onChange: (v) => updateBetLabel(v),
    });
    updateBetLabel(bet.value);
    buildReels();
    grid = makeGrid();
    fillAllStrips(grid);
    buildPaytable();
    updateFreeBanner();
    setWinMeter(0, false);

    spinBtn.addEventListener('click', () => {
      if (autoOn) { stopAuto('Авто-прокрутка остановлена'); return; }
      spin();
    });
    if (autoBtn) autoBtn.addEventListener('click', toggleAuto);

    // пересчёт размеров, когда экран слотов становится видимым / меняется окно
    window.addEventListener('resize', sizeReels);
    window.addEventListener('screenchange', (e) => {
      if (e && e.detail && e.detail.screen !== 'slots' && autoOn) stopAuto();
      requestAnimationFrame(sizeReels);
      setTimeout(sizeReels, 80);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && autoOn) stopAuto();
    });
    if (window.ResizeObserver) {
      try { new ResizeObserver(sizeReels).observe(reelsEl); } catch (e) {}
    }
  }

  window.SlotsGame = { init, spin, stopAuto, evaluate, makeGrid, SYMBOLS, LINES };
})();
