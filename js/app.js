'use strict';

/* ================= ЯДРО ================= */

const CONFIG = {
  startBalance: 10000,
  minBet: 10,
  maxBet: Infinity, // лимита сверху нет — играем на весь баланс
  betStep: 10,
  bonusMin: 1000000,
  bonusMax: 100000000,
  bonusCooldownMs: 5 * 60 * 60 * 1000,
  storageKey: 'tugriki_casino_v1',
  walletSyncDelayMs: 15000,
  walletMinWriteMs: 180000,
  walletForceWriteMs: 20000,
  walletCheckMs: 25000,
};

const State = {
  balance: CONFIG.startBalance,
  bank: 0,
  lastBonus: 0,
  usedPromos: [],
  walletUpdatedAt: 0,
};

/* ---------- Telegram ---------- */
const TG = (typeof window !== 'undefined' && window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;

function tgInit() {
  if (!TG) return;
  try {
    TG.ready();
    TG.expand();
    if (TG.setHeaderColor) TG.setHeaderColor('#0b0a14');
    if (TG.setBackgroundColor) TG.setBackgroundColor('#0b0a14');
    if (TG.disableVerticalSwipes) TG.disableVerticalSwipes();
  } catch (e) { /* старые клиенты */ }
}

function haptic(type) {
  if (!TG || !TG.HapticFeedback) return;
  try {
    if (type === 'success' || type === 'error' || type === 'warning') TG.HapticFeedback.notificationOccurred(type);
    else TG.HapticFeedback.impactOccurred(type || 'light');
  } catch (e) {}
}

/* ---------- Хранилище ---------- */
function accountStorageKey() {
  let acc = 'local';
  try {
    if (window.Cloud && Cloud.accountKey) acc = String(Cloud.accountKey() || 'local');
  } catch (e) {}
  acc = acc.replace(/[^a-z0-9_-]/gi, '_').slice(0, 80) || 'local';
  return CONFIG.storageKey + '_' + acc;
}

function loadState() {
  const key = accountStorageKey();
  let raw = null;
  try { raw = localStorage.getItem(key); } catch (e) {}

  // Перенос старого локального баланса в хранилище Telegram-аккаунта.
  // Раньше ключ строился от открытого ID/username, теперь — от хеша.
  if (!raw) {
    const legacy = [];
    try {
      if (window.Cloud && Cloud.userId && Cloud.userId()) {
        legacy.push(CONFIG.storageKey + '_id_' + String(Cloud.userId()).replace(/[^a-z0-9_-]/gi, '_'));
      }
      if (window.Cloud && Cloud.username && Cloud.username()) {
        legacy.push(CONFIG.storageKey + '_u_' + String(Cloud.username()).replace(/[^a-z0-9_-]/gi, '_'));
      }
    } catch (e) {}
    legacy.push(CONFIG.storageKey);
    for (const oldKey of legacy) {
      try {
        raw = localStorage.getItem(oldKey);
        if (raw) {
          localStorage.setItem(key, raw);
          break;
        }
      } catch (e) {}
    }
  }

  try {
    if (raw) {
      const s = JSON.parse(raw);
      if (typeof s.balance === 'number' && isFinite(s.balance)) State.balance = Math.max(0, Math.floor(s.balance));
      if (typeof s.bank === 'number' && isFinite(s.bank)) State.bank = Math.max(0, Math.floor(s.bank));
      if (typeof s.lastBonus === 'number') State.lastBonus = s.lastBonus;
      if (Array.isArray(s.usedPromos)) State.usedPromos = s.usedPromos.filter(x => typeof x === 'string');
      if (typeof s.walletUpdatedAt === 'number' && isFinite(s.walletUpdatedAt)) {
        State.walletUpdatedAt = Math.max(0, Math.floor(s.walletUpdatedAt));
      }
    }
  } catch (e) {}
}

function saveState() {
  try {
    localStorage.setItem(accountStorageKey(), JSON.stringify(State));
  } catch (e) {}
}

/* ---------- Облачный кошелёк: один аккаунт на телефоне и ПК ---------- */
let walletTimer = null;
let walletTimerAt = 0;
let walletBusy = false;
let walletLastCheck = 0;
let walletLastWrite = 0;
let walletRetryAt = 0;

function canSyncWallet() {
  return !!(window.Cloud && Cloud.canSyncWallet && Cloud.canSyncWallet() &&
    Cloud.readWallet && Cloud.writeWallet);
}

function scheduleWalletSync(delay) {
  if (!canSyncWallet()) return;
  const wait = Math.max(0, delay == null ? CONFIG.walletSyncDelayMs : delay);
  const at = Date.now() + wait;
  // Более ранний запрос ускоряет синхронизацию, более поздний не откладывает
  // уже запланированную. Иначе при частых ставках запись откладывалась бы вечно.
  if (walletTimer && walletTimerAt && walletTimerAt <= at) return;
  if (walletTimer) clearTimeout(walletTimer);
  walletTimerAt = at;
  walletTimer = setTimeout(() => {
    walletTimer = null;
    walletTimerAt = 0;
    syncWallet(false);
  }, wait);
}

/** Помечает кошелёк изменённым и ставит отложенную синхронизацию. */
function markWalletChanged() {
  State.walletUpdatedAt = Date.now();
  saveState();
  scheduleWalletSync();
}

/**
 * Синхронизация кошелька с облаком.
 * Побеждает более свежая запись (updatedAt). Так телефон и компьютер
 * с одним Telegram-аккаунтом видят один баланс, банк и кулдаун бонуса.
 */
async function syncWallet(force, opts) {
  if (walletBusy || !canSyncWallet()) return false;
  const now = Date.now();
  const immediate = !!(opts && opts.immediate);
  if (!force && walletLastCheck && now - walletLastCheck < CONFIG.walletCheckMs) {
    scheduleWalletSync(CONFIG.walletCheckMs - (now - walletLastCheck));
    return false;
  }
  if (walletRetryAt && now < walletRetryAt) {
    scheduleWalletSync(walletRetryAt - now);
    return false;
  }

  walletBusy = true;
  walletLastCheck = now;
  const stampAtStart = State.walletUpdatedAt;
  try {
    const remote = await Cloud.readWallet(opts);

    // Игрок успел изменить баланс во время запроса — не затираем его.
    if (State.walletUpdatedAt !== stampAtStart) {
      scheduleWalletSync(2000);
      return false;
    }

    const remoteAt = remote ? (Number(remote.updatedAt) || 0) : 0;
    const localAt = Number(State.walletUpdatedAt) || 0;

    // В облаке более свежие данные — забираем их.
    if (remote && remoteAt > localAt) {
      State.balance = remote.balance;
      State.bank = remote.bank;
      State.lastBonus = Math.max(State.lastBonus, remote.lastBonus || 0);
      State.walletUpdatedAt = remoteAt;
      saveState();
      renderBalance();
      if (window.Bank && Bank.refresh) Bank.refresh();
      return true;
    }

    // Уже синхронизировано.
    if (remote && remoteAt === localAt && localAt > 0) return true;

    // Локальные данные новее — выгружаем.
    const gap = immediate ? 0 : (force ? CONFIG.walletForceWriteMs : CONFIG.walletMinWriteMs);
    if (walletLastWrite && now - walletLastWrite < gap) {
      scheduleWalletSync(gap - (now - walletLastWrite));
      return false;
    }

    const stamp = localAt || now;
    State.walletUpdatedAt = stamp;
    const wallet = {
      v: 2,
      balance: State.balance,
      bank: State.bank,
      lastBonus: State.lastBonus,
      updatedAt: stamp,
    };
    await Cloud.writeWallet(wallet, opts);
    walletLastWrite = Date.now();
    walletRetryAt = 0;
    saveState();
    if (State.walletUpdatedAt !== stamp) scheduleWalletSync(CONFIG.walletMinWriteMs);
    return true;
  } catch (e) {
    walletRetryAt = Date.now() + 45000;
    scheduleWalletSync(45000);
    return false;
  } finally {
    walletBusy = false;
  }
}

function initWalletSync() {
  if (!canSyncWallet()) return;
  scheduleWalletSync(1200);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) syncWallet(true, { keepalive: true, immediate: true });
    else scheduleWalletSync(1000);
  });
  window.addEventListener('focus', () => scheduleWalletSync(1200));
  window.addEventListener('online', () => scheduleWalletSync(1000));
  window.addEventListener('screenchange', () => scheduleWalletSync(2000));
  window.addEventListener('pagehide', () => {
    syncWallet(true, { keepalive: true, immediate: true });
  });

  // Пока игра открыта, раз в 90 секунд проверяем, не изменил ли кошелёк
  // другой компьютер/телефон. Чтение из TextDB бесплатное.
  setInterval(() => {
    if (!document.hidden) syncWallet(false);
  }, 90000);
}

