const RULE_CARD_ITEMS = [
  '<strong>Daily Allowance:</strong> Enjoy 3 free spins, refreshing every 24 hours.',
  '<strong>Wallet Transfers:</strong> Transfer is available <strong class="rules-accent">once per day</strong>.'
];

function getDosttUserIdFromUrl() {
  try {
    const encoded = new URLSearchParams(window.location.search).get('user_id');
    if (!encoded) return null;
    const decoded = parseInt(atob(encoded), 10);
    return isNaN(decoded) ? null : decoded;
  } catch {
    return null;
  }
}

const _urlDosttUserId = getDosttUserIdFromUrl();
if (_urlDosttUserId) {
  localStorage.setItem('dostt_user_id', String(_urlDosttUserId));
  localStorage.removeItem('user_mobile');
}

const state = {
  config: null,
  dosttUserId: parseInt(localStorage.getItem('dostt_user_id') || '0') || null,
  mobileNumber: localStorage.getItem('user_mobile') || '',
  isLoggedIn: Boolean(localStorage.getItem('dostt_user_id') || localStorage.getItem('user_mobile')),
  spinState: {
    spins_used: 0,
    max_spins: 3,
    total_winnings: 0,
    transferred_today: false
  },
  spinning: false,
  transferring: false,
  wheelRotation: 0
};

const elements = {
  topBar: document.getElementById('topBar'),
  walletCoins: document.getElementById('walletCoins'),
  transferArea: document.getElementById('transferArea'),
  loginView: document.getElementById('loginView'),
  loadingView: document.getElementById('loadingView'),
  wheelView: document.getElementById('wheelView'),
  loginForm: document.getElementById('loginForm'),
  mobileInput: document.getElementById('mobileInput'),
  spinButton: document.getElementById('spinButton'),
  spinCooldownBlock: document.getElementById('spinCooldownBlock'),
  spinCooldownText: document.getElementById('spinCooldownText'),
  testerPanel: document.getElementById('testerPanel'),
  forcedRewardSelect: document.getElementById('forcedRewardSelect'),
  customTransferInput: document.getElementById('customTransferInput'),
  resetTesterButton: document.getElementById('resetTesterButton'),
  statusDots: document.getElementById('statusDots'),
  spinsCaption: document.getElementById('spinsCaption'),
  rulesList: document.getElementById('rulesList'),
  errorBanner: document.getElementById('errorBanner'),
  termsButton: document.getElementById('termsButton'),
  logoutButton: document.getElementById('logoutButton'),
  termsModal: document.getElementById('termsModal'),
  closeTermsButton: document.getElementById('closeTermsButton'),
  rewardModal: document.getElementById('rewardModal'),
  rewardIcon: document.getElementById('rewardIcon'),
  rewardTitle: document.getElementById('rewardTitle'),
  rewardDescription: document.getElementById('rewardDescription'),
  closeRewardButton: document.getElementById('closeRewardButton'),
  transferModal: document.getElementById('transferModal'),
  closeTransferButton: document.getElementById('closeTransferButton'),
  transferErrorModal: document.getElementById('transferErrorModal'),
  transferErrorText: document.getElementById('transferErrorText'),
  closeTransferErrorButton: document.getElementById('closeTransferErrorButton'),
  wheelMain: document.getElementById('wheelMain'),
  segmentLabels: document.getElementById('segmentLabels')
};

let spinCountdownInterval = null;
let transferCountdownInterval = null;

function normalizeMobile(value) {
  const digits = String(value || '').replace(/\D/g, '');

  if (digits.length === 12 && digits.startsWith('91')) {
    return digits.slice(2);
  }

  if (digits.length === 11 && digits.startsWith('0')) {
    return digits.slice(1);
  }

  return digits;
}

function isDosttUser() {
  return Boolean(state.dosttUserId);
}

function isTester() {
  if (isDosttUser()) return false;
  return state.config?.testerMobileNumbers?.includes(state.mobileNumber);
}

function showError(message) {
  if (!message) {
    elements.errorBanner.classList.add('hidden');
    elements.errorBanner.textContent = '';
    return;
  }

  elements.errorBanner.textContent = message;
  elements.errorBanner.classList.remove('hidden');
}

function showTransferErrorModal(message) {
  elements.transferErrorText.textContent = message || 'Something went wrong. Please try again.';
  elements.transferErrorModal.classList.remove('hidden');
}

function getFriendlyErrorMessage(error) {
  if (!error) {
    return 'Something went wrong. Please try again.';
  }

  if (error.message === 'Failed to fetch' || error.message === 'NetworkError when attempting to fetch resource.') {
    return 'Local server is not running. Start `npm run dev` and try again.';
  }

  return error.message || 'Something went wrong. Please try again.';
}

