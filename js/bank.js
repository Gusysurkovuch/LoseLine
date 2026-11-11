'use strict';

/* ================= БАНК ================= */
(function () {

  const $ = (id) => document.getElementById(id);
  const MIN = 1;

  let amountInput, bankEl, walletEl, statusEl;

  function bankValue() {
    return Math.max(0, Math.floor(Number(App.State.bank) || 0));
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function setAmount(v) {
    if (!amountInput) return;
    amountInput.value = v > 0 ? String(Math.floor(v)) : '';
  }

  function readAmount() {
    const n = parseInt(String(amountInput && amountInput.value || '').replace(/\D/g, ''), 10);
    return isFinite(n) ? n : 0;
  }

  function paint() {
    if (bankEl) bankEl.textContent = App.fmt(bankValue()) + ' 🪙';
    if (walletEl) walletEl.textContent = App.fmt(App.State.balance) + ' 🪙';
  }

  function deposit(amount) {
    amount = Math.floor(Number(amount) || 0);
    if (amount < MIN) { App.toast('Введи сумму'); return false; }
    if (amount > App.State.balance) { App.toast('На руках не хватает тугриков'); return false; }
    App.State.bank = bankValue() + amount;
    App.addBalance(-amount); // заодно сохраняет State (включая bank)
    paint();
    if (window.Sound) Sound.coin();
    App.haptic('success');
    setStatus('В банк положено ' + App.fmt(amount) + ' 🪙 · сохранено');
    App.toast('В банк: +' + App.fmt(amount) + ' 🪙');
    return true;
  }

  function withdraw(amount) {
    amount = Math.floor(Number(amount) || 0);
    if (amount < MIN) { App.toast('Введи сумму'); return false; }
    if (amount > bankValue()) { App.toast('В банке нет такой суммы'); return false; }
    App.State.bank = bankValue() - amount;
    App.addBalance(amount);
    paint();
    if (window.Sound) Sound.coin();
    App.haptic('success');
    setStatus('Из банка снято ' + App.fmt(amount) + ' 🪙');
    App.toast('Из банка: +' + App.fmt(amount) + ' 🪙');
    return true;
  }

  function init() {
    amountInput = $('bankAmount');
    bankEl = $('bankBalance');
    walletEl = $('bankWallet');
    statusEl = $('bankStatus');
    if (!amountInput) return;

    amountInput.addEventListener('input', () => {
      const digits = String(amountInput.value).replace(/\D/g, '').slice(0, 15).replace(/^0+(?=\d)/, '');
      if (amountInput.value !== digits) amountInput.value = digits;
    });

    amountInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const amount = readAmount();
      if (deposit(amount)) setAmount(0);
    });

    const depositBtn = $('bankDeposit');
    if (depositBtn) depositBtn.addEventListener('click', () => {
      if (deposit(readAmount())) setAmount(0);
    });

    const withdrawBtn = $('bankWithdraw');
    if (withdrawBtn) withdrawBtn.addEventListener('click', () => {
      if (withdraw(readAmount())) setAmount(0);
    });

    const allIn = $('bankAllIn');
    if (allIn) allIn.addEventListener('click', () => {
      const amount = App.State.balance;
      if (amount <= 0) { App.toast('На руках нет тугриков'); return; }
      if (deposit(amount)) setAmount(0);
    });

    const allOut = $('bankAllOut');
    if (allOut) allOut.addEventListener('click', () => {
      const amount = bankValue();
      if (amount <= 0) { App.toast('Банк пуст'); return; }
      if (withdraw(amount)) setAmount(0);
    });

    paint();
  }

  function onOpen() {
    paint();
    setStatus('Тугрики в банке сохраняются и не тратятся на ставки.');
  }

  window.Bank = { init, onOpen, deposit, withdraw, refresh: paint };
})();