/* ---------- Баланс ---------- */
function fmt(n) {
  const v = Math.floor(Number(n) || 0);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0');
}

function renderBalance() {
  document.querySelectorAll('[data-balance]').forEach(el => { el.textContent = fmt(State.balance); });
}

function pulseBalance() {
  const pill = document.getElementById('balancePill');
  if (!pill) return;
  pill.classList.remove('bump');
  void pill.offsetWidth;
  pill.classList.add('bump');
}

/** Изменяет баланс. Возвращает новый баланс. */
function addBalance(delta) {
  State.balance = Math.max(0, Math.floor(State.balance + Math.floor(delta)));
  State.walletUpdatedAt = Date.now();
  saveState();
  renderBalance();
  pulseBalance();
  scheduleWalletSync();
  return State.balance;
}

/** Списывает ставку, если хватает. Возвращает true/false. */
function takeBet(amount) {
  amount = Math.floor(Number(amount) || 0);
  if (!isFinite(amount) || amount <= 0) { toast('Некорректная ставка'); return false; }
  if (amount < CONFIG.minBet) { toast('Минимальная ставка — ' + fmt(CONFIG.minBet) + ' 🪙'); return false; }
  if (amount > State.balance) { toast('Недостаточно тугриков'); return false; }
  addBalance(-amount);
  return true;
}

