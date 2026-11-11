'use strict';

/* ================= ПОКЕР: ТЕХАССКИЙ ХОЛДЕМ ================= */
/*
 * Хедз-ап против дилера.
 *
 * • Игрок ставит большой блайнд (выбранная сумма), дилер — малый блайнд.
 * • Каждому раздаются 2 закрытые карты, на стол выкладываются 5 общих:
 *   флоп (3), тёрн (1), ривер (1).
 * • Четыре круга торговли: префлоп, флоп, тёрн, ривер. Действия:
 *   чек, колл, рейз, фолд, олл-ин.
 * • Верхнего лимита ставки нет — рейз ограничен только балансом игрока.
 * • Дилерский стек виртуально равен стартовому балансу игрока, поэтому
 *   дилер всегда может уравнять ставку и сайд-потов не бывает.
 * • Побеждает лучшая пятёрка из семи карт (2 своих + 5 общих).
 *
 * Все ставки — только виртуальные тугрики.
 */
(function () {

  const SUITS = [
    { s: '♠', red: false },
    { s: '♥', red: true },
    { s: '♦', red: true },
    { s: '♣', red: false },
  ];
  const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const RANK_VALUE = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
    '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14,
  };

  const STREET_NAME = {
    preflop: 'ПРЕФЛОП',
    flop: 'ФЛОП',
    turn: 'ТЁРН',
    river: 'РИВЕР',
  };

  const $ = (id) => document.getElementById(id);

  const S = {
    phase: 'idle',          // idle | betting | done
    street: 'preflop',      // preflop | flop | turn | river
    deck: [],
    playerHole: [],
    dealerHole: [],
    board: [],
    startingBalance: 0,
    bigBlind: 0,
    smallBlind: 0,
    playerStreetBet: 0,
    dealerStreetBet: 0,
    playerCommitted: 0,
    dealerCommitted: 0,
    playerActed: false,
    dealerActed: false,
    lastRaiseSize: 0,
    dealerRevealed: false,
    turn: null,             // player | dealer
    busy: false,
    handNo: 0,
  };

  let bet = null;
  let playerCardsEl, dealerCardsEl, playerHandEl, dealerHandEl, communityEl;
  let potEl, myStackEl, myBetEl, dealerBetEl, statusEl;
  let betRow, playRow, dealBtn, callBtn, foldBtn, allInBtn, raiseBtn, raiseInput, againBtn, tipEl;
  let helpEl, helpBtn, helpClose, helpOk;

  /* ---------- Форматирование ---------- */
  const fmt = (n) => (window.App ? App.fmt(n) : String(n));

  function potSize() {
    return S.playerCommitted + S.dealerCommitted;
  }

  function currentBet() {
    return Math.max(S.playerStreetBet, S.dealerStreetBet);
  }

  function toCallForPlayer() {
    return Math.max(0, S.dealerStreetBet - S.playerStreetBet);
  }

  function playerAvailable() {
    return Math.max(0, Math.floor(Number(window.App ? App.State.balance : 0) || 0));
  }

  function dealerAvailable() {
    return Math.max(0, S.startingBalance - S.dealerCommitted);
  }

  function allIn() {
    return playerAvailable() <= 0 || dealerAvailable() <= 0;
  }

  function haptic(type) {
    if (window.App && App.haptic) App.haptic(type || 'light');
  }

  function sound(name, arg) {
    if (!window.Sound) return;
    try {
      if (typeof Sound[name] === 'function') Sound[name](arg);
    } catch (e) { /* звук не критичен */ }
  }

  /* ---------- Колода ---------- */
  function buildDeck() {
    const cards = [];
    SUITS.forEach((suit) => {
      RANKS.forEach((rank) => {
        cards.push({ rank, suit: suit.s, red: suit.red });
      });
    });
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    return cards;
  }

  function draw() {
    if (!S.deck.length) S.deck = buildDeck();
    return S.deck.pop();
  }

  function dealBoard(count) {
    for (let i = 0; i < count; i++) {
      const card = draw();
      if (card) S.board.push(card);
    }
  }

  /* ---------- Комбинации ---------- */
  function rankValue(rank) {
    return RANK_VALUE[rank] || 0;
  }

  /** Оценка ровно 5 карт. cat: 8 — стрит-флеш … 0 — старшая карта. */
  function evaluate(cards) {
    const ranks = cards.map((c) => rankValue(c.rank)).sort((a, b) => b - a);
    const suits = cards.map((c) => c.suit);
    const flush = suits.every((s) => s === suits[0]);

    const unique = [...new Set(ranks)];
    let straight = false;
    let straightHigh = 0;
    if (unique.length === 5) {
      if (unique[0] - unique[4] === 4) {
        straight = true;
        straightHigh = unique[0];
      } else if (unique[0] === 14 && unique[1] === 5 && unique[2] === 4 &&
                 unique[3] === 3 && unique[4] === 2) {
        straight = true;
        straightHigh = 5; // A-2-3-4-5
      }
    }

    const counts = {};
    ranks.forEach((r) => { counts[r] = (counts[r] || 0) + 1; });
    const groups = Object.keys(counts)
      .map(Number)
      .sort((a, b) => {
        const diff = counts[b] - counts[a];
        return diff || (b - a);
      });
    const sizes = groups.map((r) => counts[r]);

    if (straight && flush) return { cat: 8, name: 'Стрит-флеш', tie: [straightHigh] };
    if (sizes[0] === 4) return { cat: 7, name: 'Каре', tie: [groups[0], groups[1]] };
    if (sizes[0] === 3 && sizes[1] === 2) return { cat: 6, name: 'Фулл-хаус', tie: [groups[0], groups[1]] };
    if (flush) return { cat: 5, name: 'Флеш', tie: ranks };
    if (straight) return { cat: 4, name: 'Стрит', tie: [straightHigh] };
    if (sizes[0] === 3) return { cat: 3, name: 'Сет', tie: [groups[0], ...groups.slice(1)] };
    if (sizes[0] === 2 && sizes[1] === 2) {
      return { cat: 2, name: 'Две пары', tie: [groups[0], groups[1], groups[2]] };
    }
    if (sizes[0] === 2) return { cat: 1, name: 'Пара', tie: [groups[0], ...groups.slice(1)] };
    return { cat: 0, name: 'Старшая карта', tie: ranks };
  }

  function compareHands(a, b) {
    if (a.cat !== b.cat) return a.cat - b.cat;
    const len = Math.max(a.tie.length, b.tie.length);
    for (let i = 0; i < len; i++) {
      const x = a.tie[i] || 0;
      const y = b.tie[i] || 0;
      if (x !== y) return x - y;
    }
    return 0;
  }

  /** Лучшая пятёрка из 5–7 карт (обычно 7: 2 своих + 5 общих). */
  function bestOf(cards) {
    if (!cards || !cards.length) return { cat: -1, name: '', tie: [] };
    if (cards.length <= 5) return evaluate(cards);
    let best = null;
    const n = cards.length;
    for (let a = 0; a < n - 4; a++) {
      for (let b = a + 1; b < n - 3; b++) {
        for (let c = b + 1; c < n - 2; c++) {
          for (let d = c + 1; d < n - 1; d++) {
            for (let e = d + 1; e < n; e++) {
              const cand = evaluate([cards[a], cards[b], cards[c], cards[d], cards[e]]);
              if (!best || compareHands(cand, best) > 0) best = cand;
            }
          }
        }
      }
    }
    return best;
  }

  /* ---------- Оценка силы для дилера ---------- */
  function preflopStrength(hole) {
    if (!hole || hole.length < 2) return 0.3;
    const v = hole.map((c) => rankValue(c.rank)).sort((a, b) => b - a);
    const suited = hole[0].suit === hole[1].suit;
    const gap = Math.abs(v[0] - v[1]);
    let s;
    if (v[0] === v[1]) {
      s = 0.45 + v[0] / 40;                 // пара: 0.50 … 0.80
    } else {
      s = (v[0] + v[1]) / 40;               // 0.10 … 0.70
      if (suited) s += 0.06;
      if (gap === 1) s += 0.05;
      else if (gap === 2) s += 0.02;
      if (v[0] >= 13 && v[1] >= 10) s += 0.08;
    }
    return Math.max(0.05, Math.min(0.95, s));
  }

  function madeStrength(hole, board) {
    const info = bestOf(hole.concat(board));
    const base = [0.08, 0.22, 0.38, 0.52, 0.63, 0.72, 0.82, 0.90, 0.97][info.cat] || 0.1;
    const top = (info.tie && info.tie[0]) ? info.tie[0] : 0;
    return Math.min(0.99, base + top / 300);
  }

  /* ---------- Отрисовка ---------- */
  function cardEl(card, hidden) {
    const el = document.createElement('div');
    el.className = 'card' + (hidden ? ' back' : '') + (!hidden && card && card.red ? ' red' : '');
    if (!hidden && card) {
      const rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = card.rank;
      const suit = document.createElement('span');
      suit.className = 'suit';
      suit.textContent = card.suit;
      el.appendChild(rank);
      el.appendChild(suit);
    }
    return el;
  }

  function fillCards(container, cards, hidden) {
    if (!container) return;
    container.innerHTML = '';
    (cards || []).forEach((card) => container.appendChild(cardEl(card, hidden)));
  }

  function handLabel(hole, board, revealed) {
    if (!hole || hole.length < 2) return '';
    if (revealed === false) return '';
    const set = board && board.length >= 3 ? hole.concat(board) : hole;
    if (set.length < 5) return '—';
    return bestOf(set).name;
  }

  function raiseBounds() {
    const avail = playerAvailable();
    const current = currentBet();
    const maxTo = S.playerStreetBet + avail;
    const minTo = Math.min(maxTo, current + Math.max(S.bigBlind, S.lastRaiseSize));
    return { avail, current, maxTo, minTo };
  }

  function render() {
    fillCards(dealerCardsEl, S.dealerHole, !S.dealerRevealed);
    fillCards(playerCardsEl, S.playerHole, false);
    fillCards(communityEl, S.board, false);

    if (playerHandEl) playerHandEl.textContent = handLabel(S.playerHole, S.board, true);
    if (dealerHandEl) dealerHandEl.textContent = handLabel(S.dealerHole, S.board, S.dealerRevealed);

    if (potEl) potEl.textContent = fmt(S.phase === 'done' ? 0 : potSize()) + ' 🪙';
    if (myStackEl) myStackEl.textContent = fmt(playerAvailable());
    if (myBetEl) myBetEl.textContent = fmt(S.phase === 'done' ? 0 : S.playerStreetBet);
    if (dealerBetEl) dealerBetEl.textContent = fmt(S.phase === 'done' ? 0 : S.dealerStreetBet);

    if (callBtn) {
      const need = toCallForPlayer();
      if (need <= 0) callBtn.textContent = 'ЧЕК';
      else callBtn.textContent = 'КОЛЛ ' + fmt(Math.min(need, playerAvailable())) + ' 🪙';
    }

    if (raiseBtn) {
      const b = raiseBounds();
      raiseBtn.disabled = S.phase !== 'betting' || S.turn !== 'player' || S.busy ||
        b.maxTo <= b.current;
    }
  }

  function setStatus(text, cls) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = 'table-center' + (cls ? ' ' + cls : '');
  }

  function setStage(stage) {
    if (betRow) betRow.classList.toggle('hidden', stage !== 'idle');
    if (playRow) playRow.classList.toggle('hidden', stage !== 'betting');
    if (againBtn) againBtn.classList.toggle('hidden', stage !== 'done');
  }

  function setButtonsEnabled(on) {
    [callBtn, foldBtn, allInBtn, raiseBtn, raiseInput].forEach((el) => {
      if (el) el.disabled = !on;
    });
    if (on) render();
  }

  function prepareRaiseInput() {
    if (!raiseInput) return;
    const b = raiseBounds();
    const start = Math.max(S.bigBlind, Math.min(b.maxTo, b.minTo));
    raiseInput.value = String(Math.max(0, start));
  }

  function paintTurnStatus() {
    if (S.phase !== 'betting') return;
    const name = STREET_NAME[S.street] || '';
    if (S.turn === 'player') {
      const need = toCallForPlayer();
      const text = need > 0
        ? name + ' · нужно уравнять ' + fmt(Math.min(need, playerAvailable())) + ' 🪙 · твой ход'
        : name + ' · ставок нет, можно чек · твой ход';
      setStatus(text);
    } else if (S.turn === 'dealer') {
      setStatus(name + ' · дилер думает…');
    }
  }

  function updateTip(text) {
    if (tipEl) tipEl.textContent = text;
  }

  /* ---------- Ставки игрока ---------- */
  function commitPlayer(amount) {
    amount = Math.floor(Number(amount) || 0);
    if (amount <= 0) return true;
    if (amount > playerAvailable()) return false;
    App.addBalance(-amount);
    S.playerCommitted += amount;
    S.playerStreetBet += amount;
    return true;
  }

  function playerCanAct() {
    return S.phase === 'betting' && S.turn === 'player' && !S.busy;
  }

  function playerCheckCall() {
    if (!playerCanAct()) return;
    const need = toCallForPlayer();
    const amount = Math.min(need, playerAvailable());
    if (amount > 0 && !commitPlayer(amount)) {
      App.toast('Недостаточно тугриков');
      return;
    }
    S.playerActed = true;
    sound('ui');
    haptic('light');
    afterPlayer();
  }

  function playerRaise(to) {
    if (!playerCanAct()) return;
    const avail = playerAvailable();
    if (avail <= 0) { playerCheckCall(); return; }

    const current = currentBet();
    const minTo = current + Math.max(S.bigBlind, S.lastRaiseSize);
    const maxTo = S.playerStreetBet + avail;

    let target = Math.floor(Number(to) || 0);
    if (!isFinite(target) || target <= 0) {
      App.toast('Введи сумму рейза');
      return;
    }
    if (target > maxTo) target = maxTo;
    const isAllIn = target >= maxTo;

    if (target <= current) { playerCheckCall(); return; }
    if (!isAllIn && target < minTo) {
      App.toast('Минимальный рейз — до ' + fmt(minTo) + ' 🪙');
      return;
    }

    const amount = target - S.playerStreetBet;
    if (amount <= 0) { playerCheckCall(); return; }
    if (!commitPlayer(amount)) {
      App.toast('Недостаточно тугриков');
      return;
    }

    S.lastRaiseSize = Math.max(S.bigBlind, target - current);
    S.playerActed = true;
    S.dealerActed = false;
    sound('coin');
    haptic('light');
    afterPlayer();
  }

  function playerAllIn() {
    if (!playerCanAct()) return;
    const avail = playerAvailable();
    if (avail <= 0) { playerCheckCall(); return; }
    playerRaise(S.playerStreetBet + avail);
  }

  function playerFold() {
    if (!playerCanAct()) return;
    S.playerActed = true;
    S.busy = true;
    setButtonsEnabled(false);
    winByFold('player');
  }

  function afterPlayer() {
    if (S.phase !== 'betting') return;
    render();
    if (roundDone()) {
      endRound();
      return;
    }
    S.turn = 'dealer';
    S.busy = true;
    setButtonsEnabled(false);
    paintTurnStatus();
    scheduleDealer();
  }

  /* ---------- Дилер ---------- */
  function roundDone() {
    return S.playerStreetBet === S.dealerStreetBet && S.playerActed && S.dealerActed;
  }

  function dealerDecide() {
    const toCall = Math.max(0, S.playerStreetBet - S.dealerStreetBet);
    const pot = potSize();
    const avail = dealerAvailable();
    const current = currentBet();
    const playerCap = S.playerStreetBet + playerAvailable();
    const maxTarget = Math.max(current, Math.min(S.dealerStreetBet + avail, playerCap));
    const preflop = S.street === 'preflop' && S.board.length === 0;
    const strength = preflop ? preflopStrength(S.dealerHole) : madeStrength(S.dealerHole, S.board);
    const roll = Math.random();

    if (avail <= 0) return { type: toCall > 0 ? 'call' : 'check' };

    if (toCall > 0) {
      const cheap = toCall <= Math.max(S.bigBlind, Math.round(pot * 0.22));

      if (preflop) {
        if (strength < 0.2 && roll < 0.16 && toCall >= S.bigBlind) return { type: 'fold' };
        if (strength > 0.7 && roll < 0.55) {
          const target = Math.min(maxTarget,
            S.playerStreetBet + Math.max(S.bigBlind, Math.round(pot * 0.8)));
          if (target > current) return { type: 'raise', to: target };
        }
        return { type: 'call' };
      }

      if (!cheap && strength < 0.3 && roll < 0.72) return { type: 'fold' };
      if (!cheap && strength < 0.45 && roll < 0.3) return { type: 'fold' };
      if (strength > 0.78 && roll < 0.6) {
        const target = Math.min(maxTarget,
          S.playerStreetBet + Math.max(S.bigBlind, Math.round(pot * 0.9)));
        if (target > current) return { type: 'raise', to: target };
      }
      return { type: 'call' };
    }

    // Ставок нет: дилер может чекнуть или поставить.
    if (strength >= 0.7 && roll < 0.68) {
      const target = Math.min(maxTarget, Math.max(S.bigBlind, Math.round(pot * 0.65)));
      if (target > 0) return { type: 'bet', to: target };
    }
    if (strength >= 0.42 && roll < 0.26) {
      const target = Math.min(maxTarget, Math.max(S.bigBlind, Math.round(pot * 0.45)));
      if (target > 0) return { type: 'bet', to: target };
    }
    if (roll > 0.93 && pot >= S.bigBlind * 2) {
      const target = Math.min(maxTarget, Math.max(S.bigBlind, Math.round(pot * 0.5)));
      if (target > 0) return { type: 'bet', to: target };
    }
    return { type: 'check' };
  }

  function scheduleDealer() {
    if (S.phase !== 'betting') return;
    S.busy = true;
    setButtonsEnabled(false);
    paintTurnStatus();
    setTimeout(() => {
      if (S.phase !== 'betting' || S.turn !== 'dealer') return;
      dealerAct();
    }, 600 + Math.random() * 500);
  }

  function dealerAct() {
    if (S.phase !== 'betting') return;

    const action = dealerDecide();
    const toCall = Math.max(0, S.playerStreetBet - S.dealerStreetBet);
    const avail = dealerAvailable();

    if (action.type === 'fold') {
      S.dealerActed = true;
      S.busy = false;
      winByFold('dealer');
      return;
    }

    if (action.type === 'check') {
      S.dealerActed = true;
      S.busy = false;
      afterDealer();
      return;
    }

    if (action.type === 'call') {
      const amount = Math.min(toCall, avail);
      S.dealerCommitted += amount;
      S.dealerStreetBet += amount;
      S.dealerActed = true;
      S.busy = false;
      afterDealer();
      return;
    }

    // bet / raise
    const current = currentBet();
    const playerCap = S.playerStreetBet + playerAvailable();
    const cap = Math.max(current, Math.min(S.dealerStreetBet + avail, playerCap));
    let target = Math.min(Math.floor(Number(action.to) || 0), cap);

    if (target <= current) {
      const amount = Math.min(toCall, avail);
      S.dealerCommitted += amount;
      S.dealerStreetBet += amount;
      S.dealerActed = true;
      S.busy = false;
      afterDealer();
      return;
    }

    const amount = target - S.dealerStreetBet;
    if (amount <= 0) {
      S.dealerActed = true;
      S.busy = false;
      afterDealer();
      return;
    }

    S.dealerCommitted += amount;
    S.dealerStreetBet = target;
    S.lastRaiseSize = Math.max(S.bigBlind, target - current);
    S.dealerActed = true;
    S.playerActed = false;
    S.busy = false;
    sound('ui');
    afterDealer();
  }

  function afterDealer() {
    if (S.phase !== 'betting') return;
    render();
    if (roundDone()) {
      endRound();
      return;
    }
    S.turn = 'player';
    S.busy = false;
    setButtonsEnabled(true);
    prepareRaiseInput();
    paintTurnStatus();
    render();
    updateTip('Твой ход: чек, колл, рейз или фолд. Рейз — до всего баланса.');
  }

  /* ---------- Улицы и шоудаун ---------- */
  function endRound() {
    S.busy = true;
    setButtonsEnabled(false);
    render();
    if (allIn()) {
      updateTip('Олл-ин: оставшиеся общие карты открываются автоматически.');
      setTimeout(runout, 500);
      return;
    }
    setTimeout(nextStreet, 450);
  }

  function nextStreet() {
    if (S.phase !== 'betting') return;

    S.playerStreetBet = 0;
    S.dealerStreetBet = 0;
    S.playerActed = false;
    S.dealerActed = false;
    S.lastRaiseSize = S.bigBlind;
    S.busy = false;

    if (S.street === 'river') { showdown(); return; }

    if (S.street === 'preflop') {
      dealBoard(3);
      S.street = 'flop';
    } else if (S.street === 'flop') {
      dealBoard(1);
      S.street = 'turn';
    } else if (S.street === 'turn') {
      dealBoard(1);
      S.street = 'river';
    } else {
      showdown();
      return;
    }

    render();
    S.turn = 'player';
    setButtonsEnabled(true);
    prepareRaiseInput();
    paintTurnStatus();
    updateTip('Новая улица — новый круг торговли. Минимальная ставка — ' +
      fmt(S.bigBlind) + ' 🪙.');
  }

  function runout() {
    if (S.phase !== 'betting') return;
    S.busy = true;
    setButtonsEnabled(false);

    const step = () => {
      if (S.phase !== 'betting') return;
      if (S.board.length >= 5) {
        setTimeout(showdown, 550);
        return;
      }
      dealBoard(S.board.length === 0 ? 3 : 1);
      S.street = S.board.length === 3 ? 'flop' : S.board.length === 4 ? 'turn' : 'river';
      render();
      setStatus('ОЛЛ-ИН · карты открываются…');
      setTimeout(step, 700);
    };

    step();
  }

  function payoutToPlayer(amount, label, cls) {
    if (amount > 0) App.addBalance(amount);
    setStatus(label, cls || '');
    render();
  }

  function showdown() {
    if (S.phase !== 'betting') return;

    S.phase = 'done';
    S.busy = false;
    S.turn = null;
    S.dealerRevealed = true;
    setButtonsEnabled(false);
    setStage('done');

    const p = bestOf(S.playerHole.concat(S.board));
    const d = bestOf(S.dealerHole.concat(S.board));
    const cmp = compareHands(p, d);
    const pot = potSize();
    const committed = S.playerCommitted;

    render();

    if (cmp > 0) {
      const delta = pot - committed;
      payoutToPlayer(pot,
        '✅ Ты выиграл банк! ' + p.name + ' против ' + d.name +
        ' · +' + fmt(delta) + ' 🪙', 'win');
      App.toast('Покер: +' + fmt(delta) + ' 🪙');
      haptic('success');
      sound('win', delta >= 100000 ? 'big' : 'normal');
      if (delta >= 100000 && App.bigWin) App.bigWin('ПОКЕР', delta);
    } else if (cmp < 0) {
      setStatus('❌ Дилер выиграл: ' + d.name + ' против ' + p.name +
        ' · −' + fmt(committed) + ' 🪙', 'lose');
      haptic('error');
      sound('lose');
    } else {
      const half = Math.floor(pot / 2);
      payoutToPlayer(half,
        '🤝 Ничья: ' + p.name + '. Тебе возвращено ' + fmt(half) + ' 🪙', '');
      App.toast('Ничья — банк разделён');
      haptic('warning');
      sound('coin');
    }

    updateTip('Сравни комбинации. «Играть ещё» — новая раздача.');
  }

  function winByFold(folder) {
    S.phase = 'done';
    S.busy = false;
    S.turn = null;
    setButtonsEnabled(false);
    setStage('done');

    const pot = potSize();
    const committed = S.playerCommitted;

    if (folder === 'dealer') {
      S.dealerRevealed = false;
      S.dealerHole = S.dealerHole.slice(); // карты дилера остаются закрытыми
      const delta = pot - committed;
      payoutToPlayer(pot,
        '🏳️ Дилер сбросил. Ты забираешь банк +' + fmt(delta) + ' 🪙', 'win');
      App.toast('Дилер сбросил: +' + fmt(delta) + ' 🪙');
      haptic('success');
      sound('win', delta >= 100000 ? 'big' : 'normal');
      if (delta >= 100000 && App.bigWin) App.bigWin('ПОКЕР', delta);
    } else {
      setStatus('🏳️ Ты сбросил. Дилер забирает банк −' + fmt(committed) + ' 🪙', 'lose');
      haptic('error');
      sound('lose');
    }

    render();
    updateTip('«Играть ещё» — новая раздача.');
  }

  /* ---------- Раздача ---------- */
  function startHand() {
    if (S.phase === 'betting') return;

    const bb = Math.floor(Number(bet ? bet.value : 0) || 0);
    const minBet = (window.App && App.CONFIG) ? App.CONFIG.minBet : 10;

    if (bb < minBet) {
      App.toast('Минимальный большой блайнд — ' + fmt(minBet) + ' 🪙');
      return;
    }
    const start = playerAvailable();
    if (bb > start) {
      App.toast('Недостаточно тугриков');
      return;
    }
    if (!App.takeBet(bb)) return;

    S.startingBalance = start;
    S.bigBlind = bb;
    S.smallBlind = Math.max(1, Math.floor(bb / 2));
    S.playerCommitted = bb;
    S.dealerCommitted = Math.min(S.smallBlind, S.startingBalance);
    S.playerStreetBet = bb;
    S.dealerStreetBet = S.dealerCommitted;
    S.playerActed = false;
    S.dealerActed = false;
    S.lastRaiseSize = bb;
    S.dealerRevealed = false;
    S.busy = false;
    S.phase = 'betting';
    S.street = 'preflop';
    S.turn = 'dealer';
    S.board = [];
    S.deck = buildDeck();
    S.playerHole = [draw(), draw()];
    S.dealerHole = [draw(), draw()];
    S.handNo++;

    setStage('betting');
    setButtonsEnabled(false);
    render();
    setStatus('ПРЕФЛОП · дилер ставит малый блайнд и думает…');
    updateTip('Ты на большом блайнде, дилер — на малом. На префлопе первым ' +
      'действует дилер.');
    haptic('light');
    sound('ui');

    if (againBtn) againBtn.classList.add('hidden');
    scheduleDealer();
  }

  function resetTable() {
    S.phase = 'idle';
    S.street = 'preflop';
    S.deck = [];
    S.playerHole = [];
    S.dealerHole = [];
    S.board = [];
    S.startingBalance = 0;
    S.bigBlind = 0;
    S.smallBlind = 0;
    S.playerStreetBet = 0;
    S.dealerStreetBet = 0;
    S.playerCommitted = 0;
    S.dealerCommitted = 0;
    S.playerActed = false;
    S.dealerActed = false;
    S.lastRaiseSize = 0;
    S.dealerRevealed = false;
    S.turn = null;
    S.busy = false;

    setStage('idle');
    setButtonsEnabled(false);
    render();
    setStatus('Выбери большой блайнд и нажми «Раздать»');
    updateTip('Тебя ждут блайнды, четыре круга торговли и пять общих карт. ' +
      'Верхнего лимита ставки нет.');
    if (bet) bet.refresh();
  }

  /* ---------- Туториал ---------- */
  function showHelp(on) {
    if (!helpEl) return;
    helpEl.classList.toggle('hidden', !on);
    haptic('light');
  }

  /* ---------- Инициализация ---------- */
  function init() {
    playerCardsEl = $('pokerPlayerCards');
    dealerCardsEl = $('pokerDealerCards');
    playerHandEl = $('pokerPlayerHand');
    dealerHandEl = $('pokerDealerHand');
    communityEl = $('pokerCommunity');
    potEl = $('pokerPot');
    myStackEl = $('pokerMyStack');
    myBetEl = $('pokerMyBet');
    dealerBetEl = $('pokerDealerBet');
    statusEl = $('pokerStatus');
    betRow = $('pokerBetRow');
    playRow = $('pokerPlayRow');
    dealBtn = $('pokerDealBtn');
    callBtn = $('pokerCallBtn');
    foldBtn = $('pokerFoldBtn');
    allInBtn = $('pokerAllInBtn');
    raiseBtn = $('pokerRaiseBtn');
    raiseInput = $('pokerRaiseInput');
    againBtn = $('pokerAgainBtn');
    tipEl = $('pokerTip');
    helpEl = $('pokerHelp');
    helpBtn = $('pokerHelpBtn');
    helpClose = $('pokerHelpClose');
    helpOk = $('pokerHelpOk');

    if (!playerCardsEl || !dealerCardsEl) return;

    bet = App.initBetControl($('pokerBet'), { initial: 100 });

    if (dealBtn) dealBtn.addEventListener('click', startHand);
    if (callBtn) callBtn.addEventListener('click', playerCheckCall);
    if (foldBtn) foldBtn.addEventListener('click', playerFold);
    if (allInBtn) allInBtn.addEventListener('click', playerAllIn);
    if (raiseBtn) raiseBtn.addEventListener('click', () => playerRaise(readRaiseInput()));
    if (raiseInput) {
      raiseInput.addEventListener('input', () => {
        const digits = String(raiseInput.value || '').replace(/\D/g, '').slice(0, 15);
        if (digits !== raiseInput.value) raiseInput.value = digits;
      });
      raiseInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          playerRaise(readRaiseInput());
        }
      });
    }
    if (againBtn) againBtn.addEventListener('click', resetTable);

    if (helpBtn) helpBtn.addEventListener('click', () => showHelp(true));
    if (helpClose) helpClose.addEventListener('click', () => showHelp(false));
    if (helpOk) helpOk.addEventListener('click', () => showHelp(false));
    if (helpEl) {
      helpEl.addEventListener('click', (e) => {
        if (e.target === helpEl) showHelp(false);
      });
    }

    resetTable();
  }

  function readRaiseInput() {
    if (!raiseInput) return 0;
    return parseInt(String(raiseInput.value || '').replace(/\D/g, ''), 10) || 0;
  }

  function onOpen() {
    if (!playerCardsEl) return;
    render();
    if (bet) bet.refresh();
  }

  window.PokerGame = {
    init,
    onOpen,
    deal: startHand,
    evaluate,
    compareHands,
    bestOf,
    state: S,
  };
})();