function showView(viewName) {
  elements.loginView.classList.add('hidden');
  elements.loadingView.classList.add('hidden');
  elements.wheelView.classList.add('hidden');
  elements[viewName].classList.remove('hidden');
}

function getWheelIconMarkup(section) {
  if (section.icon && section.icon.startsWith('/')) {
    return `<img class="wheel-coin-icon" src="${section.icon}" alt="">`;
  }

  return section.icon;
}

function renderWheel() {
  const sections = state.config.wheelSections;
  const size = 360 / sections.length;
  elements.wheelMain.style.background = `conic-gradient(${sections.map((section, index) => `${section.color} ${index * size}deg ${(index + 1) * size}deg`).join(', ')})`;
  elements.segmentLabels.innerHTML = '';
  elements.forcedRewardSelect.innerHTML = '<option value="">Default (Random)</option>';
  const testerOptions = state.config.testerRewardOptions || sections;

  sections.forEach((section, index) => {
    const angle = index * size + size / 2;
    const label = document.createElement('div');
    label.className = 'segment-label-item';
    label.style.transform = `rotate(${angle}deg)`;
    label.style.setProperty('--segment-angle', `${angle}deg`);
    const displayLabel = section.label.includes(' ')
      ? section.label.split(' ').join('<br>')
      : section.label;
    label.innerHTML = `
      <div class="label-content">
        <span class="label-icon">${getWheelIconMarkup(section)}</span>
        <span class="label-text ${section.label.length > 12 ? 'label-text-wide' : ''}" style="color:${section.text}">${displayLabel}</span>
      </div>
    `;
    elements.segmentLabels.appendChild(label);

  });

  testerOptions.forEach((optionConfig) => {
    const option = document.createElement('option');
    option.value = optionConfig.id;
    option.textContent = optionConfig.label;
    elements.forcedRewardSelect.appendChild(option);
  });
}

function updateStatusDots() {
  elements.statusDots.innerHTML = '';
  for (let index = 1; index <= 3; index += 1) {
    const dot = document.createElement('div');
    dot.className = `status-dot ${index <= state.spinState.spins_used ? 'active' : ''}`;
    elements.statusDots.appendChild(dot);
  }
}

