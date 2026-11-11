'use strict';

/* ================= ОБЛАКО LoseLine ================= */
/*
 * Общее (глобальное) состояние игры хранится в публичном текстовом
 * хранилище textdb.online.
 *
 * Приватность (best-effort, без собственного сервера):
 *   • ключи аккаунтов, кошельков и банов строятся от SHA-256 хеша
 *     Telegram ID (или @username), а не от открытого ID;
 *   • @username и причины банов не пишутся открытым текстом — они
 *     лежат в служебных полях в обфусцированном виде;
 *   • в публичной записи нет ни одного открытого Telegram ID.
 *
 * Это именно псевдонимизация и обфускация, а НЕ криптографическая
 * защита: TextDB публичный, код клиента открыт, запись неатомарная.
 * Для настоящей защиты нужен собственный сервер с проверкой initData.
 *
 * Схема документа:
 * {
 *   version: 2,
 *   updatedAt: <ms>,
 *   promos:   { "LOSE-30M-XXXXX": { by: "h:<hash>", at } },
 *   bans:     { "h:<hash>": { k, at, p: "<служебные данные>" } },
 *   accounts: { "h:<hash>": { h, u, at, p: "<служебные данные>" } }
 * }
 *
 * Баланс, банк и кулдаун бонуса хранятся в отдельной записи TextDB
 * на каждый аккаунт (см. walletKey). Так телефон и компьютер с одним
 * Telegram-аккаунтом видят один и тот же кошелёк.
 */
