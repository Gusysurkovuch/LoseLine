'use strict';

/* ================= АДМИН-ПАНЕЛЬ ================= */
(function () {

  const $ = (id) => document.getElementById(id);
  const ADMIN = 'gusisurkovuch';

  let btn, accountEl, cloudEl, targetEl, reasonEl, banBtn, unbanBtn, refreshBtn, listEl, statusEl;
  let accessBox, panelBox;
  let playersListEl, playersRefreshBtn, playersStatusEl;
  const walletCache = new Map(); // ключ игрока → { at, wallet }
  const WALLET_CACHE_MS = 45000;
  let busy = false;
  let bound = false;

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function isAdmin() {
    if (window.Cloud) return Cloud.isAdmin();
    try {
      const u = window.Telegram && Telegram.WebApp && Telegram.WebApp.initDataUnsafe && Telegram.WebApp.initDataUnsafe.user;
      return !!u && String(u.username || '').toLowerCase() === ADMIN;
    } catch (e) { return false; }
  }

  function refreshAccess() {
    const ok = isAdmin();
    if (accessBox) accessBox.classList.toggle('hidden', ok);
    if (panelBox) panelBox.classList.toggle('hidden', !ok);

    const menuBtn = $('adminBtn');
    if (menuBtn) menuBtn.classList.toggle('hidden', !ok);

    if (accountEl && window.Cloud) accountEl.textContent = Cloud.accountLabel();
    if (cloudEl && window.Cloud) {
      const s = Cloud.stats();
      cloudEl.textContent = s.online ? 'онлайн' : (s.loaded ? 'кэш' : 'нет связи');
      cloudEl.style.color = s.online ? 'var(--green)' : '#ffb347';
    }
    return ok;
  }

  function renderList() {
    if (!listEl) return;
    listEl.innerHTML = '';
    const list = window.Cloud ? Cloud.listBans() : [];

    if (!list.length) {
      const empty = document.createElement('p');
      empty.className = 'admin-empty';
      empty.textContent = 'Забаненных игроков нет.';
      listEl.appendChild(empty);
      return;
    }

    list.forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'admin-ban-row';

      const main = document.createElement('div');
      main.className = 'admin-ban-main';

      const who = document.createElement('b');
      who.textContent = entry.target || Cloud.targetLabel(entry.key) || entry.key;
      main.appendChild(who);

      const why = document.createElement('small');
      why.textContent = (entry.reason || 'без причины') + ' · ' + dateLabel(entry.at) +
        (entry.by ? ' · ' + entry.by : '');
      main.appendChild(why);

      const un = document.createElement('button');
      un.className = 'link-btn admin-unban';
      un.type = 'button';
      un.textContent = 'Разбанить';
      un.dataset.unban = entry.key;
      un.addEventListener('click', () => doUnban(entry.key));

      row.appendChild(main);
      row.appendChild(un);
      listEl.appendChild(row);
    });
  }

  function dateLabel(ts) {
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleString('ru-RU', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      });
    } catch (e) { return ''; }
  }

  function money(n) {
    const v = Math.floor(Number(n) || 0);
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0');
  }

  async function renderPlayers() {
    if (!playersListEl) return;
    if (!window.Cloud || !Cloud.listPlayers || !Cloud.readWalletFor) {
      playersListEl.innerHTML = '<p class="admin-empty">Модуль облака не загрузился.</p>';
      return;
    }

    const players = Cloud.listPlayers();
    playersListEl.innerHTML = '';
    if (!players.length) {
      const empty = document.createElement('p');
      empty.className = 'admin-empty';
      empty.textContent = 'Пока нет известных игроков. Появятся после входа в Telegram.';
      playersListEl.appendChild(empty);
      if (playersStatusEl) playersStatusEl.textContent = 'Игроков: 0';
      return;
    }

    const list = players.slice(0, 80);
    if (playersStatusEl) {
      playersStatusEl.textContent = 'Игроков: ' + players.length + ' · читаем баланс и банк…';
    }

    const now = Date.now();
    const wallets = await Promise.all(list.map((p) => {
      const cacheKey = p.key || p.id || p.username;
      const cached = walletCache.get(cacheKey);
      if (cached && now - cached.at < WALLET_CACHE_MS) return cached.wallet;
      return Cloud.readWalletFor(p)
        .then((w) => {
          walletCache.set(cacheKey, { at: Date.now(), wallet: w });
          return w;
        })
        .catch(() => null);
    }));

    list.forEach((p, i) => {
      const w = wallets[i];
      const row = document.createElement('div');
      row.className = 'admin-ban-row admin-player-row';

      const main = document.createElement('div');
      main.className = 'admin-ban-main';

      const who = document.createElement('b');
      const pseudo = 'Игрок #' + String(p.key || '').replace(/^[a-z]+:/i, '').slice(0, 6).toUpperCase();
      who.textContent = (p.username ? '@' + p.username : (p.id ? 'ID ' + p.id : pseudo)) +
        (p.id && p.username ? ' · ID ' + p.id : '') +
        (p.banned ? ' · 🚫' : '');
      main.appendChild(who);

      const stat = document.createElement('small');
      if (w) {
        stat.textContent = 'Баланс: ' + money(w.balance) + ' 🪙 · Банк: ' + money(w.bank) +
          ' 🪙 · Всего: ' + money(w.balance + w.bank) +
          ' · обновлён: ' + dateLabel(w.updatedAt);
      } else {
        stat.textContent = 'Кошелёк ещё не синхронизирован · в облаке с ' + dateLabel(p.at);
      }
      main.appendChild(stat);

      const meta = document.createElement('small');
      meta.className = 'admin-player-meta';
      meta.textContent = 'ID: ' + (p.id || 'не раскрыт') + ' · @' + (p.username || '—') +
        ' · ' + (p.banned ? 'забанен' : 'активен');
      main.appendChild(meta);

      const pick = document.createElement('button');
      pick.className = 'link-btn admin-unban';
      pick.type = 'button';
      pick.textContent = 'В поле бана';
      pick.disabled = !p.id && !p.username;
      pick.addEventListener('click', () => {
        if (targetEl) {
          targetEl.value = p.id || p.username || '';
          targetEl.focus();
        }
      });

      row.appendChild(main);
      row.appendChild(pick);
      playersListEl.appendChild(row);
    });

    if (playersStatusEl) {
      playersStatusEl.textContent = 'Игроков: ' + players.length +
        ' · показаны ' + list.length + ' · данные обновлены ' + dateLabel(Date.now());
    }
  }

  function setBusy(on) {
    busy = !!on;
    [banBtn, unbanBtn, refreshBtn].forEach((b) => { if (b) b.disabled = busy; });
  }

  async function reload() {
    if (!window.Cloud) {
      setStatus('Модуль облака не загрузился.');
      return;
    }
    if (busy) return;
    setBusy(true);
    setStatus('Загружаем список банов…');
    try {
      await Cloud.refresh();
      refreshAccess();
      renderList();
      renderPlayers();
      const s = Cloud.stats();
      setStatus(s.online
        ? 'Список обновлён · банов: ' + s.bans + ' · промокодов: ' + s.promos
        : 'Облако недоступно. Показан последний загруженный список.');
    } catch (e) {
      renderList();
      setStatus('Нет связи с облаком. Показан последний загруженный список.');
    } finally {
      setBusy(false);
    }
  }

  async function doBan() {
    if (busy) return;
    if (!isAdmin()) { setStatus('Нет доступа'); return; }
    const target = targetEl ? targetEl.value.trim() : '';
    if (!target) { setStatus('Введи @username или Telegram ID'); if (targetEl) targetEl.focus(); return; }

    setBusy(true);
    setStatus('Баним ' + target + '…');
    try {
      const res = await Cloud.ban(target, reasonEl ? reasonEl.value : '');
      if (!res.ok) {
        setStatus(res.reason || 'Не удалось забанить');
        if (window.App) { App.toast(res.reason || 'Не удалось забанить'); App.haptic('error'); }
      } else {
        setStatus('Забанен: ' + res.target);
        if (window.App) { App.toast('Забанен: ' + res.target); App.haptic('success'); }
        if (targetEl) targetEl.value = '';
        if (reasonEl) reasonEl.value = '';
        renderList();
        renderPlayers();
        refreshAccess();
      }
    } catch (e) {
      setStatus('Ошибка сети. Попробуй ещё раз.');
    } finally {
      setBusy(false);
    }
  }

  async function doUnban(target) {
    if (busy) return;
    if (!isAdmin()) { setStatus('Нет доступа'); return; }
    const value = target || (targetEl ? targetEl.value.trim() : '');
    if (!value) { setStatus('Введи @username или Telegram ID'); return; }

    setBusy(true);
    setStatus('Снимаем бан…');
    try {
      const res = await Cloud.unban(value);
      if (!res.ok) {
        setStatus(res.reason || 'Не удалось снять бан');
      } else {
        setStatus('Бан снят: ' + res.target);
        if (window.App) { App.toast('Бан снят: ' + res.target); App.haptic('success'); }
        if (targetEl) targetEl.value = '';
        renderList();
        renderPlayers();
        refreshAccess();
      }
    } catch (e) {
      setStatus('Ошибка сети. Попробуй ещё раз.');
    } finally {
      setBusy(false);
    }
  }

  function init() {
    btn = $('adminBtn');
    accountEl = $('adminAccount');
    cloudEl = $('adminCloudState');
    targetEl = $('adminTarget');
    reasonEl = $('adminReason');
    banBtn = $('adminBan');
    unbanBtn = $('adminUnban');
    refreshBtn = $('adminRefresh');
    listEl = $('adminBanList');
    statusEl = $('adminStatus');
    accessBox = $('adminAccess');
    panelBox = $('adminPanel');
    playersListEl = $('adminPlayerList');
    playersRefreshBtn = $('adminPlayersRefresh');
    playersStatusEl = $('adminPlayersStatus');

    if (!bound) {
      bound = true;
      if (banBtn) banBtn.addEventListener('click', doBan);
      if (unbanBtn) unbanBtn.addEventListener('click', () => doUnban(''));
      if (refreshBtn) refreshBtn.addEventListener('click', reload);
      if (playersRefreshBtn) playersRefreshBtn.addEventListener('click', () => {
        if (window.Cloud) {
          Cloud.refresh().then(() => renderPlayers()).catch(() => renderPlayers());
        } else {
          renderPlayers();
        }
      });
      if (targetEl) {
        targetEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); doBan(); }
        });
      }
    }

    refreshAccess();
  }

  function onOpen() {
    init();
    const ok = refreshAccess();
    if (!ok) {
      setStatus('Панель доступна только администратору @' + ADMIN);
      return;
    }
    reload();
  }

  window.Admin = { init, onOpen, refreshAccess, reload };
})();