function formatCountdown(msRemaining) {
  const totalSeconds = Math.max(0, Math.floor(msRemaining / 1000));
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${hours}h ${minutes}m ${seconds}s`;
}

function startSpinCountdown() {
  clearInterval(spinCountdownInterval);
  if (isTester() || state.spinState.spins_used < state.spinState.max_spins) {
    elements.spinCooldownBlock.classList.add('hidden');
    return;
  }

  elements.spinCooldownBlock.classList.remove('hidden');
  spinCountdownInterval = setInterval(() => {
    const tomorrow = new Date();
    tomorrow.setHours(24, 0, 0, 0);
    elements.spinCooldownText.textContent = formatCountdown(tomorrow.getTime() - Date.now());
  }, 1000);
}

function startTransferCountdown() {
  clearInterval(transferCountdownInterval);
  if (isTester() || !state.spinState.transferred_today) {
    return;
  }

  transferCountdownInterval = setInterval(() => {
    const tomorrow = new Date();
    tomorrow.setHours(24, 0, 0, 0);
    const chip = document.getElementById('transferCooldownChip');
    if (chip) {
      chip.textContent = formatCountdown(tomorrow.getTime() - Date.now());
    }
  }, 1000);
}

function renderTransferArea() {
  elements.transferArea.innerHTML = '';

  if (!state.isLoggedIn) {
    return;
  }

  if (!isTester() && state.spinState.transferred_today) {
    const chip = document.createElement('div');
    chip.id = 'transferCooldownChip';
    chip.className = 'transfer-chip disabled';
    chip.textContent = 'Come Back';
    elements.transferArea.appendChild(chip);
    startTransferCountdown();
    return;
  }

  const button = document.createElement('button');
  button.className = 'transfer-chip';
  button.textContent = state.transferring ? '...' : 'Transfer';
  button.disabled = state.transferring || state.spinState.total_winnings <= 0;
  if (button.disabled) {
    button.classList.add('disabled');
  }
  button.addEventListener('click', handleTransfer);
  elements.transferArea.appendChild(button);
}

function renderTerms() {
  elements.rulesList.innerHTML = RULE_CARD_ITEMS.map((item) => `<li>${item}</li>`).join('');
}

function renderAuthState() {
  elements.mobileInput.value = state.mobileNumber;
  elements.logoutButton.classList.toggle('hidden', !state.isLoggedIn);
  elements.topBar.classList.toggle('hidden', !state.isLoggedIn);
}

function renderWheelState() {
  const remainingSpins = Math.max(0, state.spinState.max_spins - state.spinState.spins_used);
  elements.walletCoins.textContent = state.spinState.total_winnings;
  elements.spinsCaption.textContent = `${remainingSpins} Spins ready for +${state.mobileNumber}`;
  elements.spinButton.disabled = state.spinning || (!isTester() && state.spinState.spins_used >= state.spinState.max_spins);
  elements.spinButton.innerHTML = state.spinning ? '<span class="spinner-inline"></span>' : 'SPIN THE WHEEL';
  elements.spinButton.classList.toggle('hidden', !isTester() && state.spinState.spins_used >= state.spinState.max_spins);
  elements.testerPanel.classList.toggle('hidden', !isTester());
  elements.resetTesterButton.classList.toggle('hidden', !isTester());
  updateStatusDots();
  renderTransferArea();
  startSpinCountdown();
}

function renderLoggedInUi() {
  renderAuthState();
  renderWheelState();
  showView('wheelView');
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const raw = await response.text();
  let data = {};

  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { error: raw };
    }
  }

  if (!response.ok) {
    throw new Error(data.error || data.reason || data.message || `Request failed (${response.status})`);
  }
  return data;
}

async function loadConfig() {
  state.config = await fetchJson('/api/config');
  renderWheel();
  renderTerms();
}

async function refreshState() {
  if (!state.isLoggedIn) return;

  showView('loadingView');
  try {
    const data = isDosttUser()
      ? await fetchJson(`/api/players/dostt/${state.dosttUserId}/state`)
      : await fetchJson(`/api/players/${state.mobileNumber}/state`);
    state.spinState = data;
    showError('');
    renderLoggedInUi();
    if (data.pending_notification) {
      const coins = data.pending_notification.coins_requested;
      document.getElementById('notificationText').innerHTML =
        `Your <strong>${coins} coins</strong> have been transferred to your Dostt Wallet successfully! 🎉`;
      document.getElementById('notificationModal').classList.remove('hidden');
    }
  } catch (error) {
    if (error.message === 'Player not found') {
      if (isDosttUser()) {
        await fetchJson('/api/players/register-dostt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dosttUserId: state.dosttUserId })
        });
        const data = await fetchJson(`/api/players/dostt/${state.dosttUserId}/state`);
        state.spinState = data;
        renderLoggedInUi();
      } else {
        await fetchJson('/api/players/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mobileNumber: state.mobileNumber })
        });
        const data = await fetchJson(`/api/players/${state.mobileNumber}/state`);
        state.spinState = data;
        renderLoggedInUi();
      }
    } else {
      state.isLoggedIn = false;
      renderAuthState();
      showError(getFriendlyErrorMessage(error));
      showView('loginView');
    }
  }
}

async function handleLogin(event) {
  event.preventDefault();
  const normalizedMobile = normalizeMobile(elements.mobileInput.value);
  if (normalizedMobile.length !== 10) {
    showError('Please enter a valid 10-digit number');
    return;
  }

  try {
    state.mobileNumber = normalizedMobile;
    state.isLoggedIn = true;
    localStorage.setItem('user_mobile', normalizedMobile);
    showError('');
    showView('loadingView');

    await fetchJson('/api/players/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobileNumber: normalizedMobile })
    });
    await refreshState();
  } catch (error) {
    state.mobileNumber = '';
    state.isLoggedIn = false;
    localStorage.removeItem('user_mobile');
    renderAuthState();
    showError(getFriendlyErrorMessage(error));
    showView('loginView');
  }
}

function launchConfetti() {
  const pieces = ['🎉', '✨', '💜', '⭐'];
  for (let index = 0; index < 16; index += 1) {
    const particle = document.createElement('div');
    particle.className = 'confetti-piece';
    particle.textContent = pieces[index % pieces.length];
    particle.style.left = `${Math.random() * 100}%`;
    particle.style.animationDelay = `${Math.random() * 0.25}s`;
    document.body.appendChild(particle);
    setTimeout(() => particle.remove(), 3200);
  }
}

async function handleSpin() {
  if (state.spinning || (!isTester() && state.spinState.spins_used >= state.spinState.max_spins)) {
    return;
  }

  state.spinning = true;
  renderWheelState();
  showError('');

  try {
    const payload = {
      ...(isDosttUser() ? { dosttUserId: state.dosttUserId } : { mobileNumber: state.mobileNumber }),
      forcedReward: isTester() ? elements.forcedRewardSelect.value || null : null
    };
    const result = await fetchJson('/api/spin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const sections = state.config.wheelSections;
    const matchingIndexes = sections
      .map((section, index) => ((section.reward_key || section.id) === result.reward ? index : -1))
      .filter((index) => index >= 0);
    const targetIndex = matchingIndexes.length > 0
      ? matchingIndexes[Math.floor(Math.random() * matchingIndexes.length)]
      : 0;
    const segmentSize = 360 / sections.length;
    const extraSpins = 12 * 360;
    const landingOffset = 360 - (targetIndex * segmentSize + segmentSize / 2);
    const totalRotation = state.wheelRotation + extraSpins + (landingOffset - (state.wheelRotation % 360));
    state.wheelRotation = totalRotation;
    elements.wheelMain.style.transform = `rotate(${state.wheelRotation}deg)`;

    setTimeout(async () => {
      state.spinning = false;
      await refreshState();
      openRewardModal(result);
      if (result.reward_coins > 0) {
        launchConfetti();
      }
    }, 5000);
  } catch (error) {
    state.spinning = false;
    showError(error.message === 'daily_limit_reached' ? 'Spin limit reached for today' : getFriendlyErrorMessage(error));
    renderWheelState();
  }
}

function openRewardModal(result) {
  const rewardPool = state.config.testerRewardOptions || state.config.wheelSections;
  const reward = rewardPool.find((item) => item.id === result.reward || item.reward_key === result.reward) || rewardPool[0];
  const isWinner = Number(result.reward_coins) > 0;
  elements.rewardIcon.innerHTML = reward.icon && reward.icon.startsWith('/')
    ? `<img class="reward-icon-img" src="${reward.icon}" alt="">`
    : reward.icon;
  elements.rewardTitle.textContent = isWinner ? 'Hooray!' : 'Oh No!';
  elements.rewardDescription.innerHTML = result.reward === 'better_luck'
    ? 'Better luck next Time!'
    : `Amazing! You won ${reward.label}! We've added it to your wallet.`;
  elements.rewardModal.classList.remove('hidden');
}

