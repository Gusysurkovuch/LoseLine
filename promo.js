'use strict';

/* ================= ПРОМОКОДЫ ================= */
(function () {

  const REWARD = 30000000;
  const TOTAL = 60;

  /* 60 одноразовых промокодов: каждый даёт 30 000 000 тугриков. */
  const CODES = [
    'LOSE-30M-8V2R3',
    'LOSE-30M-459L4',
    'LOSE-30M-3WPH3',
    'LOSE-30M-E4EQH',
    'LOSE-30M-GYF7S',
    'LOSE-30M-GM4UH',
    'LOSE-30M-B6ENR',
    'LOSE-30M-UAL3Y',
    'LOSE-30M-PLBHZ',
    'LOSE-30M-LDACK',
    'LOSE-30M-CSFRU',
    'LOSE-30M-H7NDQ',
    'LOSE-30M-38KM3',
    'LOSE-30M-4R5QT',
    'LOSE-30M-RQ59D',
    'LOSE-30M-GPRFJ',
    'LOSE-30M-5SBC4',
    'LOSE-30M-9SYV9',
    'LOSE-30M-LYSP3',
    'LOSE-30M-DG5EH',
    'LOSE-30M-34X82',
    'LOSE-30M-HZU8X',
    'LOSE-30M-L5AMZ',
    'LOSE-30M-JUVN5',
    'LOSE-30M-G5XEW',
    'LOSE-30M-RJSVH',
    'LOSE-30M-2YJ3U',
    'LOSE-30M-P28WW',
    'LOSE-30M-J8X4N',
    'LOSE-30M-67R7T',
    'LOSE-30M-HV59Q',
    'LOSE-30M-YZUWX',
    'LOSE-30M-9S8C4',
    'LOSE-30M-XP275',
    'LOSE-30M-29DLU',
    'LOSE-30M-T29QU',
    'LOSE-30M-A8H75',
    'LOSE-30M-69SYZ',
    'LOSE-30M-X4EHX',
    'LOSE-30M-34W36',
    'LOSE-30M-EL9TB',
    'LOSE-30M-ZHM7W',
    'LOSE-30M-Y7PRH',
    'LOSE-30M-XZELV',
    'LOSE-30M-CH74D',
    'LOSE-30M-HBZU6',
    'LOSE-30M-PTZ72',
    'LOSE-30M-K98YK',
    'LOSE-30M-SW2HF',
    'LOSE-30M-SU5RX',
    'LOSE-30M-45WSX',
    'LOSE-30M-36C26',
    'LOSE-30M-WK4K7',
    'LOSE-30M-R3QNU',
    'LOSE-30M-X2XCS',
    'LOSE-30M-BQWTY',
    'LOSE-30M-XKUED',
    'LOSE-30M-LFWGA',
    'LOSE-30M-JQ873',
    'LOSE-30M-TCVNB',
  ];

  const CODE_SET = new Set(CODES);
  const $ = (id) => document.getElementById(id);

  let input, usedEl, totalEl, globalEl, statusEl, btn;
  let busy = false;

  function used() {
    const list = Array.isArray(App.State.usedPromos) ? App.State.usedPromos.slice() : [];
    // Промокоды общие для аккаунта: на другом устройстве список придёт из облака.
    try {
      if (window.Cloud && Cloud.myPromos && Cloud.stats && Cloud.stats().loaded) {
        Cloud.myPromos().forEach((code) => {
          if (list.indexOf(code) < 0) list.push(code);
        });
      }
    } catch (e) {}
    return list;
  }

  function normalize(v) {
    return String(v || '').toUpperCase().replace(/\s+/g, '');
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function paint() {
    const list = used();
    if (usedEl) usedEl.textContent = list.length + ' / ' + TOTAL;
    if (totalEl) totalEl.textContent = App.fmt(list.length * REWARD) + ' 🪙';

    if (globalEl) {
      const stats = window.Cloud ? Cloud.stats() : null;
      if (stats && stats.loaded) {
        globalEl.textContent = Cloud.promoCount() + ' / ' + TOTAL;
      } else {
        globalEl.textContent = '—';
      }
    }
    if (btn) {
      btn.disabled = busy;
      btn.textContent = busy ? 'ПРОВЕРЯЕМ…' : 'АКТИВИРОВАТЬ';
    }
  }

  function fail(text, offline) {
    setStatus(text);
    App.toast(text);
    App.haptic('error');
    if (window.Sound) Sound.lose();
    if (offline) {
      // Ничего не начисляем: без подтверждения сервера код не считается использованным.
    }
    paint();
    return false;
  }

  async function redeem() {
    if (busy) return false;
    const code = normalize(input ? input.value : '');
    if (!code) {
      setStatus('Введи промокод');
      App.toast('Введи промокод');
      return false;
    }
    if (!CODE_SET.has(code)) {
      return fail('Такого промокода нет');
    }
    if (used().includes(code)) {
      return fail('Этот промокод уже использован');
    }
    if (!window.Cloud) {
      return fail('Проверка промокодов недоступна: не загрузился модуль облака.', true);
    }

    busy = true;
    paint();
    setStatus('Проверяем код на сервере…');
    App.haptic('light');

    let res;
    try {
      res = await Cloud.redeemPromo(code);
    } catch (e) {
      res = { ok: false, offline: true, reason: 'Ошибка сети. Промокод не активирован.' };
    }

    busy = false;

    if (!res || !res.ok) {
      paint();
      return fail((res && res.reason) || 'Не удалось активировать промокод', res && res.offline);
    }

    App.State.usedPromos = used().concat(code);
    App.addBalance(REWARD); // сохраняет State вместе со списком использованных кодов
    App.saveState();
    paint();
    setStatus('Промокод активирован: +' + App.fmt(REWARD) + ' 🪙');
    App.toast('Промокод: +' + App.fmt(REWARD) + ' 🪙');
    App.haptic('success');
    if (window.Sound) Sound.win('big');
    App.bigWin('ПРОМОКОД', REWARD);
    if (input) input.value = '';
    return true;
  }

  function init() {
    input = $('promoInput');
    usedEl = $('promoUsed');
    totalEl = $('promoTotal');
    globalEl = $('promoGlobal');
    statusEl = $('promoStatus');
    btn = $('promoBtn');
    if (!input) return;

    input.addEventListener('input', () => {
      input.value = normalize(input.value).slice(0, 32);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (!busy) redeem();
    });

    if (btn) btn.addEventListener('click', () => { if (!busy) redeem(); });

    paint();
  }

  function onOpen() {
    paint();
    setStatus(used().length >= TOTAL
      ? 'Все ' + TOTAL + ' промокодов уже активированы.'
      : 'Введи промокод и нажми «Активировать». Каждый код — один раз на всех.');

    if (window.Cloud) {
      Cloud.refresh()
        .then(() => { paint(); })
        .catch(() => { paint(); });
    }
  }

  window.Promo = { init, onOpen, redeem, REWARD, TOTAL, CODES };
})();
