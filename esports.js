'use strict';

/* ================= КИБЕРСПОРТ: Dota 2 / CS2 ================= */
/*
 * Данные: публичный API bo3.gg (актуальные матчи, команды, коэффициенты).
 * У API нет CORS, поэтому запрос идёт через публичный текстовый прокси
 * r.jina.ai, а при его недоступности — через запасные прокси.
 * Ставки — только виртуальные тугрики, как и во всём приложении.
 */
(function () {

  const API_V2 = 'https://api.bo3.gg/api/v2';
  const API_V1 = 'https://api.bo3.gg/api/v1';
  const CACHE_KEY = 'tugriki_esports_cache_v1';
  const BETS_KEY = 'tugriki_esports_bets_v1';
  const LAST_STAKE_KEY = 'tugriki_esports_last_stake_v1';
  const CACHE_TTL = 3 * 60 * 1000;

  const DISCIPLINES = {
    dota2: { id: 4, label: 'Dota 2', icon: '🛡️' },
    cs2: { id: 1, label: 'CS2', icon: '🔫' },
  };

  const CHIPS = [100, 500, 1000, 5000, 10000];

  let active = 'dota2';
  const loadingKeys = { dota2: false, cs2: false };
  let settling = false;
  let lastAutoSettle = 0;
  let currentMatch = null;
  let currentPick = 1;
  let lastLoaded = { dota2: null, cs2: null };
  let matchIndex = {};
  let bets = loadBets();
  const detailCache = new Map();

  const $ = (id) => document.getElementById(id);
  let listEl, emptyEl, syncEl, betsEl, tabsEl;
  let betModal, playerModal, sheetTitle, sheetSub, picksEl, stakeInput, stakeChips, placeBtn;
  let playerTitle, playerSub, playerFrame, playerLinks;

  /* ---------- Утилиты ---------- */
  const pad = (n) => (n < 10 ? '0' : '') + n;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const v = JSON.parse(raw);
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }

  function saveJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  function loadBets() {
    const v = readJson(BETS_KEY, []);
    return Array.isArray(v) ? v.filter(b => b && b.slug && b.stake > 0) : [];
  }

  function saveBets() {
    // не даём списку разрастаться
    bets = bets.slice(0, 30);
    saveJson(BETS_KEY, bets);
  }

  function utcDate(offsetDays) {
    const d = new Date(Date.now() + (offsetDays || 0) * 86400000);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  function initials(name) {
    const words = String(name || '?').replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/);
    return (words[0] ? words[0].charAt(0) : '?') + (words[1] ? words[1].charAt(0) : '');
  }

  function whenText(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return time;
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) + ', ' + time;
  }

  function fmtOdds(v) {
    const n = Number(v);
    if (!isFinite(n) || n < 1.01) return '';
    return (Math.round(n * 100) / 100).toFixed(2);
  }

  function statusText(text, mode) {
    if (!syncEl) return;
    const word = syncEl.querySelector('span:last-child');
    if (word) word.textContent = text;
    syncEl.classList.toggle('online', mode === 'online');
    syncEl.classList.toggle('offline', mode === 'offline');
  }

  /* ---------- Сеть ---------- */
  function parseJsonLoose(text) {
    if (!text) return null;
    let s = String(text).trim();
    const marker = 'Markdown Content:';
    const m = s.indexOf(marker);
    if (m >= 0) s = s.slice(m + marker.length).trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try { return JSON.parse(s); } catch (e) {}
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {}
    }
    return null;
  }

  async function fetchJson(target, timeout) {
    const ms = timeout || 14000;
    const encoded = encodeURIComponent(target);
    const urls = [
      'https://r.jina.ai/' + target,
      'https://api.allorigins.win/raw?url=' + encoded,
      target,
    ];
    let lastErr = null;

    for (const url of urls) {
      let ctrl = null;
      let timer = null;
      try {
        if (typeof AbortController !== 'undefined') {
          ctrl = new AbortController();
          timer = setTimeout(() => ctrl.abort(), ms);
        }
        const opts = { headers: { 'Accept': 'application/json, text/plain, */*' } };
        if (ctrl) opts.signal = ctrl.signal;
        const res = await fetch(url, opts);
        if (timer) { clearTimeout(timer); timer = null; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = parseJsonLoose(await res.text());
        if (data) return data;
        throw new Error('bad json');
      } catch (e) {
        lastErr = e;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw lastErr || new Error('network');
  }

  function normalizeMatch(m, included, forceLive) {
    if (!m) return null;
    const inc = included || {};
    const teams = inc.teams || {};
    const tours = inc.tournaments || {};
    const t1Id = m.team1 != null ? m.team1 : m.team1_id;
    const t2Id = m.team2 != null ? m.team2 : m.team2_id;
    const t1 = teams[t1Id] || teams[String(t1Id)] || {};
    const t2 = teams[t2Id] || teams[String(t2Id)] || {};
    const tr = tours[m.tournament] || tours[String(m.tournament)] || {};
    const bu = m.bet_updates || {};
    let o1 = bu.team_1 ? Number(bu.team_1.coeff) : 0;
    let o2 = bu.team_2 ? Number(bu.team_2.coeff) : 0;
    if (!isFinite(o1) || o1 < 1.01) o1 = 0;
    if (!isFinite(o2) || o2 < 1.01) o2 = 0;

    return {
      key: String(m.slug || m.id),
      id: m.id,
      slug: m.slug || '',
      start: m.start_date || '',
      startTs: Date.parse(m.start_date) || 0,
      status: String(m.status || '').toLowerCase(),
      live: !!forceLive || m.status === 'live' || m.status === 'running',
      bo: Number(m.bo_type) || 1,
      tier: String(m.tier || ''),
      stars: Number(m.stars) || 0,
      team1: {
        id: t1Id,
        name: t1.name || m.team1_name || 'TBD',
        logo: t1.image_versions && t1.image_versions['50x50'] ? t1.image_versions['50x50'] : (t1.image_url || ''),
      },
      team2: {
        id: t2Id,
        name: t2.name || m.team2_name || 'TBD',
        logo: t2.image_versions && t2.image_versions['50x50'] ? t2.image_versions['50x50'] : (t2.image_url || ''),
      },
      tournament: tr.name || m.tournament_name || 'Турнир',
      odds1: o1 || 1.9,
      odds2: o2 || 1.9,
      hasOdds: !!(o1 || o2),
    };
  }

  function normalizeTiers(tiers, included) {
    const out = [];
    ['high_tier', 'low_tier'].forEach(k => {
      const t = tiers && tiers[k];
      if (!t || !Array.isArray(t.matches)) return;
      t.matches.forEach(m => {
        const n = normalizeMatch(m, included, false);
        if (n) out.push(n);
      });
    });
    return out;
  }

  function mergeMatches(list) {
    const map = new Map();
    list.forEach(m => {
      if (!m) return;
      const old = map.get(m.key);
      if (!old) map.set(m.key, m);
      else if (m.hasOdds && !old.hasOdds) map.set(m.key, m);
      else if (m.live && !old.live) map.set(m.key, m);
    });
    return Array.from(map.values())
      .filter(m => m.team1.name !== 'TBD' || m.team2.name !== 'TBD')
      .sort((a, b) => {
        if (a.live !== b.live) return a.live ? -1 : 1;
        if (a.startTs !== b.startTs) return a.startTs - b.startTs;
        return b.stars - a.stars;
      });
  }

  async function fetchUpcoming(key, force) {
    const disc = DISCIPLINES[key];
    const cache = readJson(CACHE_KEY, {});
    const cached = cache[key];

    if (!force && cached && cached.ts && Date.now() - cached.ts < CACHE_TTL && Array.isArray(cached.list)) {
      return { list: cached.list, ts: cached.ts, cached: true };
    }

    let collected = [];
    let hadError = false;

    // 1) матчи, которые уже идут
    try {
      const live = await fetchJson(API_V2 + '/matches/live?filter[discipline_id][eq]=' + disc.id);
      if (live && Array.isArray(live.data)) {
        collected = collected.concat(live.data.map(m => normalizeMatch(m, live.included, true)).filter(Boolean));
      }
    } catch (e) { hadError = true; }

    // 2) ближайшие матчи: сегодня, если пусто — завтра
    const dates = [utcDate(0), utcDate(1)];
    for (const date of dates) {
      try {
        const url = API_V2 + '/matches/upcoming?filter[discipline_id][eq]=' + disc.id +
          '&date=' + date + '&utc_offset=0';
        const data = await fetchJson(url);
        if (data && data.data && data.data.tiers) {
          collected = collected.concat(normalizeTiers(data.data.tiers, data.included));
        }
      } catch (e) { hadError = true; }

      const merged = mergeMatches(collected);
      if (merged.length) break;
    }

    const list = mergeMatches(collected);

    if (list.length) {
      cache[key] = { ts: Date.now(), list: list };
      saveJson(CACHE_KEY, cache);
      return { list: list, ts: Date.now(), cached: false };
    }

    if (cached && Array.isArray(cached.list) && cached.list.length) {
      return { list: cached.list, ts: cached.ts, cached: true, stale: true };
    }

    if (hadError) throw new Error('network');
    return { list: [], ts: Date.now(), cached: false };
  }

  async function fetchMatchDetail(slug) {
    if (!slug) return null;
    if (detailCache.has(slug)) return detailCache.get(slug);
    const data = await fetchJson(API_V1 + '/matches/' + encodeURIComponent(slug));
    detailCache.set(slug, data);
    return data;
  }

  /* ---------- Рендер списка ---------- */
  function skeleton() {
    if (!listEl) return;
    listEl.innerHTML = '<div class="es-skeleton"></div><div class="es-skeleton"></div><div class="es-skeleton"></div>';
    if (emptyEl) emptyEl.classList.add('hidden');
  }

  function teamHtml(team, odds) {
    const logo = team.logo
      ? '<img src="' + esc(team.logo) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">'
      : '';
    return '<div class="es-team">' +
      '<div class="es-logo"><span>' + esc(initials(team.name)) + '</span>' + logo + '</div>' +
      '<div class="es-team-info"><b>' + esc(team.name) + '</b></div>' +
      (odds ? '<span class="es-odd">×' + fmtOdds(odds) + '</span>' : '') +
      '</div>';
  }

  function matchHtml(m) {
    const when = whenText(m.start);
    const tier = m.tier ? '<span class="es-tag">TIER ' + esc(m.tier.toUpperCase()) + '</span>' : '';
    const stars = m.stars >= 4 ? '<span class="es-tag hot">★ ПОПУЛЯРНЫЙ</span>' : '';
    const live = m.live ? '<span class="es-tag live">● LIVE</span>' : '';
    return '<article class="es-match' + (m.live ? ' is-live' : '') + '" data-key="' + esc(m.key) + '">' +
      '<div class="es-match-top">' +
        '<div class="es-tour"><span class="es-tour-name">' + esc(m.tournament) + '</span></div>' +
        '<div class="es-when">' + live + '<span>' + esc(when) + '</span></div>' +
      '</div>' +
      '<div class="es-teams">' +
        teamHtml(m.team1, m.odds1) +
        '<div class="es-vs">VS</div>' +
        teamHtml(m.team2, m.odds2) +
      '</div>' +
      '<div class="es-match-meta">' +
        '<span class="es-tag">BO' + m.bo + '</span>' + tier + stars +
        (m.hasOdds ? '<span class="es-tag odds">коэф. bo3.gg</span>' : '<span class="es-tag">коэф. виртуальный</span>') +
      '</div>' +
      '<div class="es-actions">' +
        '<button class="secondary-btn es-watch" data-act="watch">▶ Смотреть</button>' +
        '<button class="primary-btn es-bet" data-act="bet">Сделать ставку</button>' +
      '</div>' +
    '</article>';
  }

  function renderMatches(data) {
    if (!listEl) return;
    const list = (data && data.list) || [];
    matchIndex = {};
    list.forEach(m => { matchIndex[m.key] = m; });

    if (!list.length) {
      listEl.innerHTML = '';
      if (emptyEl) emptyEl.classList.remove('hidden');
      return;
    }
    if (emptyEl) emptyEl.classList.add('hidden');
    listEl.innerHTML = list.slice(0, 40).map(matchHtml).join('');
  }

  function renderLoading() {
    if (!listEl) return;
    skeleton();
  }

  async function loadDiscipline(key, force) {
    if (loadingKeys[key]) return;
    loadingKeys[key] = true;
    const disc = DISCIPLINES[key];
    statusText('Загружаем ' + disc.label + '…', 'loading');
    renderLoading();
    try {
      const data = await fetchUpcoming(key, force);
      lastLoaded[key] = data;
      if (key === active) {
        renderMatches(data);
        if (data.stale || data.cached) {
          const t = new Date(data.ts || Date.now());
          statusText('Кэш · ' + t.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) +
            ' · ' + data.list.length + ' матчей', 'offline');
        } else {
          statusText('Онлайн · ' + data.list.length + ' матчей', 'online');
        }
      }
    } catch (e) {
      if (key === active) {
        const cached = lastLoaded[key];
        if (cached && cached.list && cached.list.length) {
          renderMatches(cached);
          statusText('Нет сети · показан кэш', 'offline');
        } else {
          renderMatches({ list: [] });
          if (emptyEl) {
            emptyEl.classList.remove('hidden');
            emptyEl.innerHTML = 'Не удалось загрузить матчи.<br><small>Проверь интернет и нажми «Обновить».</small>';
          }
          statusText('Нет связи с bo3.gg', 'offline');
        }
      }
    } finally {
      loadingKeys[key] = false;
    }
  }

  /* ---------- Ставки ---------- */
  function renderBets() {
    if (!betsEl) return;
    if (!bets.length) {
      betsEl.innerHTML = '<p class="es-no-bets">Пока нет ставок. Выбери матч и команду — ставка появится здесь.</p>';
      return;
    }
    betsEl.innerHTML = bets.map(b => {
      let statusCls = 'open';
      let statusTxt = b.live ? 'в игре' : 'ждём результат';
      let amount = '−' + App.fmt(b.stake) + ' 🪙';
      if (b.status === 'won') {
        statusCls = 'won';
        statusTxt = 'выиграла';
        amount = '+' + App.fmt(b.payout || Math.floor(b.stake * b.odds)) + ' 🪙';
      } else if (b.status === 'lost') {
        statusCls = 'lost';
        statusTxt = 'не сыграла';
      } else if (b.status === 'refund') {
        statusCls = 'refund';
        statusTxt = 'возврат';
        amount = '+' + App.fmt(b.stake) + ' 🪙';
      }
      return '<div class="es-mybet ' + statusCls + '">' +
        '<div class="es-mybet-main">' +
          '<div class="es-mybet-pick">' + esc(b.pickName || '—') + '</div>' +
          '<div class="es-mybet-match">' + esc(b.team1Name || '') + ' vs ' + esc(b.team2Name || '') + '</div>' +
          '<div class="es-mybet-sub">' + esc(b.tournament || '') + ' · ×' + fmtOdds(b.odds) + '</div>' +
        '</div>' +
        '<div class="es-mybet-right">' +
          '<b>' + amount + '</b>' +
          '<span>' + statusTxt + '</span>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function updateStakeChips() {
    if (!stakeChips) return;
    stakeChips.innerHTML = CHIPS.map(v =>
      '<button class="es-stake-chip" data-stake="' + v + '">' + App.fmt(v) + '</button>'
    ).join('');
  }

  function setPick(pick) {
    currentPick = pick;
    if (!picksEl) return;
    picksEl.querySelectorAll('[data-pick]').forEach(b => {
      b.classList.toggle('active', Number(b.dataset.pick) === pick);
    });
  }

  function openBetSheet(m) {
    if (!betModal || !m) return;
    currentMatch = m;
    currentPick = 1;
    sheetTitle.textContent = m.team1.name + ' — ' + m.team2.name;
    sheetSub.textContent = m.tournament + ' · ' + whenText(m.start) + ' · BO' + m.bo +
      (m.hasOdds ? '' : ' · виртуальный коэф.');
    picksEl.innerHTML =
      '<button class="es-pick active" data-pick="1">' +
        '<span>' + esc(m.team1.name) + '</span><b>×' + fmtOdds(m.odds1) + '</b>' +
      '</button>' +
      '<button class="es-pick" data-pick="2">' +
        '<span>' + esc(m.team2.name) + '</span><b>×' + fmtOdds(m.odds2) + '</b>' +
      '</button>';
    updateStakeChips();

    let last = readJson(LAST_STAKE_KEY, 100);
    last = Math.max(App.CONFIG.minBet, Math.round((Number(last) || 100) / App.CONFIG.betStep) * App.CONFIG.betStep);
    if (last > App.State.balance) last = Math.max(App.CONFIG.minBet, Math.floor(App.State.balance / App.CONFIG.betStep) * App.CONFIG.betStep);
    stakeInput.value = String(last || App.CONFIG.minBet);

    betModal.classList.remove('hidden');
    betModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('es-modal-open');
    App.haptic('light');
  }

  function closeBetSheet() {
    if (!betModal) return;
    betModal.classList.add('hidden');
    betModal.setAttribute('aria-hidden', 'true');
    if (!playerModal || playerModal.classList.contains('hidden')) document.body.classList.remove('es-modal-open');
    currentMatch = null;
  }

  function placeBet() {
    if (!currentMatch) return;
    const m = currentMatch;
    const amount = Math.floor(Number(stakeInput.value) || 0);
    if (amount < App.CONFIG.minBet) {
      App.toast('Минимальная ставка — ' + App.fmt(App.CONFIG.minBet) + ' 🪙');
      return;
    }
    if (amount > App.State.balance) {
      App.toast('Недостаточно тугриков');
      return;
    }
    if (bets.some(b => b.matchKey === m.key && b.status === 'open')) {
      App.toast('На этот матч уже есть открытая ставка');
      return;
    }
    if (bets.filter(b => b.status === 'open').length >= 8) {
      App.toast('Слишком много открытых ставок — дождись расчёта');
      return;
    }

    const pickTeam = currentPick === 1 ? m.team1 : m.team2;
    const odds = currentPick === 1 ? m.odds1 : m.odds2;

    if (!App.takeBet(amount)) return;

    bets.unshift({
      matchKey: m.key,
      slug: m.slug,
      matchId: m.id,
      discipline: active,
      team1Name: m.team1.name,
      team2Name: m.team2.name,
      pickId: pickTeam.id,
      pickName: pickTeam.name,
      odds: Number(odds) || 1.9,
      stake: amount,
      live: !!m.live,
      tournament: m.tournament,
      start: m.start,
      placedAt: Date.now(),
      status: 'open',
    });
    saveBets();
    saveJson(LAST_STAKE_KEY, amount);
    renderBets();
    closeBetSheet();
    App.haptic('success');
    if (window.Sound) Sound.coin();
    App.toast('Ставка ' + App.fmt(amount) + ' 🪙 на ' + pickTeam.name + ' принята');
  }

  function resolveBet(b, detail) {
    if (!detail) return false;
    const status = String(detail.status || '').toLowerCase();
    if (['canceled', 'cancelled', 'deleted', 'postponed'].indexOf(status) >= 0) {
      App.addBalance(b.stake);
      b.status = 'refund';
      b.settledAt = Date.now();
      return true;
    }
    const winner = Number(detail.winner_team_id || detail.winner_id || 0);
    if (!winner) return false;
    const pickId = Number(b.pickId);
    if (winner === pickId) {
      const payout = Math.max(b.stake, Math.floor(b.stake * (Number(b.odds) || 1.9)));
      App.addBalance(payout);
      b.status = 'won';
      b.payout = payout;
      App.toast('Ставка сыграла: +' + App.fmt(payout - b.stake) + ' 🪙 · ' + b.pickName);
      App.haptic('success');
      if (window.Sound) Sound.win(payout >= b.stake * 2 ? 'big' : 'normal');
    } else {
      b.status = 'lost';
      App.toast('Ставка не сыграла: ' + b.pickName);
      App.haptic('error');
    }
    b.settledAt = Date.now();
    return true;
  }

  async function settleBets(manual) {
    if (settling) return;
    const open = bets.filter(b => b.status === 'open' && b.slug);
    if (!open.length) {
      if (manual) App.toast('Открытых ставок нет');
      return;
    }
    settling = true;
    if (manual) {
      statusText('Проверяем результаты…', 'loading');
      App.toast('Проверяем результаты…');
    }
    let changed = 0;
    for (const b of open.slice(0, 8)) {
      try {
        const detail = await fetchMatchDetail(b.slug);
        if (resolveBet(b, detail)) changed++;
      } catch (e) {
        // сеть/прокси недоступны — ставка останется открытой
      }
    }
    if (changed) {
      saveBets();
      renderBets();
    }
    settling = false;
    if (manual) {
      statusText(changed ? 'Результаты обновлены' : 'Пока нет результатов', changed ? 'online' : 'offline');
      if (!changed) App.toast('Результатов пока нет — матч ещё не завершён');
    }
    lastAutoSettle = Date.now();
  }

  /* ---------- Плеер ---------- */
  function closePlayer() {
    if (!playerModal) return;
    playerModal.classList.add('hidden');
    playerModal.setAttribute('aria-hidden', 'true');
    if (playerFrame) playerFrame.innerHTML = '';
    if (playerLinks) playerLinks.innerHTML = '';
    document.body.classList.remove('es-modal-open');
    if (window.Sound) Sound.resumeMusic();
  }

  function embedSrc(raw) {
    let u = String(raw || '');
    if (!/^https?:\/\//i.test(u)) return '';

    // Приводим ссылки YouTube к формату встраиваемого плеера
    const yt =
      (u.match(/youtube\.com\/watch\?(?:[^#]*&)?v=([\w-]{6,})/i) || [])[1] ||
      (u.match(/youtube\.com\/live\/([\w-]{6,})/i) || [])[1] ||
      (u.match(/youtu\.be\/([\w-]{6,})/i) || [])[1] ||
      '';
    if (yt) u = 'https://www.youtube.com/embed/' + yt;

    if (/player\.twitch\.tv/i.test(u)) {
      const host = location.hostname || 'localhost';
      u += (u.indexOf('?') >= 0 ? '&' : '?') + 'parent=' + encodeURIComponent(host);
      if (host !== 'localhost') u += '&parent=localhost';
      u += '&muted=true&autoplay=false';
    } else if (/youtube\.com\/embed/i.test(u)) {
      u += (u.indexOf('?') >= 0 ? '&' : '?') + 'autoplay=0&rel=0';
    }
    return u;
  }

  async function openPlayer(m) {
    if (!playerModal || !m) return;
    playerTitle.textContent = m.team1.name + ' — ' + m.team2.name;
    playerSub.textContent = m.tournament + ' · ' + whenText(m.start);
    playerFrame.innerHTML = '<div class="es-loader"><i></i><span>Ищем трансляцию…</span></div>';
    playerLinks.innerHTML = '';
    playerModal.classList.remove('hidden');
    playerModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('es-modal-open');
    if (window.Sound) Sound.pauseMusic();
    App.haptic('light');

    const matchLink = 'https://bo3.gg/matches/' + encodeURIComponent(m.slug);
    let detail = null;
    try { detail = await fetchMatchDetail(m.slug); } catch (e) {}

    if (!playerModal.classList.contains('hidden')) {
      if (!detail) {
        playerFrame.innerHTML = '<div class="es-player-empty">Не удалось получить данные трансляции.<br><small>Проверь интернет и попробуй ещё раз.</small></div>';
      } else {
        const streams = (detail.streams || []).filter(s => s && s.embed_url && !s.blocked);
        const twitch = streams.filter(s => /player\.twitch\.tv/i.test(s.embed_url));
        const youtube = streams.filter(s => /youtube/i.test(s.embed_url));
        const pick = twitch.find(s => s.official) || twitch[0] || youtube[0] || streams[0];
        if (pick) {
          const src = embedSrc(pick.embed_url);
          if (src) {
            playerFrame.innerHTML = '<iframe src="' + esc(src) + '" title="Трансляция матча" ' +
              'allowfullscreen allow="autoplay; fullscreen; picture-in-picture" ' +
              'referrerpolicy="no-referrer-when-downgrade"></iframe>';
          } else {
            playerFrame.innerHTML = '<div class="es-player-empty">Трансляция недоступна в этом окне.</div>';
          }
        } else {
          playerFrame.innerHTML = '<div class="es-player-empty">Официальная трансляция пока не найдена.<br><small>Можно открыть страницу матча на bo3.gg.</small></div>';
        }
        const links = ['<a class="secondary-btn" href="' + esc(matchLink) + '" target="_blank" rel="noopener">Матч на bo3.gg ↗</a>'];
        if (pick && pick.raw_url) {
          links.unshift('<a class="secondary-btn" href="' + esc(pick.raw_url) + '" target="_blank" rel="noopener">Открыть трансляцию ↗</a>');
        }
        playerLinks.innerHTML = links.join('');
      }
    }
  }

  /* ---------- Инициализация ---------- */
  function switchTab(key) {
    if (!DISCIPLINES[key]) return;
    active = key;
    if (tabsEl) {
      tabsEl.querySelectorAll('[data-es]').forEach(b => {
        const on = b.dataset.es === key;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }
    const cached = lastLoaded[key];
    if (cached && cached.list) {
      renderMatches(cached);
      const t = new Date(cached.ts || Date.now());
      statusText((cached.cached || cached.stale ? 'Кэш · ' : 'Онлайн · ') + t.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) +
        ' · ' + cached.list.length + ' матчей', cached.cached || cached.stale ? 'offline' : 'online');
    } else {
      matchIndex = {};
      if (listEl) listEl.innerHTML = '';
      if (emptyEl) emptyEl.classList.add('hidden');
      renderLoading();
      statusText('Загружаем ' + DISCIPLINES[key].label + '…', 'loading');
    }
    loadDiscipline(key, false);
    App.haptic('light');
  }

  function onOpen() {
    const cached = lastLoaded[active];
    if (!cached) {
      loadDiscipline(active, false);
    } else if (Date.now() - (cached.ts || 0) > CACHE_TTL) {
      loadDiscipline(active, false);
    } else {
      renderMatches(cached);
    }
    if (bets.some(b => b.status === 'open') && Date.now() - lastAutoSettle > 120000) {
      settleBets(false);
    }
  }

  function init() {
    listEl = $('esList');
    emptyEl = $('esEmpty');
    syncEl = $('esSync');
    betsEl = $('esBetList');
    tabsEl = $('esTabs');
    if (!listEl) return;

    betModal = $('esBetModal');
    playerModal = $('esPlayerModal');
    sheetTitle = $('esSheetTitle');
    sheetSub = $('esSheetSub');
    picksEl = $('esPicks');
    stakeInput = $('esStakeInput');
    stakeChips = $('esStakeChips');
    placeBtn = $('esPlaceBet');
    playerTitle = $('esPlayerTitle');
    playerSub = $('esPlayerSub');
    playerFrame = $('esPlayerFrame');
    playerLinks = $('esPlayerLinks');

    bets = loadBets();
    renderBets();
    updateStakeChips();

    if (tabsEl) {
      tabsEl.addEventListener('click', (e) => {
        const b = e.target.closest('[data-es]');
        if (b) switchTab(b.dataset.es);
      });
    }

    listEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const card = btn.closest('[data-key]');
      const m = card ? matchIndex[card.dataset.key] : null;
      if (!m) return;
      if (btn.dataset.act === 'bet') openBetSheet(m);
      else openPlayer(m);
    });

    const refreshBtn = $('esRefresh');
    if (refreshBtn) refreshBtn.addEventListener('click', () => {
      if (loadingKeys[active]) return;
      lastLoaded[active] = null;
      loadDiscipline(active, true);
      App.haptic('light');
    });

    const settleBtn = $('esSettleBtn');
    if (settleBtn) settleBtn.addEventListener('click', () => settleBets(true));

    if (picksEl) picksEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (b) { setPick(Number(b.dataset.pick)); App.haptic('light'); }
    });

    if (stakeChips) stakeChips.addEventListener('click', (e) => {
      const b = e.target.closest('[data-stake]');
      if (!b) return;
      stakeInput.value = b.dataset.stake;
      App.haptic('light');
    });

    const maxBtn = $('esStakeMax');
    if (maxBtn) maxBtn.addEventListener('click', () => {
      const step = App.CONFIG.betStep;
      const max = Math.floor(App.State.balance / step) * step;
      stakeInput.value = String(Math.max(App.CONFIG.minBet, max));
      App.haptic('light');
    });

    if (placeBtn) placeBtn.addEventListener('click', () => {
      placeBet();
      App.haptic('light');
    });

    document.querySelectorAll('[data-es-close]').forEach(el => {
      el.addEventListener('click', () => {
        const what = el.dataset.esClose;
        if (what === 'player') closePlayer();
        else closeBetSheet();
      });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (playerModal && !playerModal.classList.contains('hidden')) closePlayer();
      else if (betModal && !betModal.classList.contains('hidden')) closeBetSheet();
    });

    window.addEventListener('screenchange', (e) => {
      if (e.detail && e.detail.screen !== 'esports') {
        closePlayer();
        closeBetSheet();
      }
    });

    renderBets();
  }

  window.Esports = { init, onOpen, openPlayer, settleBets };
})();
