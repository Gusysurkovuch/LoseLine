'use strict';

/* ================= УСЛОВИЯ И КОНФИДЕНЦИАЛЬНОСТЬ ================= */
/*
 * Первый вход в игру показывает экран согласия: возраст 18+ и принятие
 * условий. Без обеих галочек игра не открывается. Согласие хранится
 * локально для конкретного игрового аккаунта (ключ — хеш, без открытого ID).
 */
(function () {

  const VERSION = 1;
  const BASE_KEY = 'tugriki_legal_v1';

  const $ = (id) => document.getElementById(id);

  let overlay, ageBox, consentBox, acceptBtn, closeBtn;
  let openBtn, footerBtn;
  let bound = false;

  function accountPart() {
    let acc = 'local';
    try {
      if (window.Cloud && Cloud.accountKey) acc = String(Cloud.accountKey() || 'local');
    } catch (e) {}
    return acc.replace(/[^a-z0-9_-]/gi, '_').slice(0, 80) || 'local';
  }

  function storageKey() {
    return BASE_KEY + '_' + accountPart();
  }

  function readConsent() {
    try {
      const raw = localStorage.getItem(storageKey());
      if (!raw) return null;
      const data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : null;
    } catch (e) { return null; }
  }

  function accepted() {
    const data = readConsent();
    return !!(data && data.accepted === true && Number(data.version) === VERSION);
  }

  function saveConsent() {
    try {
      localStorage.setItem(storageKey(), JSON.stringify({
        accepted: true,
        version: VERSION,
        at: Date.now(),
      }));
    } catch (e) {}
  }

  function paint() {
    const done = accepted();
    if (ageBox) ageBox.checked = done ? true : ageBox.checked;
    if (consentBox) consentBox.checked = done ? true : consentBox.checked;

    const ready = !!(ageBox && ageBox.checked && consentBox && consentBox.checked);
    if (acceptBtn) {
      acceptBtn.disabled = !ready;
      acceptBtn.textContent = done ? 'СОХРАНИТЬ И ЗАКРЫТЬ' : 'ПРИНЯТЬ И ИГРАТЬ';
    }
    if (closeBtn) closeBtn.classList.toggle('hidden', !done);
  }

  function show() {
    if (!overlay) return;
    paint();
    overlay.classList.remove('hidden');
    document.body.classList.add('legal-open');
    if (window.App && App.haptic) App.haptic('light');
  }

  function hide() {
    if (!overlay) return;
    overlay.classList.add('hidden');
    document.body.classList.remove('legal-open');
  }

  function onAccept() {
    if (!ageBox || !consentBox || !ageBox.checked || !consentBox.checked) {
      if (window.App && App.toast) App.toast('Поставь обе галочки');
      return;
    }
    saveConsent();
    hide();
    if (window.App) {
      if (App.toast) App.toast('Условия приняты. Играем!');
      if (App.haptic) App.haptic('success');
    }
  }

  function init() {
    overlay = $('legalOverlay');
    ageBox = $('legalAge');
    consentBox = $('legalConsent');
    acceptBtn = $('legalAccept');
    closeBtn = $('legalClose');
    openBtn = $('legalBtn');
    footerBtn = $('legalFooterBtn');

    if (!bound) {
      bound = true;
      if (ageBox) ageBox.addEventListener('change', paint);
      if (consentBox) consentBox.addEventListener('change', paint);
      if (acceptBtn) acceptBtn.addEventListener('click', onAccept);
      if (closeBtn) closeBtn.addEventListener('click', hide);
      if (openBtn) openBtn.addEventListener('click', show);
      if (footerBtn) footerBtn.addEventListener('click', show);
      if (overlay) {
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay && accepted()) hide();
        });
      }
    }

    if (!overlay) return;
    if (!accepted()) show();
    else {
      paint();
      overlay.classList.add('hidden');
    }
  }

  document.addEventListener('DOMContentLoaded', init);

  window.Privacy = { init, show, hide, accepted, storageKey };
})();