(function () {

  const KEY = 'loseline-cloud-v2-msztw3jixe85';
  const READ_URL = 'https://textdb.online/' + KEY;
  const WRITE_URL = 'https://textdb.online/update/?key=' + KEY;
  const WALLET_PREFIX = 'loseline-wallet-v2-';
  const LEGACY_WALLET_PREFIX = 'loseline-wallet-v1-';
  const LEGACY_CLOUD_KEY = 'loseline-cloud-v1-msztw3jixe85';
  const TIMEOUT_MS = 10000;
  const DEVICE_KEY = 'loseline_device_id_v1';
  const ADMIN_USERNAME = 'gusisurkovuch';
  const BAN_POLL_MS = 90000;
  const BAN_FOCUS_THROTTLE_MS = 25000;

  const PROMO_REWARD = 30000000;

  /* Соль не является секретом: она нужна, чтобы один и тот же ID
     не давал одинаковый хеш в разных копиях приложения. */
  const ID_SALT = 'LoseLine::identity::v2::6f2c9a41';
  const META_SECRET = 'LoseLine::service-meta::v2::b37e1d80';

  function emptyData() {
    return { version: 2, updatedAt: 0, promos: {}, bans: {}, accounts: {} };
  }

  const state = {
    data: emptyData(),
    loaded: false,
    fetchedAt: 0,
    lastError: '',
    banned: null,
    checkAt: 0,
    timer: null,
  };

  /* ---------- SHA-256 (синхронный, без WebCrypto) ---------- */
  const SHA_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(str));
    const s = unescape(encodeURIComponent(String(str)));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function utf8String(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(s));
  }

  function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  function bytesToHex(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
    return s;
  }

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  function sha256(input) {
    const bytes = (typeof input === 'string') ? utf8Bytes(input) : input;
    const len = bytes.length;
    const bitLen = len * 8;
    const total = (((len + 1 + 8) + 63) >> 6) << 6;
    const buf = new Uint8Array(total);
    buf.set(bytes);
    buf[len] = 0x80;
    const view = new DataView(buf.buffer);
    view.setUint32(total - 8, Math.floor(bitLen / 0x100000000));
    view.setUint32(total - 4, bitLen >>> 0);

    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Uint32Array(64);

    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }

      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ ((~e) & g);
        const t1 = (h + S1 + ch + SHA_K[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }

    return [h0, h1, h2, h3, h4, h5, h6, h7]
      .map((x) => x.toString(16).padStart(8, '0')).join('');
  }

  function randomHex(n) {
    const bytes = new Uint8Array(n);
    try {
      if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
      else throw new Error('no-crypto');
    } catch (e) {
      for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return bytesToHex(bytes);
  }

  function bytesToB64(bytes) {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
  }

  function b64ToBytes(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  /**
   * Служебные данные (username, ID, причина бана) не пишутся открытым
   * текстом. Это обфускация с общим ключом из кода — не более.
   */
  function encodeMeta(obj) {
    const data = utf8Bytes(JSON.stringify(obj || {}));
    const nonce = randomHex(6);
    const key = hexToBytes(sha256(META_SECRET + '|' + nonce));
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = data[i] ^ key[i % key.length];
    return nonce + '.' + bytesToB64(out);
  }

  function decodeMeta(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    const s = String(value);
    const dot = s.indexOf('.');
    if (dot < 0) return null;
    try {
      const nonce = s.slice(0, dot);
      const data = b64ToBytes(s.slice(dot + 1));
      const key = hexToBytes(sha256(META_SECRET + '|' + nonce));
      const out = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) out[i] = data[i] ^ key[i % key.length];
      return JSON.parse(utf8String(out));
    } catch (e) { return null; }
  }

  /* ---------- Идентификация ---------- */
  function isLocalDev() {
    try {
      const loc = window.location;
      if (!loc) return false;
      return loc.protocol === 'file:' ||
        loc.hostname === 'localhost' ||
        loc.hostname === '127.0.0.1' ||
        loc.hostname === '::1';
    } catch (e) { return false; }
  }

  function tgUser() {
    // Отладочная подмена работает только локально: на опубликованном сайте
    // нельзя получить права администратора, просто выставив это поле в консоли.
    if (isLocalDev() && typeof window !== 'undefined' && window.LOSELINE_DEV_USER) {
      return window.LOSELINE_DEV_USER;
    }
    try {
      const tg = window.Telegram && window.Telegram.WebApp;
      return (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) || null;
    } catch (e) { return null; }
  }

  function username() {
    const u = tgUser();
    return u && u.username ? String(u.username).replace(/^@/, '').toLowerCase() : '';
  }

  function userId() {
    const u = tgUser();
    return u && u.id != null ? String(u.id) : '';
  }

  function deviceId() {
    try {
      let v = localStorage.getItem(DEVICE_KEY);
      if (!v) {
        v = 'd_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
        localStorage.setItem(DEVICE_KEY, v);
      }
      return v;
    } catch (e) { return 'd_unknown'; }
  }

  function hashId(id) {
    const clean = String(id || '').replace(/[^0-9]/g, '');
    if (!clean) return '';
    return sha256(ID_SALT + '|id|' + clean).slice(0, 32);
  }

  function hashName(name) {
    const clean = String(name || '').replace(/^@/, '').replace(/[^a-z0-9_]/gi, '').toLowerCase();
    if (!clean) return '';
    return sha256(ID_SALT + '|u|' + clean).slice(0, 32);
  }

  function hashDevice() {
    return sha256(ID_SALT + '|d|' + deviceId()).slice(0, 32);
  }

  /** Стабильный ключ игрового аккаунта: хеш Telegram ID, затем username, затем устройство. */
  function accountKey() {
    const id = userId();
    if (id) return 'h:' + hashId(id);
    const uname = username();
    if (uname) return 'hu:' + hashName(uname);
    return 'dv:' + hashDevice();
  }

  /** Все варианты ключей одного аккаунта — для банов и старых записей. */
  function identityKeys() {
    const keys = [];
    const id = userId();
    const uname = username();
    if (id) keys.push('h:' + hashId(id));
    if (uname) keys.push('hu:' + hashName(uname));
    keys.push('dv:' + hashDevice());
    return keys.filter((k, i) => k && keys.indexOf(k) === i);
  }

  /** Приводит старый ключ (id:123, u:name) к псевдонимному виду. */
  function canonicalKey(value) {
    const s = String(value == null ? '' : value).trim();
    if (!s) return '';
    if (/^h:[0-9a-f]{32}$/i.test(s)) return 'h:' + s.slice(2).toLowerCase();
    if (/^hu:[0-9a-f]{32}$/i.test(s)) return 'hu:' + s.slice(3).toLowerCase();
    if (/^dv:[0-9a-f]{32}$/i.test(s)) return 'dv:' + s.slice(3).toLowerCase();
    let m = s.match(/^(?:id|tg)[:_-]?(\d{4,})$/i);
    if (m) return 'h:' + hashId(m[1]);
    m = s.match(/^u:(.+)$/i);
    if (m) return 'hu:' + hashName(m[1]);
    if (/^\d{4,}$/.test(s)) return 'h:' + hashId(s);
    return s;
  }

  function sameAccount(value) {
    return identityKeys().indexOf(canonicalKey(value)) >= 0;
  }

  /* ---------- Кошельки ---------- */
  function walletKeyForHash(hash) {
    const h = String(hash || '').toLowerCase();
    return /^[0-9a-f]{32}$/.test(h) ? (WALLET_PREFIX + 'h-' + h) : '';
  }

  /** Ключ личного облачного кошелька (общий для телефона и ПК). */
  function walletKey() {
    const id = userId();
    if (id) return walletKeyForHash(hashId(id));
    const uname = username();
    if (uname) return walletKeyForHash(hashName(uname));
    return WALLET_PREFIX + 'd-' + hashDevice();
  }

  /** Кошелёк по ID или username (для админ-панели). */
  function walletKeyFor(id, uname) {
    const idHash = id ? hashId(id) : '';
    if (idHash) return walletKeyForHash(idHash);
    const nameHash = uname ? hashName(uname) : '';
    if (nameHash) return walletKeyForHash(nameHash);
    return '';
  }

  /** Старые открытые ключи — только для мягкой миграции. */
  function legacyWalletKeys() {
    const out = [];
    const id = userId();
    const uname = username();
    if (id) out.push(LEGACY_WALLET_PREFIX + 'id-' + id);
    if (uname) out.push(LEGACY_WALLET_PREFIX + 'u-' + uname);
    return out;
  }

  function legacyWalletKeysFor(id, uname) {
    const out = [];
    if (id) out.push(LEGACY_WALLET_PREFIX + 'id-' + String(id).replace(/[^0-9]/g, ''));
    if (uname) out.push(LEGACY_WALLET_PREFIX + 'u-' + String(uname).replace(/^@/, '').toLowerCase());
    return out;
  }

  function canSyncWallet() {
    return !!(userId() || username());
  }

  function accountLabel() {
    const uname = username();
    if (uname) return '@' + uname;
    const id = userId();
    if (id) return 'Telegram ID ' + id;
    return 'локальный профиль';
  }

  function isAdmin() {
    return username() === ADMIN_USERNAME;
  }

  function isBanned() {
    return !!state.banned;
  }

  function banEntry() {
    return state.banned;
  }

  /* ---------- Сеть ---------- */
  async function request(url, opts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, Object.assign({
        cache: 'no-store',
        signal: controller.signal,
      }, opts || {}));
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------- Нормализация ---------- */
  function accountKeyFromEntry(rawKey, item) {
    if (item && item.id) return 'h:' + hashId(item.id);
    if (item && item.h && /^[0-9a-f]{32}$/i.test(item.h)) return 'h:' + item.h.toLowerCase();
    const ck = canonicalKey(rawKey);
    if (ck.indexOf('h:') === 0) return ck;
    if (item && item.username) return 'hu:' + hashName(item.username);
    if (item && item.u && /^[0-9a-f]{32}$/i.test(item.u)) return 'hu:' + item.u.toLowerCase();
    return ck;
  }

  function normalize(raw) {
    const d = emptyData();
    if (!raw || typeof raw !== 'object') return d;
    d.version = 2;
    d.updatedAt = Number(raw.updatedAt) || 0;

    if (raw.promos && typeof raw.promos === 'object') {
      Object.keys(raw.promos).forEach((code) => {
        const item = raw.promos[code];
        if (!item || typeof item !== 'object') return;
        const key = String(code).toUpperCase().replace(/\s+/g, '').slice(0, 40);
        if (!key) return;
        const by = canonicalKey(item.by);
        d.promos[key] = { by: by || '', at: Number(item.at) || 0 };
        if (item.username) d._legacy = true;
        if (item.by && by !== String(item.by)) d._legacy = true;
      });
    }

    if (raw.bans && typeof raw.bans === 'object') {
      Object.keys(raw.bans).forEach((rawKey) => {
        const item = raw.bans[rawKey];
        if (!item || typeof item !== 'object') return;
        let key = canonicalKey(rawKey);
        if (item.id) key = 'h:' + hashId(item.id);
        if (!key) return;
        const p = item.p ? String(item.p).slice(0, 4000) : encodeMeta({
          reason: String(item.reason || '').slice(0, 240),
          by: String(item.by || '').slice(0, 40),
        });
        if (!item.p) d._legacy = true;
        const at = Number(item.at) || 0;
        const prev = d.bans[key];
        if (!prev || at >= (prev.at || 0)) d.bans[key] = { k: key, at, p };
      });
    }

    if (raw.accounts && typeof raw.accounts === 'object') {
      Object.keys(raw.accounts).forEach((rawKey) => {
        const item = raw.accounts[rawKey];
        if (!item || typeof item !== 'object') return;
        const key = accountKeyFromEntry(rawKey, item);
        if (!key) return;
        const h = (item.h && /^[0-9a-f]{32}$/i.test(item.h))
          ? item.h.toLowerCase()
          : (item.id ? hashId(item.id) : (key.indexOf('h:') === 0 ? key.slice(2) : ''));
        const u = (item.u && /^[0-9a-f]{32}$/i.test(item.u))
          ? item.u.toLowerCase()
          : ((item.username || (rawKey.indexOf('u:') === 0 ? rawKey.slice(2) : ''))
            ? hashName(item.username || rawKey.slice(2)) : '');
        const p = item.p ? String(item.p).slice(0, 4000) : encodeMeta({
          id: String(item.id || '').slice(0, 40),
          username: String(item.username || '').replace(/^@/, '').toLowerCase().slice(0, 32),
        });
        if (!item.p) d._legacy = true;
        const at = Number(item.at) || 0;
        const prev = d.accounts[key];
        if (!prev) {
          d.accounts[key] = { h, u, at, p };
        } else {
          const prevMeta = decodeMeta(prev.p) || {};
          const nextMeta = decodeMeta(p) || {};
          const merged = {
            h: h || prev.h || '',
            u: u || prev.u || '',
            at: Math.max(at, prev.at || 0),
            p: (nextMeta.id && !prevMeta.id) || (nextMeta.username && !prevMeta.username) ||
               at >= (prev.at || 0) ? p : prev.p,
          };
          d.accounts[key] = merged;
        }
      });
    }

    return d;
  }

  function cleanForWrite(data) {
    const out = {
      version: 2,
      updatedAt: Number(data && data.updatedAt) || Date.now(),
      promos: {},
      bans: {},
      accounts: {},
    };
    const promos = (data && data.promos) || {};
    Object.keys(promos).forEach((code) => {
      const item = promos[code];
      if (!item) return;
      out.promos[String(code).toUpperCase().slice(0, 40)] = {
        by: canonicalKey(item.by),
        at: Number(item.at) || 0,
      };
    });
    const bans = (data && data.bans) || {};
    Object.keys(bans).forEach((key) => {
      const item = bans[key];
      if (!item) return;
      const ck = canonicalKey(item.k || key);
      if (!ck) return;
      out.bans[ck] = {
        k: ck,
        at: Number(item.at) || 0,
        p: String(item.p || '').slice(0, 4000),
      };
    });
    const accounts = (data && data.accounts) || {};
    Object.keys(accounts).forEach((key) => {
      const item = accounts[key];
      if (!item) return;
      const ck = canonicalKey(itemKey(item, key));
      if (!ck) return;
      out.accounts[ck] = {
        h: String(item.h || (ck.indexOf('h:') === 0 ? ck.slice(2) : '')).toLowerCase().slice(0, 32),
        u: String(item.u || '').toLowerCase().slice(0, 32),
        at: Number(item.at) || 0,
        p: String(item.p || '').slice(0, 4000),
      };
    });
    return out;
  }

  function itemKey(item, fallback) {
    if (!item) return fallback;
    if (item.id) return 'h:' + hashId(item.id);
    if (item.h && /^[0-9a-f]{32}$/i.test(item.h)) return 'h:' + item.h.toLowerCase();
    if (item.u && /^[0-9a-f]{32}$/i.test(item.u)) return 'hu:' + item.u.toLowerCase();
    return fallback;
  }

  async function fetchData() {
    const res = await request(READ_URL + '?t=' + Date.now() + '&r=' + Math.random().toString(36).slice(2));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = (await res.text()).trim();
    if (!text) return emptyData();
    try {
      return normalize(JSON.parse(text));
    } catch (e) {
      throw new Error('bad-json');
    }
  }

  async function writeData(data) {
    const body = 'value=' + encodeURIComponent(JSON.stringify(cleanForWrite(data)));
    const res = await request(WRITE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = (await res.text()).trim();
    if (text) {
      try {
        const out = JSON.parse(text);
        if (out && out.status === 0) throw new Error('write-rejected');
      } catch (e) {
        if (e && e.message === 'write-rejected') throw e;
      }
    }
    return true;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- Личный кошелёк (баланс + банк + бонус) ---------- */
  function walletUrl(key) {
    return 'https://textdb.online/' + key;
  }

  function walletWriteUrl(key) {
    return 'https://textdb.online/update/?key=' + key;
  }

  function normalizeWallet(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const balance = Math.floor(Number(raw.balance));
    const bank = Math.floor(Number(raw.bank));
    if (!isFinite(balance) || !isFinite(bank)) return null;
    return {
      v: Number(raw.v) || 1,
      balance: Math.max(0, balance),
      bank: Math.max(0, bank),
      lastBonus: Math.max(0, Math.floor(Number(raw.lastBonus) || 0)),
      updatedAt: Math.max(0, Math.floor(Number(raw.updatedAt) || 0)),
    };
  }

  async function readWalletByKey(key, opts) {
    if (!key) return null;
    const res = await request(
      walletUrl(key) + '?t=' + Date.now() + '&r=' + Math.random().toString(36).slice(2),
      opts
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = (await res.text()).trim();
    if (!text) return null;
    try {
      return normalizeWallet(JSON.parse(text));
    } catch (e) {
      throw new Error('bad-wallet-json');
    }
  }

  async function readFirstWallet(keys, opts) {
    for (const key of keys) {
      if (!key) continue;
      try {
        const w = await readWalletByKey(key, opts);
        if (w) return Object.assign(w, { _key: key });
      } catch (e) { /* пробуем следующий ключ */ }
    }
    return null;
  }

  async function readWallet(opts) {
    if (!canSyncWallet()) return null;
    return readFirstWallet([walletKey()].concat(legacyWalletKeys()), opts);
  }

  /** Кошелёк любого игрока — для админ-панели. */
  async function readWalletFor(player, uname) {
    if (player && typeof player === 'object') {
      const keys = [];
      if (player.h) keys.push(walletKeyForHash(player.h));
      if (player.u) keys.push(walletKeyForHash(player.u));
      if (player.id) keys.push(walletKeyForHash(hashId(player.id)));
      if (player.username) keys.push(walletKeyForHash(hashName(player.username)));
      keys.push(...legacyWalletKeysFor(player.id, player.username));
      return readFirstWallet(keys.filter((k, i) => k && keys.indexOf(k) === i));
    }
    const key = walletKeyFor(player, uname);
    if (!key) return null;
    return readFirstWallet([key].concat(legacyWalletKeysFor(player, uname)));
  }

  async function writeWallet(wallet, opts) {
    if (!canSyncWallet()) return false;
    const key = walletKey();
    const body = 'value=' + encodeURIComponent(JSON.stringify(wallet));
    const res = await request(walletWriteUrl(key), Object.assign({
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }, opts || {}));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = (await res.text()).trim();
    if (text) {
      try {
        const out = JSON.parse(text);
        if (out && out.status === 0) throw new Error('write-rejected');
      } catch (e) {
        if (e && e.message === 'write-rejected') throw e;
      }
    }
    return true;
  }

  /* Очередь изменений: два одновременных read→write не должны затирать друг друга. */
  let chain = Promise.resolve();
  function mutate(fn) {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  }

  /* ---------- Бан-оверлей ---------- */
  function showBanOverlay(entry) {
    const box = document.getElementById('banOverlay');
    if (box) {
      const reason = document.getElementById('banReason');
      if (reason) {
        const why = entry && entry.reason ? entry.reason : 'Причина не указана';
        reason.textContent = 'Причина: ' + why;
      }
      const who = document.getElementById('banTarget');
      if (who) who.textContent = (entry && entry.target) ? String(entry.target) : '';
      box.classList.remove('hidden');
    }
    if (window.SlotsGame && window.SlotsGame.stopAuto) {
      try { window.SlotsGame.stopAuto(); } catch (e) {}
    }
    if (window.Runner && window.Runner.pauseGame) {
      try { window.Runner.pauseGame(true); } catch (e) {}
    }
  }

  function hideBanOverlay() {
    const box = document.getElementById('banOverlay');
    if (box) box.classList.add('hidden');
  }

  function updateBan() {
    const keys = identityKeys().slice();

    // Если игрок уже есть в accounts под своим хешем — добавляем и его ключ.
    Object.keys(state.data.accounts || {}).forEach((k) => {
      const acc = state.data.accounts[k];
      if (!acc) return;
      if (keys.indexOf(k) >= 0) return;
      if (keys.some((ik) => {
        if (ik.indexOf('h:') === 0) return acc.h === ik.slice(2);
        if (ik.indexOf('hu:') === 0) return acc.u === ik.slice(3);
        return false;
      })) keys.push(k);
    });

    let found = null;
    for (const k of keys) {
      const ban = state.data.bans && state.data.bans[k];
      if (ban) {
        const meta = decodeMeta(ban.p) || {};
        found = Object.assign({}, ban, {
          key: k,
          reason: String(meta.reason || '').slice(0, 240),
          by: String(meta.by || '').slice(0, 40),
          target: targetLabel(k),
        });
        break;
      }
    }
    state.banned = found || null;
    if (found) showBanOverlay(found);
    else hideBanOverlay();
    return state.banned;
  }

  /* ---------- Чтение ---------- */
  function registerAccountIn(data) {
    if (!data || !data.accounts) return false;
    const id = userId();
    const uname = username();
    if (!id && !uname) return false;

    const at = Date.now();
    let changed = false;
    const key = accountKey();
    const h = id ? hashId(id) : '';
    const u = uname ? hashName(uname) : '';
    const cur = data.accounts[key];

    if (!cur) {
      data.accounts[key] = {
        h, u, at,
        p: encodeMeta({ id, username: uname }),
      };
      changed = true;
    } else {
      const meta = decodeMeta(cur.p) || {};
      if ((h && cur.h !== h) || (u && cur.u !== u) || !cur.p ||
          String(meta.id || '') !== String(id) ||
          String(meta.username || '') !== String(uname)) {
        data.accounts[key] = {
          h: h || cur.h || '',
          u: u || cur.u || '',
          at,
          p: encodeMeta({ id, username: uname }),
        };
        changed = true;
      }
    }

    // Если ID стал известен, переносим username-запись и username-бан на ID-хеш.
    if (id && uname) {
      const nameKey = 'hu:' + u;
      if (data.accounts[nameKey] && nameKey !== key) {
        const old = data.accounts[nameKey];
        if (!data.accounts[key]) data.accounts[key] = old;
        delete data.accounts[nameKey];
        changed = true;
      }
      if (data.bans[nameKey] && !data.bans['h:' + h]) {
        data.bans['h:' + h] = data.bans[nameKey];
        delete data.bans[nameKey];
        changed = true;
      }
    }

    return changed;
  }

  let cleanupScheduled = false;

  async function refresh() {
    const data = await fetchData();
    state.data = data;
    state.loaded = true;
    state.fetchedAt = Date.now();
    state.lastError = '';
    updateBan();

    const needsCleanup = !!data._legacy;
    const changed = registerAccountIn(data);

    // Первый вход с нового устройства или старый формат: записываем
    // псевдонимную запись и заодно вычищаем открытые ID/username из облака.
    if (changed || needsCleanup) {
      if (!cleanupScheduled) {
        cleanupScheduled = true;
        mutate(async () => {
          let fresh;
          try { fresh = await fetchData(); } catch (e) { cleanupScheduled = false; return; }
          const again = registerAccountIn(fresh) || !!fresh._legacy;
          if (!again) {
            state.data = fresh;
            state.loaded = true;
            state.fetchedAt = Date.now();
            updateBan();
            cleanupScheduled = false;
            return;
          }
          fresh.updatedAt = Date.now();
          try { await writeData(fresh); } catch (e) { cleanupScheduled = false; return; }
          state.data = normalize(fresh);
          state.loaded = true;
          state.fetchedAt = Date.now();
          updateBan();
          cleanupScheduled = false;
        }).catch(() => { cleanupScheduled = false; });
      }
    }

    return data;
  }

  /** Все известные игроки: псевдонимный ключ, ID, @username, время, бан. */
  function listPlayers() {
    const map = new Map();

    function add(key, id, uname, at, banned) {
      if (!key) return;
      const prev = map.get(key);
      const newer = !prev || (at || 0) >= (prev.at || 0);
      map.set(key, {
        key,
        h: key.indexOf('h:') === 0 ? key.slice(2) : ((prev && prev.h) || ''),
        u: key.indexOf('hu:') === 0 ? key.slice(3) : ((prev && prev.u) || ''),
        id: id || (prev && prev.id) || '',
        username: newer
          ? (uname || (prev && prev.username) || '')
          : ((prev && prev.username) || uname || ''),
        at: Math.max(at || 0, (prev && prev.at) || 0),
        banned: !!(banned || (prev && prev.banned)),
      });
    }

    Object.keys(state.data.accounts || {}).forEach((k) => {
      const acc = state.data.accounts[k];
      if (!acc) return;
      const meta = decodeMeta(acc.p) || {};
      const id = String(meta.id || '').slice(0, 40);
      const uname = String(meta.username || '').replace(/^@/, '').toLowerCase().slice(0, 32);
      add(k, id, uname, Number(acc.at) || 0, !!state.data.bans[k]);
    });

    // Баны, для которых аккаунт ещё не создан: показываем хотя бы псевдоним.
    Object.keys(state.data.bans || {}).forEach((k) => {
      if (map.has(k)) return;
      const ban = state.data.bans[k];
      if (!ban) return;
      add(k, '', '', Number(ban.at) || 0, true);
    });

    return [...map.values()].sort((a, b) => {
      if (a.banned !== b.banned) return a.banned ? -1 : 1;
      return (b.at || 0) - (a.at || 0);
    });
  }

  async function checkBan(force) {
    if (!force && Date.now() - state.checkAt < BAN_FOCUS_THROTTLE_MS) {
      return updateBan();
    }
    state.checkAt = Date.now();
    try {
      await refresh();
    } catch (e) {
      state.lastError = e && e.message ? e.message : 'network';
    }
    return updateBan();
  }

  /* ---------- Промокоды ---------- */
  function normalizeCode(v) {
    return String(v || '').toUpperCase().replace(/\s+/g, '');
  }

  /**
   * Глобальная активация промокода. Возвращает
   * { ok, reason, offline, used }.
   */
  function redeemPromo(code) {
    const normalized = normalizeCode(code);
    return mutate(async () => {
      let data;
      try {
        data = await fetchData();
      } catch (e) {
        return {
          ok: false,
          offline: true,
          reason: 'Сервер проверки недоступен. Промокод не активирован — проверь интернет и попробуй ещё раз.',
        };
      }

      if (data.promos[normalized]) {
        state.data = data;
        return { ok: false, used: true, reason: 'Этот промокод уже использован' };
      }

      const acc = accountKey();
      data.promos[normalized] = {
        by: acc,
        at: Date.now(),
      };
      registerAccountIn(data);
      data.updatedAt = Date.now();

      try {
        await writeData(data);
      } catch (e) {
        return {
          ok: false,
          offline: true,
          reason: 'Не удалось записать промокод в облако. Проверь интернет и попробуй снова.',
        };
      }

      // Небольшая пауза и контрольное чтение: так мы видим, не забрал ли
      // код кто-то другой в тот же момент (запись в TextDB неатомарная).
      await sleep(450);
      try {
        const check = await fetchData();
        if (!check.promos[normalized]) {
          return { ok: false, reason: 'Промокод не закрепился. Попробуй ещё раз.' };
        }
        if (check.promos[normalized].by !== acc) {
          state.data = check;
          return { ok: false, used: true, reason: 'Этот промокод уже использован' };
        }
        state.data = check;
      } catch (e) {
        state.data = data;
      }

      state.loaded = true;
      state.fetchedAt = Date.now();
      updateBan();
      return { ok: true, reward: PROMO_REWARD };
    });
  }

  function promoCount() {
    return Object.keys(state.data.promos || {}).length;
  }

  function promoUsedByMe(code) {
    const normalized = normalizeCode(code);
    const item = state.data.promos && state.data.promos[normalized];
    return !!item && sameAccount(item.by);
  }

  function myPromos() {
    const out = [];
    const promos = state.data.promos || {};
    Object.keys(promos).forEach((code) => {
      if (sameAccount(promos[code] && promos[code].by)) out.push(code);
    });
    return out;
  }

  /* ---------- Баны ---------- */
  function parseTarget(target) {
    let s = String(target == null ? '' : target).trim();
    if (!s) return null;

    let m = s.match(/^(?:telegram[\s_-]*)?(?:id|tg)[\s:_#-]*(\d{4,})$/i);
    if (m) return { kind: 'id', id: m[1] };

    s = s.replace(/^@+/, '');
    if (!s) return null;
    if (/^h:[0-9a-f]{32}$/i.test(s)) return { kind: 'idhash', hash: s.slice(2).toLowerCase() };
    if (/^hu:[0-9a-f]{32}$/i.test(s)) return { kind: 'namehash', hash: s.slice(3).toLowerCase() };
    if (/^dv:[0-9a-f]{32}$/i.test(s)) return { kind: 'device', hash: s.slice(3).toLowerCase() };
    if (/^id:/i.test(s) && /^\d{4,}$/.test(s.slice(3))) return { kind: 'id', id: s.slice(3) };
    if (/^tg[:_]/i.test(s) && /^\d{4,}$/.test(s.slice(3))) return { kind: 'id', id: s.slice(3) };
    if (/^u:/i.test(s)) {
      const name = s.slice(2).toLowerCase();
      return /^[a-z0-9_]{3,32}$/.test(name) ? { kind: 'name', name } : null;
    }
    if (/^\d{4,}$/.test(s)) return { kind: 'id', id: s };
    if (!/^[a-z0-9_]{3,32}$/i.test(s)) return null;
    return { kind: 'name', name: s.toLowerCase() };
  }

  function banKey(target) {
    const t = parseTarget(target);
    if (!t) return '';
    if (t.kind === 'id') return 'h:' + hashId(t.id);
    if (t.kind === 'name') return 'hu:' + hashName(t.name);
    if (t.kind === 'idhash') return 'h:' + t.hash;
    if (t.kind === 'namehash') return 'hu:' + t.hash;
    if (t.kind === 'device') return 'dv:' + t.hash;
    return '';
  }

  function accountById(id) {
    const target = hashId(id);
    if (!target) return null;
    let found = null;
    Object.keys(state.data.accounts || {}).forEach((k) => {
      const acc = state.data.accounts[k];
      if (!acc || acc.h !== target) return;
      const meta = decodeMeta(acc.p) || {};
      const name = String(meta.username || '').toLowerCase().slice(0, 32);
      const next = { id: String(id), username: name };
      if (!found || (!found.username && name)) found = next;
    });
    return found;
  }

  function accountByName(name) {
    const uname = String(name || '').toLowerCase();
    if (!uname) return null;
    const target = hashName(uname);
    let found = null;
    Object.keys(state.data.accounts || {}).forEach((k) => {
      const acc = state.data.accounts[k];
      if (!acc || acc.u !== target) return;
      const meta = decodeMeta(acc.p) || {};
      const id = String(meta.id || '').slice(0, 40);
      const next = { id, username: uname };
      if (!found || (!found.id && id)) found = next;
    });
    if (found) return found;
    if (state.data.bans['hu:' + target]) return { id: '', username: uname };
    return null;
  }

  /** Разбирает ввод админа: @username, 123456789, id:123, tg_123. */
  function banTargetInfo(target) {
    const t = parseTarget(target);
    if (!t) return null;
    if (t.kind === 'id') {
      const acc = accountById(t.id);
      return { key: 'h:' + hashId(t.id), id: t.id, username: acc ? acc.username : '' };
    }
    if (t.kind === 'name') {
      const acc = accountByName(t.name);
      if (acc && acc.id) {
        return { key: 'h:' + hashId(acc.id), id: acc.id, username: acc.username || t.name };
      }
      return { key: 'hu:' + hashName(t.name), id: '', username: t.name };
    }
    if (t.kind === 'idhash') return { key: 'h:' + t.hash, id: '', username: '' };
    if (t.kind === 'namehash') return { key: 'hu:' + t.hash, id: '', username: '' };
    if (t.kind === 'device') return { key: 'dv:' + t.hash, id: '', username: '' };
    return null;
  }

  function banTargetKeys(target) {
    const t = parseTarget(target);
    if (!t) return [];
    const keys = [banKey(target)];
    if (t.kind === 'id') {
      keys.push('h:' + hashId(t.id));
      if (state.data.bans['h:' + hashId(t.id)]) keys.push('h:' + hashId(t.id));
    }
    if (t.kind === 'name') {
      const h = hashName(t.name);
      keys.push('hu:' + h);
      const acc = accountByName(t.name);
      if (acc && acc.id) keys.push('h:' + hashId(acc.id));
    }
    return keys.filter((k, i) => k && keys.indexOf(k) === i);
  }

  function targetLabel(key) {
    if (!key) return '';
    if (key.indexOf('h:') === 0) {
      const h = key.slice(2);
      let id = '';
      let uname = '';
      Object.keys(state.data.accounts || {}).forEach((k) => {
        const acc = state.data.accounts[k];
        if (!acc || acc.h !== h) return;
        const meta = decodeMeta(acc.p) || {};
        if (meta.id) id = String(meta.id).slice(0, 40);
        if (meta.username) uname = String(meta.username).toLowerCase().slice(0, 32);
      });
      if (id && uname) return 'ID ' + id + ' · @' + uname;
      if (id) return 'ID ' + id;
      if (uname) return '@' + uname;
      return 'Игрок #' + h.slice(0, 6);
    }
    if (key.indexOf('hu:') === 0) {
      const h = key.slice(3);
      let uname = '';
      Object.keys(state.data.accounts || {}).forEach((k) => {
        const acc = state.data.accounts[k];
        if (!acc || acc.u !== h) return;
        const meta = decodeMeta(acc.p) || {};
        if (meta.username) uname = String(meta.username).slice(0, 32);
      });
      return uname ? '@' + uname : 'Игрок #' + h.slice(0, 6);
    }
    if (key.indexOf('dv:') === 0) return 'Локальный профиль';
    return key;
  }

  function listBans() {
    return Object.keys(state.data.bans || {})
      .map((k) => {
        const item = state.data.bans[k];
        const meta = decodeMeta(item && item.p) || {};
        return {
          key: k,
          target: targetLabel(k),
          reason: String(meta.reason || '').slice(0, 240),
          by: String(meta.by || '').slice(0, 40),
          at: Number(item && item.at) || 0,
        };
      })
      .sort((a, b) => (b.at || 0) - (a.at || 0));
  }

  function ban(target, reason) {
    return mutate(async () => {
      if (!isAdmin()) return { ok: false, reason: 'Нет доступа' };
      const info = banTargetInfo(target);
      if (!info) return { ok: false, reason: 'Укажи @username или числовой Telegram ID' };
      const infoAcc = info.id ? accountById(info.id) : null;
      if ((info.username && info.username.toLowerCase() === ADMIN_USERNAME) ||
          (infoAcc && String(infoAcc.username).toLowerCase() === ADMIN_USERNAME)) {
        return { ok: false, reason: 'Нельзя забанить администратора' };
      }

      const key = info.id ? ('h:' + hashId(info.id)) : info.key;
      const label = info.id
        ? ('ID ' + info.id + (info.username ? ' · @' + info.username : ''))
        : (info.username ? '@' + info.username : 'Игрок #' + key.slice(-6));

      let data;
      try { data = await fetchData(); }
      catch (e) { return { ok: false, offline: true, reason: 'Нет связи с облаком. Попробуй позже.' }; }

      const at = Date.now();
      const h = info.id ? hashId(info.id) : '';
      const u = info.username ? hashName(info.username) : '';
      if (h || u) {
        const accKey = h ? ('h:' + h) : ('hu:' + u);
        if (!data.accounts[accKey]) {
          data.accounts[accKey] = {
            h, u, at,
            p: encodeMeta({ id: info.id || '', username: info.username || '' }),
          };
        }
      }

      data.bans[key] = {
        k: key,
        at,
        p: encodeMeta({
          reason: String(reason || '').trim().slice(0, 240) || 'Без указания причины',
          by: username() || 'admin',
        }),
      };
      data.updatedAt = Date.now();

      try { await writeData(data); }
      catch (e) { return { ok: false, offline: true, reason: 'Не удалось записать бан. Попробуй ещё раз.' }; }

      state.data = normalize(data);
      state.loaded = true;
      state.fetchedAt = Date.now();
      updateBan();
      return { ok: true, key, target: label };
    });
  }

  function unban(target) {
    return mutate(async () => {
      if (!isAdmin()) return { ok: false, reason: 'Нет доступа' };
      const keys = banTargetKeys(target);
      if (!keys.length) return { ok: false, reason: 'Укажи @username или числовой Telegram ID' };

      let data;
      try { data = await fetchData(); }
      catch (e) { return { ok: false, offline: true, reason: 'Нет связи с облаком. Попробуй позже.' }; }

      const removed = keys.filter((k) => data.bans[k]);
      if (!removed.length) return { ok: false, reason: 'Такого бана нет' };
      state.data = data;
      const label = targetLabel(removed[0]);
      removed.forEach((k) => { delete data.bans[k]; });
      data.updatedAt = Date.now();

      try { await writeData(data); }
      catch (e) { return { ok: false, offline: true, reason: 'Не удалось снять бан. Попробуй ещё раз.' }; }

      state.data = normalize(data);
      state.loaded = true;
      state.fetchedAt = Date.now();
      updateBan();
      return { ok: true, key: removed[0], target: label };
    });
  }

  function unbanKey(key) {
    return unban(key);
  }

  function stats() {
    return {
      loaded: state.loaded,
      online: state.loaded && !state.lastError,
      fetchedAt: state.fetchedAt,
      error: state.lastError,
      promos: promoCount(),
      bans: listBans().length,
      account: accountLabel(),
      accountKey: accountKey(),
      admin: isAdmin(),
      banned: !!state.banned,
    };
  }

  /* ---------- Инициализация ---------- */
  function init() {
    checkBan(true);
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => { checkBan(true); }, BAN_POLL_MS);

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) checkBan(true);
    });
    window.addEventListener('focus', () => { checkBan(false); });
    window.addEventListener('screenchange', () => { checkBan(false); });
  }

  window.Cloud = {
    KEY,
    LEGACY_CLOUD_KEY,
    init,
    refresh,
    checkBan,
    redeemPromo,
    normalizeCode,
    promoCount,
    promoUsedByMe,
    myPromos,
    isAdmin,
    isBanned,
    banEntry,
    ban,
    unban,
    unbanKey,
    banKey,
    banTargetInfo,
    banTargetKeys,
    targetLabel,
    listBans,
    listPlayers,
    stats,
    accountKey,
    identityKeys,
    sameAccount,
    accountLabel,
    username,
    userId,
    tgUser,
    walletKey,
    walletKeyFor,
    walletKeyForHash,
    canSyncWallet,
    readWallet,
    readWalletFor,
    writeWallet,
    hashId,
    hashName,
    encodeMeta,
    decodeMeta,
    sha256,
    get data() { return state.data; },
  };
})();
