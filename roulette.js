'use strict';

/* ================= РУЛЕТКА ================= */
(function () {

  // Европейская рулетка — порядок чисел на колесе
  const WHEEL = [
    0, 32, 15, 19, 4, 21, 2, 25, 17, 34,
    6, 27, 13, 36, 11, 30, 8, 23, 10, 5,
    24, 16, 33, 1, 20, 14, 31, 9, 22, 18,
    29, 7, 28, 12, 35, 3, 26,
  ];

  const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

  const BET_TYPES = {
    red:    { label: 'КРАСНОЕ', mult: 2 },
    black:  { label: 'ЧЁРНОЕ', mult: 2 },
    even:   { label: 'ЧЁТ', mult: 2 },
    odd:    { label: 'НЕЧЁТ', mult: 2 },
    low:    { label: '1–18', mult: 2 },
    high:   { label: '19–36', mult: 2 },
    zero:   { label: 'ЗЕРО · 35:1', mult: 36 },
  };

  const CHIPS = [10, 50, 100, 500, 1000];

  let selectedChip = 50;
  let stakes = {};
  let rotation = 0;
  let spinning = false;
  let betCtl = null;

  /** Лёгкое «дыхание» колеса, когда оно не крутится. */
  function startIdle() {
    if (!svgEl || spinning) return;
    svgEl.classList.remove('idle', 'wheel-reverse');
    void svgEl.offsetWidth;
    if (Math.random() < 0.5) svgEl.classList.add('wheel-reverse');
    svgEl.classList.add('idle');
  }

  function stopIdle() {
    if (!svgEl) return;
    svgEl.classList.remove('idle');
  }

  const $ = (id) => document.getElementById(id);
  let svgEl, rotorEl, resultEl, betsEl, chipsEl, totalEl, spinBtn;

  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const isRed = (n) => RED.has(n);
  const colorOf = (n) => n === 0 ? 'green' : (isRed(n) ? 'red' : 'black');

  function polar(r, angleDeg) {
    const a = (angleDeg - 90) * Math.PI / 180;
    return [r * Math.cos(a), r * Math.sin(a)];
  }

  function sectorPath(a1, a2, r) {
    const [x1, y1] = polar(r, a1);
    const [x2, y2] = polar(r, a2);
    const large = (a2 - a1) > 180 ? 1 : 0;
    return `M 0 0 L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
  }

  function buildWheel() {
    if (!svgEl) return;
    const NS = 'http://www.w3.org/2000/svg';
    const step = 360 / WHEEL.length;
    svgEl.innerHTML = '';

    // внешний обод
    const rim = document.createElementNS(NS, 'circle');
    rim.setAttribute('r', '99');
    rim.setAttribute('fill', '#2a2038');
    rim.setAttribute('stroke', '#5a4718');
    rim.setAttribute('stroke-width', '2.5');
    svgEl.appendChild(rim);

    WHEEL.forEach((num, i) => {
      const a1 = i * step;
      const a2 = (i + 1) * step;
      const c = colorOf(num);

      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', sectorPath(a1, a2, 96));
      p.setAttribute('fill', c === 'green' ? '#1c7a4d' : (c === 'red' ? '#b01f38' : '#171422'));
      p.setAttribute('stroke', '#0a0812');
      p.setAttribute('stroke-width', '0.6');
      svgEl.appendChild(p);

      const [tx, ty] = polar(79, a1 + step / 2);
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', tx.toFixed(2));
      t.setAttribute('y', ty.toFixed(2));
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('dominant-baseline', 'central');
      t.setAttribute('font-size', '8.5');
      t.setAttribute('font-weight', '700');
      t.setAttribute('fill', '#fff');
      t.setAttribute('transform', `rotate(${(a1 + step / 2).toFixed(2)} ${tx.toFixed(2)} ${ty.toFixed(2)})`);
      t.textContent = String(num);
      svgEl.appendChild(t);
    });

    const hub = document.createElementNS(NS, 'circle');
    hub.setAttribute('r', '34');
    hub.setAttribute('fill', '#0d0a18');
    hub.setAttribute('stroke', '#3b2f5e');
    hub.setAttribute('stroke-width', '1');
    svgEl.appendChild(hub);
  }

  function buildChips() {
    if (!chipsEl) return;
    chipsEl.innerHTML = '';
    CHIPS.forEach(v => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.dataset.chip = String(v);
      b.textContent = v >= 1000 ? '1К' : String(v);
      chipsEl.appendChild(b);
    });
    highlightChips();
  }

  function highlightChips() {
    if (!chipsEl) return;
    chipsEl.querySelectorAll('.chip').forEach(c => {
      c.classList.toggle('selected', Number(c.dataset.chip) === selectedChip);
    });
  }

  function buildBets() {
    if (!betsEl) return;
    betsEl.innerHTML = '';
    Object.entries(BET_TYPES).forEach(([key, cfg]) => {
      const b = document.createElement('button');
      b.className = 'bet-btn';
      b.dataset.bet = key;
      b.innerHTML = `<span class="stake"></span>${cfg.label}`;
      betsEl.appendChild(b);
    });
    paintStakes();
  }

  function totalStake() {
    return Object.values(stakes).reduce((s, v) => s + v, 0);
  }

  function paintStakes() {
    if (!betsEl) return;
    betsEl.querySelectorAll('.bet-btn').forEach(btn => {
      const key = btn.dataset.bet;
      const v = stakes[key] || 0;
      const st = btn.querySelector('.stake');
      if (st) st.textContent = v > 0 ? String(v) : '';
      btn.classList.toggle('has-stake', v > 0);
    });
    if (totalEl) totalEl.textContent = App.fmt(totalStake());
  }

  function placeBet(key) {
    if (spinning) return;
    const amount = Math.max(App.CONFIG.minBet, Math.round(Number(betCtl ? betCtl.value : selectedChip) || 0));
    if (App.State.balance < amount) { App.toast('Недостаточно тугриков'); return; }
    // не позволяем поставить больше, чем есть на балансе
    if (totalStake() + amount > App.State.balance) { App.toast('Ставка больше баланса'); return; }
    stakes[key] = (stakes[key] || 0) + amount;
    paintStakes();
    if (window.Sound) Sound.coin();
    App.haptic('light');
  }

  function betWins(type, n) {
    switch (type) {
      case 'red':   return n !== 0 && isRed(n);
      case 'black': return n !== 0 && !isRed(n);
      case 'zero':  return n === 0;
      case 'even':  return n !== 0 && n % 2 === 0;
      case 'odd':   return n !== 0 && n % 2 === 1;
      case 'low':   return n >= 1 && n <= 18;
      case 'high':  return n >= 19 && n <= 36;
      default:      return false;
    }
  }

  function spinToIndex(i) {
    if (!rotorEl) return;
    const step = 360 / WHEEL.length;
    const targetMod = ((-(i * step + step / 2)) % 360 + 360) % 360;
    const currentMod = ((rotation % 360) + 360) % 360;
    let delta = targetMod - currentMod;
    if (delta < 0) delta += 360;
    rotation += 360 * 6 + delta;
    rotorEl.style.transform = `rotate(${rotation}deg)`;
  }

  function setResult(n) {
    if (!resultEl) return;
    resultEl.textContent = String(n);
    resultEl.className = 'wheel-result ' + colorOf(n);
  }

  async function spin() {
    if (spinning) return;
    const total = totalStake();
    if (total <= 0) { App.toast('Сначала сделай ставку'); return; }
    if (!App.takeBet(total)) return;

    spinning = true;
    stopIdle();
    if (spinBtn) spinBtn.disabled = true;
    if (betCtl) betCtl.lock(true);
    setResult('…');
    if (resultEl) resultEl.className = 'wheel-result';
    App.haptic('medium');

    const idx = Math.floor(Math.random() * WHEEL.length);
    const number = WHEEL[idx];
    spinToIndex(idx);
    if (window.Sound) Sound.rouletteSpin(4.4);

    await wait(4400);

    setResult(number);
    const color = colorOf(number);
    if (resultEl) {
      resultEl.classList.remove('pop');
      void resultEl.offsetWidth;
      resultEl.classList.add('pop');
    }

    let win = 0;
    const wonTypes = [];
    Object.entries(stakes).forEach(([type, amount]) => {
      if (betWins(type, number)) {
        win += amount * BET_TYPES[type].mult;
        wonTypes.push(type);
      }
    });

    if (win > 0) {
      App.addBalance(win);
      App.spawnCoins(resultEl, Math.min(24, 10 + Math.round(win / Math.max(1, total) * 2)));
      App.floatWin('+' + App.fmt(win), resultEl);
      App.toast('Выпало ' + number + ' (' + (color === 'red' ? 'красное' : color === 'black' ? 'чёрное' : 'зеро') + ') · выигрыш ' + App.fmt(win) + ' 🪙');
      App.haptic('success');
      if (window.Sound) Sound.win(win >= total * 10 ? 'big' : 'normal');
      if (win >= total * 10) App.bigWin('BIG WIN', win);
    } else {
      const wrap = resultEl ? resultEl.closest('.wheel-wrap') : null;
      App.shake(wrap);
      App.toast('Выпало ' + number + ' · ставка не сыграла');
      App.haptic('error');
      if (window.Sound) Sound.lose();
    }

    stakes = {};
    paintStakes();
    spinning = false;
    if (spinBtn) spinBtn.disabled = false;
    if (betCtl) betCtl.lock(false);
    startIdle();
  }

  function init() {
    svgEl = $('wheelSvg');
    rotorEl = $('wheelRotor');
    resultEl = $('wheelResult');
    betsEl = $('betsGrid');
    chipsEl = $('chips');
    totalEl = $('rouletteTotal');
    spinBtn = $('spinRoulette');
    if (!svgEl || !betsEl) return;

    betCtl = App.initBetControl($('rouletteBet'), {
      initial: 50,
      onChange: (v) => { selectedChip = v; highlightChips(); },
    });
    selectedChip = betCtl.value;

    buildWheel();
    buildChips();
    buildBets();

    chipsEl.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip || spinning) return;
      betCtl.set(Number(chip.dataset.chip));
      selectedChip = betCtl.value;
      highlightChips();
      App.haptic('light');
    });

    betsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.bet-btn');
      if (!btn) return;
      placeBet(btn.dataset.bet);
    });

    const clearBtn = $('clearBets');
    if (clearBtn) clearBtn.addEventListener('click', () => {
      if (spinning) return;
      stakes = {};
      paintStakes();
    });

    if (spinBtn) spinBtn.addEventListener('click', spin);

    setResult('—');
    if (resultEl) resultEl.className = 'wheel-result';
    startIdle();
  }

  window.RouletteGame = { init, spin, WHEEL, isRed, colorOf };
})();