/* ---------- UI ---------- */
let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ---------- Роутер ---------- */
const SCREENS = ['menu', 'slots', 'roulette', 'blackjack', 'poker', 'esports', 'bank', 'promo', 'runner', 'admin'];
let currentScreen = 'menu';

function showScreen(name) {
  if (!SCREENS.includes(name)) name = 'menu';
  SCREENS.forEach(s => {
    const el = document.getElementById('screen-' + s);
    if (el) el.classList.toggle('active', s === name);
  });
  currentScreen = name;
  const back = document.getElementById('backBtn');
  if (back) back.classList.toggle('hidden', name === 'menu');
  if (TG && TG.BackButton) {
    try { if (name === 'menu') TG.BackButton.hide(); else TG.BackButton.show(); } catch (e) {}
  }
  const brand = document.getElementById('brand');
  if (brand) {
    const titles = { menu: '🎮 LoseLine', slots: '🏺 ПИРАМИДА', roulette: '🎡 РУЛЕТКА', blackjack: '🃏 БЛЭКДЖЕК', poker: '♠️ ХОЛДЕМ', esports: '🎮 КИБЕРСПОРТ', bank: '🏦 БАНК', promo: '🎟️ ПРОМОКОД', runner: '🏃 ПОБЕГ ПО КРЫШАМ', admin: '🛡️ АДМИН' };
    brand.textContent = titles[name] || '🎮 LoseLine';
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (name === 'poker' && window.PokerGame) window.PokerGame.onOpen();
  if (name === 'esports' && window.Esports) window.Esports.onOpen();
  if (name === 'bank' && window.Bank) window.Bank.onOpen();
  if (name === 'promo' && window.Promo) window.Promo.onOpen();
  if (name === 'runner' && window.Runner) window.Runner.onOpen();
  if (name === 'admin' && window.Admin) window.Admin.onOpen();
  window.dispatchEvent(new CustomEvent('screenchange', { detail: { screen: name } }));
  haptic('light');
}

/* ---------- Контрол ставки ---------- */
function clampBet(v) {
  v = Math.round((Number(v) || 0) / CONFIG.betStep) * CONFIG.betStep;
  if (v < CONFIG.minBet) v = CONFIG.minBet;
  if (v > CONFIG.maxBet) v = CONFIG.maxBet;
  return v;
}

/**
 * @param {HTMLElement} root
 * @param {{initial?:number, onChange?:(v:number)=>void}} opts
 */
function initBetControl(root, opts = {}) {
  if (!root) return { get: () => CONFIG.minBet, set: () => {}, refresh: () => {} };
  const cfg = Object.assign({ initial: 100, onChange: null }, opts);
  const input = root.querySelector('[data-bet-input]');
  let value = clampBet(cfg.initial);
  let locked = false;
  let editing = false;

  function paint() {
    if (input) {
      input.disabled = locked;
      if (!editing) input.value = String(value);
    }
    root.querySelectorAll('.bc-btn').forEach(b => {
      if (b.dataset.act === 'max') b.disabled = locked || value >= Math.min(CONFIG.maxBet, Math.max(CONFIG.minBet, State.balance));
      else b.disabled = locked;
    });
  }

  function setValue(v, silent) {
    const nv = clampBet(v);
    editing = false;
    if (nv === value) { paint(); return; }
    value = nv;
    paint();
    if (!silent && cfg.onChange) cfg.onChange(value);
  }

  root.addEventListener('click', (e) => {
    const btn = e.target.closest('.bc-btn');
    if (!btn || locked) return;
    const act = btn.dataset.act;
    if (act === 'inc') setValue(value + CONFIG.betStep * 5);
    else if (act === 'dec') setValue(value - CONFIG.betStep * 5);
    else if (act === 'max') {
      const max = Math.floor(Math.min(CONFIG.maxBet, State.balance) / CONFIG.betStep) * CONFIG.betStep;
      setValue(Math.max(CONFIG.minBet, max));
    }
    haptic('light');
  });

  root.addEventListener('wheel', (e) => {
    if (locked) return;
    e.preventDefault();
    setValue(value + (e.deltaY < 0 ? CONFIG.betStep * 5 : -CONFIG.betStep * 5));
  }, { passive: false });

  /* Ручной ввод суммы: без «спама» плюсом. */
  if (input) {
    const readTyped = () => {
      const n = parseInt(String(input.value || '').replace(/\D/g, ''), 10);
      return isFinite(n) ? n : 0;
    };

    input.addEventListener('focus', () => {
      if (locked) return;
      editing = true;
      input.value = String(value);
      setTimeout(() => { try { input.select(); } catch (e) {} }, 0);
    });

    input.addEventListener('input', () => {
      if (locked) return;
      let digits = String(input.value).replace(/\D/g, '').slice(0, 9).replace(/^0+(?=\d)/, '');
      if (input.value !== digits) input.value = digits;
      const n = parseInt(digits, 10);
      if (isFinite(n) && n > 0) {
        value = Math.min(n, CONFIG.maxBet);
        if (cfg.onChange) cfg.onChange(value);
      }
    });

    input.addEventListener('blur', () => {
      if (locked) { editing = false; paint(); return; }
      setValue(readTyped() || CONFIG.minBet);
      if (cfg.onChange) cfg.onChange(value);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      }
    });
  }

  paint();

  return {
    get value() { return value; },
    set(v) { setValue(v); },
    lock(on) { locked = !!on; paint(); },
    refresh: paint,
  };
}

