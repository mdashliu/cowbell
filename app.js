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

function playMoo() {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const filter = audioCtx.createBiquadFilter();
  const gain = audioCtx.createGain();

  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(110, t);
  osc.frequency.linearRampToValueAtTime(150, t + 0.35);
  osc.frequency.linearRampToValueAtTime(85, t + 1.1);

  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(500, t);
  filter.frequency.linearRampToValueAtTime(900, t + 0.4);
  filter.frequency.linearRampToValueAtTime(300, t + 1.1);

  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.6, t + 0.1);
  gain.gain.linearRampToValueAtTime(0.5, t + 0.8);
  gain.gain.linearRampToValueAtTime(0, t + 1.2);

  osc.connect(filter).connect(gain).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + 1.25);
}

function startMooLoop() {
  stopMooLoop();
  playMoo();
  mooTimer = setInterval(playMoo, 2000);
}
function stopMooLoop() {
  if (mooTimer) clearInterval(mooTimer);
  mooTimer = null;
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
  let pick;
  do {
    pick = questions[Math.floor(Math.random() * questions.length)];
  } while (questions.length > 1 && pick === current);
  current = pick;
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
    onCorrect();
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

// ---------- hooks for the points/streak step ----------
function onCorrect() {
  // TODO: award points here
}
function onAlarmDismissed() {
  // TODO: update streak / lastWakeDate here
}

// ---------- controls ----------
armBtn.addEventListener('click', () => {
  ensureAudio(); // this click unlocks audio autoplay
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
  armBtn.textContent = state.armed ? 'Disarm' : 'Arm alarm';
  statusEl.textContent = state.armed
    ? `Armed for ${state.time}. Keep this tab open.`
    : 'Alarm is off.';
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
  if (state.armed) requestWakeLock();
  if (state.ringing) startRinging(); // resume after refresh mid-alarm
  tick();
  setInterval(tick, 1000);
})();