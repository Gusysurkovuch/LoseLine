'use strict';

/* ================= БЛЭКДЖЕК ================= */
(function () {

  const SUITS = [
    { s: '♠', red: false },
    { s: '♥', red: true },
    { s: '♦', red: true },
    { s: '♣', red: false },
  ];
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const DECKS = 6;
  const RESHUFFLE_AT = 0.25;

  let shoe = [];
  let player = [];
  let dealer = [];
  let activeBet = 0;
  let phase = 'idle'; // idle | player | dealer | done
  let doubled = false;

  const $ = (id) => document.getElementById(id);
  let dealerCardsEl, playerCardsEl, dealerScoreEl, playerScoreEl, statusEl, tableEl;
  let betRow, playRow, dealBtn, hitBtn, standBtn, doubleBtn;
  let bet = null;

  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  /* ---------- Колода ---------- */
  function buildShoe() {
    shoe = [];
    for (let d = 0; d < DECKS; d++) {
      for (const suit of SUITS) {
        for (const rank of RANKS) {
          shoe.push({ rank, suit: suit.s, red: suit.red });
        }
      }
    }
    // Фишер–Йетс
    for (let i = shoe.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
    }
  }

  function draw() {
    if (shoe.length < Math.floor(DECKS * 52 * RESHUFFLE_AT)) buildShoe();
    return shoe.pop();
  }

  /* ---------- Очки ---------- */
  function handValue(cards) {
    let total = 0;
    let aces = 0;
    for (const c of cards) {
      if (c.rank === 'A') { aces++; total += 11; }
      else if (c.rank === 'J' || c.rank === 'Q' || c.rank === 'K' || c.rank === '10') total += 10;
      else total += Number(c.rank);
    }
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    return total;
  }

  function isBlackjack(cards) {
    return cards.length === 2 && handValue(cards) === 21;
  }

  /* ---------- Отрисовка ---------- */
  function cardEl(card, hidden) {
    const el = document.createElement('div');
    el.className = 'card' + (hidden ? ' back' : '') + (!hidden && card.red ? ' red' : '');
    if (!hidden && card) {
      el.innerHTML = `<span class="rank">${card.rank}</span><span class="suit">${card.suit}</span>`;
    }
    return el;
  }

  function renderHands() {
    if (dealerCardsEl) {
      dealerCardsEl.innerHTML = '';
      dealer.forEach((c, i) => {
        const hidden = (phase === 'player') && i === 1;
        dealerCardsEl.appendChild(cardEl(c, hidden));
      });
    }
    if (playerCardsEl) {
      playerCardsEl.innerHTML = '';
      player.forEach(c => playerCardsEl.appendChild(cardEl(c, false)));
    }

    if (playerScoreEl) {
      playerScoreEl.textContent = player.length ? String(handValue(player)) : '';
    }
    if (dealerScoreEl) {
      if (!dealer.length) dealerScoreEl.textContent = '';
      else if (phase === 'player') dealerScoreEl.textContent = String(handValue([dealer[0]])) + '+';
      else dealerScoreEl.textContent = String(handValue(dealer));
    }
  }

  function setStatus(text, cls) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = 'table-center' + (cls ? ' ' + cls : '');
  }

  function setPhase(p) {
    phase = p;
    const playing = p === 'player';
    if (playRow) playRow.classList.toggle('hidden', !playing);
    if (betRow) betRow.classList.toggle('hidden', playing);
    if (hitBtn) hitBtn.disabled = !playing;
    if (standBtn) standBtn.disabled = !playing;
    if (doubleBtn) doubleBtn.disabled = !playing || player.length !== 2 || App.State.balance < activeBet;
  }

  /* ---------- Игра ---------- */
  async function deal() {
    if (phase === 'player' || phase === 'dealer') return;
    const stake = bet.value;
    if (!App.takeBet(stake)) return;

    activeBet = stake;
    doubled = false;
    player = [];
    dealer = [];
    setPhase('player');
    setStatus('Раздача…');
    App.haptic('medium');

    player.push(draw());
    dealer.push(draw());
    renderHands();
    if (window.Sound) Sound.card();
    await wait(160);
    player.push(draw());
    dealer.push(draw());
    renderHands();
    if (window.Sound) Sound.card();
    await wait(220);

    const pBJ = isBlackjack(player);
    const dBJ = isBlackjack(dealer);

    if (pBJ || dBJ) {
      phase = 'dealer';
      renderHands();
      await wait(420);
      if (pBJ && dBJ) {
        App.addBalance(activeBet);
        setStatus('Блэкджек у обоих — ничья. Ставка возвращена.', '');
        App.haptic('warning');
        if (window.Sound) Sound.push();
      } else if (pBJ) {
        const payout = Math.floor(activeBet * 2.5);
        App.addBalance(payout);
        setStatus('БЛЭКДЖЕК! Выигрыш ' + App.fmt(payout - activeBet) + ' 🪙', 'win');
        App.spawnCoins(statusEl, 20);
        App.floatWin('+' + App.fmt(payout - activeBet), statusEl);
        App.bigWin('BLACKJACK', payout - activeBet);
        App.haptic('success');
        if (window.Sound) Sound.win('big');
      } else {
        setStatus('Блэкджек у дилера — ты проиграл ' + App.fmt(activeBet) + ' 🪙', 'lose');
        App.shake(tableEl);
        App.haptic('error');
        if (window.Sound) Sound.lose();
      }
      finish();
      return;
    }

    setStatus('Твой ход: «Ещё», «Хватит» или «Удвоить»');
  }

  async function hit() {
    if (phase !== 'player') return;
    player.push(draw());
    renderHands();
    if (window.Sound) Sound.card();
    if (doubleBtn) doubleBtn.disabled = true; // удвоение только на первых двух картах
    App.haptic('light');

    if (handValue(player) > 21) {
      setStatus('Перебор! Проигрыш ' + App.fmt(activeBet) + ' 🪙', 'lose');
      App.shake(tableEl);
      App.haptic('error');
      if (window.Sound) Sound.lose();
      phase = 'done';
      renderHands();
      finish();
      return;
    }
    if (handValue(player) === 21) {
      await stand();
      return;
    }
  }

  async function stand() {
    if (phase !== 'player') return;
    setPhase('dealer');
    setStatus('Ход дилера…');
    renderHands();
    await wait(320);

    while (handValue(dealer) < 17) {
      dealer.push(draw());
      renderHands();
      if (window.Sound) Sound.card();
      App.haptic('light');
      await wait(360);
    }

    await settle();
  }

  async function double() {
    if (phase !== 'player' || player.length !== 2) return;
    if (!App.takeBet(activeBet)) return;
    activeBet *= 2;
    doubled = true;
    App.haptic('medium');
    player.push(draw());
    renderHands();
    if (window.Sound) Sound.card();
    await wait(240);

    if (handValue(player) > 21) {
      setStatus('Перебор! Проигрыш ' + App.fmt(activeBet) + ' 🪙', 'lose');
      App.shake(tableEl);
      App.haptic('error');
      if (window.Sound) Sound.lose();
      phase = 'done';
      renderHands();
      finish();
      return;
    }
    await stand();
  }

  async function settle() {
    const p = handValue(player);
    const d = handValue(dealer);
    let text = '';
    let cls = '';

    if (d > 21) {
      App.addBalance(activeBet * 2);
      text = 'Дилер перебрал (' + d + '). Выигрыш ' + App.fmt(activeBet) + ' 🪙';
      cls = 'win';
      App.haptic('success');
    } else if (p > d) {
      App.addBalance(activeBet * 2);
      text = 'Ты выиграл! ' + p + ' против ' + d + ' · +' + App.fmt(activeBet) + ' 🪙';
      cls = 'win';
      App.haptic('success');
    } else if (p === d) {
      App.addBalance(activeBet);
      text = 'Ничья (' + p + ':' + d + '). Ставка возвращена.';
      App.haptic('warning');
      if (window.Sound) Sound.push();
    } else {
      text = 'Дилер выиграл (' + d + ' против ' + p + '). −' + App.fmt(activeBet) + ' 🪙';
      cls = 'lose';
      App.haptic('error');
    }

    setStatus(text, cls);
    if (cls === 'win') {
      App.spawnCoins(statusEl, 12);
      App.floatWin('+' + App.fmt(activeBet), statusEl);
      if (window.Sound) Sound.win(activeBet >= 500 ? 'big' : 'normal');
      if (activeBet >= 500) App.bigWin('BIG WIN', activeBet);
    } else if (cls === 'lose') {
      App.shake(tableEl);
      if (window.Sound) Sound.lose();
    }
    finish();
  }

  function finish() {
    setPhase('idle');
    if (bet) bet.refresh();
    // даём кнопкам Раздать снова активность
    if (dealBtn) dealBtn.disabled = false;
  }

  /* ---------- Init ---------- */
  function init() {
    dealerCardsEl = $('dealerCards');
    playerCardsEl = $('playerCards');
    dealerScoreEl = $('dealerScore');
    playerScoreEl = $('playerScore');
    statusEl = $('bjStatus');
    tableEl = document.querySelector('.table');
    betRow = $('bjBetRow');
    playRow = $('bjPlayRow');
    dealBtn = $('dealBtn');
    hitBtn = $('hitBtn');
    standBtn = $('standBtn');
    doubleBtn = $('doubleBtn');
    if (!dealerCardsEl) return;

    bet = App.initBetControl($('bjBet'), { initial: 100 });
    buildShoe();
    setPhase('idle');
    setStatus('Сделай ставку и нажми «Раздать»');

    if (dealBtn) dealBtn.addEventListener('click', deal);
    if (hitBtn) hitBtn.addEventListener('click', hit);
    if (standBtn) standBtn.addEventListener('click', stand);
    if (doubleBtn) doubleBtn.addEventListener('click', double);
  }

  window.BlackjackGame = { init, handValue, isBlackjack };
})();