/* ---------- Бонус ---------- */
function initMenuActions() {
  const bonusBtn = document.getElementById('bonusBtn');

  function rollBonus() {
    const min = Math.max(1, Math.floor(CONFIG.bonusMin));
    const max = Math.max(min, Math.floor(CONFIG.bonusMax));
    return Math.floor(min + Math.random() * (max - min + 1));
  }

  function bonusLabel() {
    if (!bonusBtn) return;
    const left = CONFIG.bonusCooldownMs - (Date.now() - State.lastBonus);
    if (left > 0) {
      const h = Math.floor(left / 3600000);
      const m = Math.floor((left % 3600000) / 60000);
      bonusBtn.textContent = '⏳ Бонус через ' + (h > 0 ? h + ' ч ' : '') + m + ' мин';
      bonusBtn.disabled = true;
    } else {
      bonusBtn.textContent = '🎁 Бонус: 1 000 000 – 100 000 000';
      bonusBtn.disabled = false;
    }
  }

  if (bonusBtn) {
    bonusBtn.addEventListener('click', () => {
      if (Date.now() - State.lastBonus < CONFIG.bonusCooldownMs) { bonusLabel(); return; }
      const amount = rollBonus();
      State.lastBonus = Date.now();
      addBalance(amount);
      saveState();
      haptic('success');
      if (window.Sound) Sound.win(amount >= 100000 ? 'big' : 'normal');
      if (amount >= 100000) bigWin('БОНУС', amount);
      toast('Бонус получен: +' + fmt(amount) + ' 🪙');
      bonusLabel();
    });
  }

  bonusLabel();
  setInterval(bonusLabel, 30000);
}