async function handleTransfer() {
  const coinsRequested = isTester()
    ? Number(elements.customTransferInput.value || state.spinState.total_winnings)
    : state.spinState.total_winnings;

  if (!coinsRequested || coinsRequested <= 0) {
    showError('Enter a valid transfer amount.');
    return;
  }

  state.transferring = true;
  renderTransferArea();
  showError('');

  try {
    await fetchJson('/api/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(isDosttUser() ? { dosttUserId: state.dosttUserId } : { mobileNumber: state.mobileNumber }),
        coinsRequested
      })
    });

    elements.customTransferInput.value = '';
    elements.transferModal.classList.remove('hidden');
    await refreshState();
  } catch (error) {
    showTransferErrorModal(getFriendlyErrorMessage(error));
    renderTransferArea();
  } finally {
    state.transferring = false;
    renderTransferArea();
  }
}

async function handleResetTester() {
  try {
    await fetchJson('/api/test/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobileNumber: state.mobileNumber })
    });
    alert('RESET SUCCESSFUL! Refreshing...');
    localStorage.removeItem('user_mobile');
    window.location.reload();
  } catch (error) {
    showError(getFriendlyErrorMessage(error));
  }
}

function handleLogout() {
  localStorage.removeItem('user_mobile');
  localStorage.removeItem('dostt_user_id');
  state.mobileNumber = '';
  state.dosttUserId = null;
  state.isLoggedIn = false;
  state.spinState = {
    spins_used: 0,
    max_spins: 3,
    total_winnings: 0,
    transferred_today: false
  };
  showError('');
  renderAuthState();
  showView('loginView');
}

async function init() {
  await loadConfig();
  renderAuthState();

  elements.loginForm.addEventListener('submit', handleLogin);
  elements.spinButton.addEventListener('click', handleSpin);
  elements.resetTesterButton.addEventListener('click', handleResetTester);
  elements.logoutButton.addEventListener('click', handleLogout);
  elements.termsButton.addEventListener('click', () => elements.termsModal.classList.remove('hidden'));
  elements.closeTermsButton.addEventListener('click', () => elements.termsModal.classList.add('hidden'));
  elements.closeRewardButton.addEventListener('click', () => elements.rewardModal.classList.add('hidden'));
  elements.closeTransferButton.addEventListener('click', () => elements.transferModal.classList.add('hidden'));
  elements.closeTransferErrorButton.addEventListener('click', () => elements.transferErrorModal.classList.add('hidden'));

  const closeNotifBtn = document.getElementById('closeNotificationButton');
  if (closeNotifBtn) {
    closeNotifBtn.addEventListener('click', async () => {
      document.getElementById('notificationModal').classList.add('hidden');
      if (isDosttUser()) {
        await fetch(`/api/players/dostt/${state.dosttUserId}/dismiss-notification`, { method: 'POST' });
      } else {
        await fetch(`/api/players/${state.mobileNumber}/dismiss-notification`, { method: 'POST' });
      }
    });
  }

  if (isDosttUser()) {
    elements.logoutButton.classList.add('hidden');
  }

  if (state.isLoggedIn) {
    await refreshState();
  } else {
    showView('loginView');
  }
}

init().catch((error) => {
  showError(getFriendlyErrorMessage(error));
});
