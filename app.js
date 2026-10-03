// ---------- config ----------
const REQUIRED_STREAK = 3;           // correct answers in a row to stop the alarm
const STORAGE_KEY = 'moo-alarm';
const FALLBACK_QUESTIONS = [
  { q: 'What is 7 * 8?', a: ['56'] },
  { q: 'What is the capital of France?', a: ['paris'] },
  { q: "Ohm's law: V = I * ?", a: ['r'] },
  { q: 'What is the binary for decimal 5?', a: ['101'] },
];

// ---------- state ----------
const defaultState = { time: '07:00', armed: false, ringing: false, lastFired: null };
let state = loadState();
let questions = [];
let current = null;
let quizProgress = 0;
let audioCtx = null;
let mooTimer = null;
let wakeLock = null;

function loadState() {
  try {
    return { ...defaultState, ...JSON.parse(localStorage.getItem(STORAGE_KEY)) };
  } catch {
    return { ...defaultState };
  }
}
function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}

// ---------- dom ----------
const $ = (id) => document.getElementById(id);
const clockEl = $('clock'), timeInput = $('alarm-time'), armBtn = $('arm-btn');
const testBtn = $('test-btn'), statusEl = $('status'), overlay = $('overlay');
const gateBtn = $('gate-btn'), quizForm = $('quiz'), progressEl = $('progress');
const questionEl = $('question'), answerInput = $('answer'), feedbackEl = $('feedback');

// ---------- helpers ----------
const todayKey = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time
const normalize = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');

// ---------- questions (CSV: question,answer ; alternates separated by |) ----------
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length >= 2 && r[0].trim());
}

async function loadQuestions() {
  try {
    const res = await fetch('questions.csv');
    if (!res.ok) throw new Error(res.status);
    let rows = parseCSV(await res.text());
    if (rows.length && rows[0][0].trim().toLowerCase() === 'question') rows = rows.slice(1);
    questions = rows.map((r) => ({
      q: r[0].trim(),
      a: r[1].split('|').map(normalize),
    }));
  } catch {
    questions = [];
  }
  if (!questions.length) questions = FALLBACK_QUESTIONS; // file:// or missing CSV
}

// ---------- audio (synthesized moo, no file needed) ----------
function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

const mooAudio = new Audio('moo.mp3'); // path is relative to index.html
mooAudio.loop = true;

mooAudio.addEventListener('error', () => console.error('moo.mp3 failed to load:', mooAudio.error));

function startMooLoop() {
  mooAudio.currentTime = 0;
  mooAudio.play().catch((err) => console.error('moo play() rejected:', err));
}

function stopMooLoop() {
  mooAudio.pause();
  mooAudio.currentTime = 0;
}

function primeMoo() {
  mooAudio.muted = true;
  mooAudio.play()
    .then(() => { mooAudio.pause(); mooAudio.currentTime = 0; })
    .catch(() => {})
    .finally(() => { mooAudio.muted = false; });
}

// ---------- keep screen awake while armed (best effort) ----------
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch {}
}
function releaseWakeLock() {
  try { wakeLock && wakeLock.release(); } catch {}
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.armed) requestWakeLock();
});

// ---------- quiz ----------
function nextQuestion() {
  const seen = answeredToday();
  let pool = questions.filter((x) => !seen.has(x.q));
  // Every question already answered today: allow repeats so the alarm can still be dismissed.
  if (!pool.length) pool = questions;
  if (pool.length > 1) pool = pool.filter((x) => x !== current);
  current = pool[Math.floor(Math.random() * pool.length)];
  questionEl.textContent = current.q;
  answerInput.value = '';
  answerInput.focus();
  renderProgress();
}

function renderProgress() {
  progressEl.textContent = `${quizProgress} / ${REQUIRED_STREAK} in a row`;
}

function setFeedback(text, kind) {
  feedbackEl.textContent = text;
  feedbackEl.className = 'feedback ' + (kind || '');
}

quizForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!current) return;
  const given = normalize(answerInput.value);
  if (!given) return;

  if (current.a.includes(given)) {
    quizProgress++;
    onCorrect(current);
    if (quizProgress >= REQUIRED_STREAK) {
      dismissAlarm();
      return;
    }
    setFeedback('Correct!', 'good');
  } else {
    quizProgress = 0;
    setFeedback('Wrong. Back to 0.', 'bad');
  }
  nextQuestion();
});

// ---------- alarm lifecycle ----------
function startRinging() {
  state.ringing = true;
  saveState();
  quizProgress = 0;
  setFeedback('');
  overlay.classList.remove('hidden');

  if (audioCtx && audioCtx.state === 'running') {
    showQuiz();
  } else {
    // audio blocked (e.g. page reloaded mid-alarm): require one tap
    gateBtn.classList.remove('hidden');
    quizForm.classList.add('hidden');
  }
}

function showQuiz() {
  gateBtn.classList.add('hidden');
  quizForm.classList.remove('hidden');
  startMooLoop();
  nextQuestion();
}

gateBtn.addEventListener('click', () => {
  ensureAudio();
  showQuiz();
});

function dismissAlarm() {
  stopMooLoop();
  state.ringing = false;
  state.armed = false;
  saveState();
  overlay.classList.add('hidden');
  releaseWakeLock();
  renderStatus();
  onAlarmDismissed();
}

// ---------- points + streak (separate storage key from alarm state) ----------
const GAME_KEY = 'moo-game';
const POINTS_PER_CORRECT = 10;
const defaultGame = {
  points: 0,
  streak: 0,
  lastWakeDate: null,
  answeredDate: null, // day the `answered` list belongs to
  answered: [],       // question texts answered correctly on that day
  ownedItems: [],
  equipped: [],       // owned items currently worn (max one per slot)
};
let game = loadGame();

function loadGame() {
  try {
    return { ...defaultGame, ...JSON.parse(localStorage.getItem(GAME_KEY)) };
  } catch {
    return { ...defaultGame };
  }
}
function saveGame() {
  try { localStorage.setItem(GAME_KEY, JSON.stringify(game)); } catch {}
}

function yesterdayKey() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('en-CA');
}

// A streak is only alive if you woke up today or yesterday; otherwise it displays as 0.
function currentStreak() {
  const last = game.lastWakeDate;
  return last === todayKey() || last === yesterdayKey() ? game.streak : 0;
}

function renderHud() {
  $('points').textContent = game.points;
  $('streak').textContent = currentStreak();
  renderShop();
}

// Questions answered correctly today. Rolls the list over when the date changes.
function answeredToday() {
  if (game.answeredDate !== todayKey()) {
    game.answeredDate = todayKey();
    game.answered = [];
  }
  return new Set(game.answered);
}

function onCorrect(q) {
  answeredToday(); // make sure the list belongs to today before adding
  game.answered = [...game.answered, q.q];
  game.points += POINTS_PER_CORRECT; // saved per answer, not at the end
  saveGame();
  renderHud();
}

// ---------- shop ----------
const SHOP_ITEMS = [
  { id: 'bell',   name: 'Bell',      emoji: '🔔', cost: 30, slot: 'neck' },
  { id: 'flower', name: 'Flower',    emoji: '🌸', cost: 40, slot: 'head' },
  { id: 'hat',    name: 'Top hat',   emoji: '🎩', cost: 50, slot: 'head' },
  { id: 'shades', name: 'Shades',    emoji: '🕶️', cost: 60, slot: 'face' },
];

// Draws the cow plus every owned item as an absolutely positioned layer.
// Offsets live in style.css (.item-<id>) so they're easy to tweak.
function renderCow(el) {
  const layers = SHOP_ITEMS
    .filter((item) => game.equipped.includes(item.id))
    .map((item) => `<span class="cow-item item-${item.id}">${item.emoji}</span>`)
    .join('');
  el.innerHTML = `<span class="cow">🐄${layers}</span>`;
}