/* ---------- Кнопки меню ---------- */
function initNavigation() {
  document.querySelectorAll('[data-game]').forEach(btn => {
    btn.addEventListener('click', () => showScreen(btn.dataset.game));
  });
  const back = document.getElementById('backBtn');
  if (back) back.addEventListener('click', () => showScreen('menu'));
  // аппаратная кнопка "назад" в Telegram
  if (TG && TG.BackButton) {
    TG.BackButton.onClick(() => { if (currentScreen !== 'menu') showScreen('menu'); });
  }
}

/* ---------- Эффекты ---------- */
function fxLayer() {
  let layer = document.getElementById('fxLayer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'fxLayer';
    layer.className = 'fx-layer';
    document.body.appendChild(layer);
  }
  return layer;
}

/** Разлетающиеся монеты из центра элемента. */
function spawnCoins(originEl, count = 14) {
  if (!originEl) return;
  const r = originEl.getBoundingClientRect();
  if (!r.width && !r.height) return;
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const layer = fxLayer();
  const n = Math.max(1, Math.min(40, Math.round(count)));

  for (let i = 0; i < n; i++) {
    const c = document.createElement('div');
    c.className = 'coin-particle';
    c.textContent = '🪙';
    const ang = Math.random() * Math.PI * 2;
    const dist = 60 + Math.random() * 140;
    const dx = Math.cos(ang) * dist;
    const dy = Math.sin(ang) * dist + 70;
    c.style.left = (cx - 11) + 'px';
    c.style.top = (cy - 11) + 'px';
    c.style.setProperty('--dx', dx.toFixed(1) + 'px');
    c.style.setProperty('--dy', dy.toFixed(1) + 'px');
    c.style.setProperty('--rot', Math.round(Math.random() * 540 - 270) + 'deg');
    c.style.setProperty('--dur', Math.round(700 + Math.random() * 500) + 'ms');
    c.style.animationDelay = Math.round(Math.random() * 120) + 'ms';
    layer.appendChild(c);
    setTimeout(() => c.remove(), 1600);
  }
}

/** Всплывающий текст выигрыша над элементом. */
function floatWin(text, originEl) {
  if (!text) return;
  let x = window.innerWidth / 2;
  let y = window.innerHeight / 2;
  if (originEl) {
    const r = originEl.getBoundingClientRect();
    if (r.width || r.height) {
      x = r.left + r.width / 2;
      y = r.top + Math.min(r.height / 2, 220);
    }
  }
  const el = document.createElement('div');
  el.className = 'float-win';
  el.textContent = text;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  fxLayer().appendChild(el);
  setTimeout(() => el.remove(), 1300);
}