function renderShop() {
  renderCow($('shop-cow'));
  renderCow($('alarm-cow'));
  $('shop-items').innerHTML = SHOP_ITEMS.map((item) => {
    const owned = game.ownedItems.includes(item.id);
    const worn = game.equipped.includes(item.id);
    const button = owned
      ? `<button class="ghost" data-toggle="${item.id}">${worn ? 'Unequip' : 'Equip'}</button>`
      : `<button class="primary" data-buy="${item.id}" ${game.points < item.cost ? 'disabled' : ''}>${item.cost} pts</button>`;
    return `<div class="shop-item">
      <span>${item.emoji} ${item.name}</span>
      ${button}
    </div>`;
  }).join('');
}

function buyItem(id) {
  const item = SHOP_ITEMS.find((x) => x.id === id);
  if (!item || game.ownedItems.includes(id) || game.points < item.cost) return;
  game.points -= item.cost;
  game.ownedItems = [...game.ownedItems, id];
  equipItem(id); // buying wears it right away; equipItem saves and re-renders
}

// One item per slot: equipping replaces whatever is already worn in that slot.
function equipItem(id) {
  const item = SHOP_ITEMS.find((x) => x.id === id);
  if (!item || !game.ownedItems.includes(id)) return;
  const sameSlot = (otherId) => SHOP_ITEMS.find((x) => x.id === otherId)?.slot === item.slot;
  game.equipped = [...game.equipped.filter((o) => !sameSlot(o)), id];
  saveGame();
  renderHud();
}

function unequipItem(id) {
  game.equipped = game.equipped.filter((o) => o !== id);
  saveGame();
  renderHud();
}

$('shop-items').addEventListener('click', (e) => {
  const buy = e.target.closest('button[data-buy]');
  if (buy) return buyItem(buy.dataset.buy);
  const toggle = e.target.closest('button[data-toggle]');
  if (toggle) {
    const id = toggle.dataset.toggle;
    if (game.equipped.includes(id)) unequipItem(id);
    else equipItem(id);
  }
});

// Shop window is hidden until the Shop button is clicked.
const shopSection = $('shop'), shopBtn = $('shop-btn');
function setShopOpen(open) {
  shopSection.classList.toggle('hidden', !open);
  shopBtn.setAttribute('aria-expanded', String(open));
  shopBtn.textContent = open ? 'Close shop' : '🛒 Shop';
}
shopBtn.addEventListener('click', () => setShopOpen(shopSection.classList.contains('hidden')));
$('shop-close').addEventListener('click', () => setShopOpen(false));

function onAlarmDismissed() {
  const today = todayKey();
  if (game.lastWakeDate !== today) {
    game.streak = game.lastWakeDate === yesterdayKey() ? game.streak + 1 : 1;
    game.lastWakeDate = today;
    saveGame();
  }
  renderHud();
}

// ---------- controls ----------
armBtn.addEventListener('click', () => {
  ensureAudio(); // this click unlocks audio autoplay
  primeMoo();    // new line
  if (state.armed) {
    state.armed = false;
    releaseWakeLock();
  } else {
    state.time = timeInput.value || '07:00';
    state.armed = true;
    state.lastFired = null;
    requestWakeLock();
  }
  saveState();
  renderStatus();
});

testBtn.addEventListener('click', () => {
  ensureAudio();
  startRinging();
});

timeInput.addEventListener('change', () => {
  if (state.armed) {
    state.time = timeInput.value;
    state.lastFired = null;
    saveState();
    renderStatus();
  }
});

function renderStatus() {
  armBtn.textContent = state.armed ? 'disarm' : 'arm alarm';
  statusEl.textContent = state.armed
    ? `moothew will wake you up at  ${state.time}. keep this tab open!`
    : 'alarm is off.';
}

// ---------- main loop ----------
function tick() {
  const now = new Date();
  clockEl.textContent = now.toTimeString().slice(0, 8);
  const hhmm = now.toTimeString().slice(0, 5);

  if (state.armed && !state.ringing && hhmm === state.time && state.lastFired !== todayKey()) {
    state.lastFired = todayKey();
    startRinging();
  }
}

// ---------- init ----------
(async function init() {
  await loadQuestions();
  timeInput.value = state.time;
  renderStatus();
  renderHud();
  if (state.armed) requestWakeLock();
  if (state.ringing) startRinging(); // resume after refresh mid-alarm
  tick();
  setInterval(tick, 1000);
})();