/** Тряска элемента (проигрыш / крупный выигрыш). */
function shake(el) {
  if (!el) return;
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
  setTimeout(() => el.classList.remove('shake'), 500);
}

let bigWinTimer = null;

/** Полноэкранный оверлей BIG WIN / MEGA WIN. */
function bigWin(label, amount) {
  const box = document.getElementById('bigwin');
  if (!box) return;
  const title = document.getElementById('bigwinTitle');
  const val = document.getElementById('bigwinAmount');
  if (title) title.textContent = label || 'BIG WIN';
  if (val) val.textContent = (amount != null && amount > 0) ? '+ ' + fmt(amount) + ' 🪙' : '';
  box.classList.remove('show');
  void box.offsetWidth;
  box.classList.add('show');
  clearTimeout(bigWinTimer);
  bigWinTimer = setTimeout(() => box.classList.remove('show'), 1900);
}

/** Плавный счётчик чисел (с резервным таймером, если rAF тормозится). */
function countUp(el, from, to, dur = 600) {
  if (!el) return;
  from = Number(from) || 0;
  to = Number(to) || 0;
  const start = performance.now();
  const delta = to - from;
  const myId = (el._cuId = (el._cuId || 0) + 1);
  let done = false;
  function finish() {
    if (done || el._cuId !== myId) return;
    done = true;
    el.textContent = fmt(to);
  }
  function tick(now) {
    if (done || el._cuId !== myId) return;
    const t = Math.min(1, (now - start) / Math.max(1, dur));
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = fmt(Math.round(from + delta * eased));
    if (t < 1) requestAnimationFrame(tick);
    else finish();
  }
  requestAnimationFrame(tick);
  setTimeout(finish, Math.max(1, dur) + 120);
}

/* ---------- Звук ---------- */
function initSound() {
  if (!window.Sound) return;
  const btn = document.getElementById('soundBtn');

  function paint() {
    if (!btn) return;
    const muted = Sound.muted;
    btn.textContent = muted ? '🔇' : '🔊';
    btn.classList.toggle('off', muted);
    btn.setAttribute('aria-label', muted ? 'Включить звук' : 'Выключить звук');
    btn.setAttribute('title', muted ? 'Звук выключен' : 'Звук включён');
  }

  if (btn) {
    btn.addEventListener('click', () => {
      const muted = Sound.toggle();
      paint();
      toast(muted ? '🔇 Звук выключен' : '🔊 Звук включён');
    });
  }

  // лёгкий щелчок на все кнопки интерфейса
  document.addEventListener('click', (e) => {
    if (!e.target.closest('button')) return;
    if (e.target.closest('#soundBtn')) return;
    Sound.ui();
  });

  paint();
}

/* ---------- Экспорт ---------- */
window.App = {
  CONFIG, State,
  fmt, addBalance, takeBet, toast, haptic, showScreen, initBetControl,
  renderBalance, saveState, markWalletChanged, scheduleWalletSync, syncWallet,
  spawnCoins, floatWin, shake, bigWin, countUp,
};

/* ---------- Старт ---------- */
document.addEventListener('DOMContentLoaded', () => {
  // «Зал славы» удалён из проекта — убираем его старые локальные ключи.
  ['tugriki_profile_v1', 'tugriki_hall_v2', 'tugriki_leaders_v1'].forEach(k => {
    try { localStorage.removeItem(k); } catch (e) {}
  });

  tgInit();
  loadState();
  renderBalance();
  initSound();
  if (window.Cloud) window.Cloud.init();
  initWalletSync();
  initNavigation();
  initMenuActions();
  if (window.SlotsGame) window.SlotsGame.init();
  if (window.RouletteGame) window.RouletteGame.init();
  if (window.BlackjackGame) window.BlackjackGame.init();
  if (window.PokerGame) window.PokerGame.init();
  if (window.Esports) window.Esports.init();
  if (window.Bank) window.Bank.init();
  if (window.Promo) window.Promo.init();
  if (window.Admin) window.Admin.init();
  if (window.Runner) window.Runner.init();
  showScreen('menu');
});
