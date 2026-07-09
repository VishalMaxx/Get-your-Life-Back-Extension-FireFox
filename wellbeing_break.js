// wellbeing_break.js — the pause-screen shown when a Wellbeing Tools reminder (Eye Rest or
// Water Break) fires in PAUSE_SCREEN mode. Uses WellbeingRemindersEngine.contentFor() (same
// pure module background.js uses) so the copy can't drift between the two.

const params = new URLSearchParams(window.location.search);
const rawType = params.get('type'); // 'eye_rest' | 'water_break'
const wellbeingType = rawType === 'eye_rest'
  ? WellbeingRemindersEngine.TYPE_EYE_REST
  : WellbeingRemindersEngine.TYPE_WATER_BREAK;

if (wellbeingType === WellbeingRemindersEngine.TYPE_EYE_REST) {
  document.body.classList.remove('wash-blue');
  document.body.classList.add('wash-red');
}

const content = WellbeingRemindersEngine.contentFor(wellbeingType);

const titleEl = document.getElementById('wbTitle');
const messageEl = document.getElementById('wbMessage');
const countdownEl = document.getElementById('wbCountdown');
const doneBtn = document.getElementById('wbDoneBtn');
const iconImg = document.getElementById('wbIconImg');
const iconFallback = document.getElementById('wbIconFallback');

titleEl.textContent = content.title;
messageEl.textContent = content.message;

// ── ICON: try the real asset first (dropped in later at these exact paths); until then,
// show a simple inline SVG placeholder so the screen never looks broken. ──
const ICON_SVGS = {
  [WellbeingRemindersEngine.TYPE_EYE_REST]: `
    <svg viewBox="0 0 24 24" fill="none" stroke="#C77879" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/>
      <circle cx="12" cy="12" r="3.5"/>
    </svg>`,
  [WellbeingRemindersEngine.TYPE_WATER_BREAK]: `
    <svg viewBox="0 0 24 24" fill="none" stroke="#7889C7" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 2.5s7 8.2 7 12.7a7 7 0 0 1-14 0C5 10.7 12 2.5 12 2.5Z"/>
    </svg>`,
};
iconFallback.innerHTML = ICON_SVGS[wellbeingType];

const assetFile = wellbeingType === WellbeingRemindersEngine.TYPE_EYE_REST ? 'eye_rest.gif' : 'water_break.png';
const preload = new Image();
preload.onload = () => {
  iconImg.src = `assets/wellbeing/${assetFile}`;
  iconImg.style.display = 'block';
  iconFallback.style.display = 'none';
};
preload.onerror = () => {}; // keep the SVG fallback visible — no asset there yet
preload.src = `assets/wellbeing/${assetFile}`;

// ── HOLD / DONE ──
let remaining = content.pauseScreenHoldSeconds;
let timerStarted = false;
let holdInterval = null;

function playTimerEndSound() {
  try {
    const audio = new Audio('timerend.mp3');
    audio.play().catch(e => console.error("Audio playback failed:", e));
  } catch (err) {
    console.error("Failed to play audio:", err);
  }
}

function updateUI() {
  if (remaining > 0) {
    if (!timerStarted) {
      doneBtn.disabled = false;
      doneBtn.textContent = 'Start';
      countdownEl.textContent = `${remaining}s`;
    } else {
      doneBtn.disabled = true;
      doneBtn.textContent = `Done (${remaining}s)`;
      countdownEl.textContent = `${remaining}s`;
    }
  } else {
    doneBtn.disabled = false;
    doneBtn.textContent = 'Done';
    if (content.pauseScreenHoldSeconds > 0) {
      countdownEl.textContent = '0s';
    }
  }
}

if (remaining > 0) {
  countdownEl.style.display = 'block';
  updateUI();
} else {
  updateUI();
}

doneBtn.addEventListener('click', () => {
  if (doneBtn.disabled) return;

  if (remaining > 0 && !timerStarted) {
    // Start the timer countdown
    timerStarted = true;
    updateUI();
    holdInterval = setInterval(() => {
      remaining -= 1;
      updateUI();
      if (remaining <= 0) {
        clearInterval(holdInterval);
        playTimerEndSound();
        updateUI();
      }
    }, 1000);
  } else {
    // Submit done
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ action: 'WELLBEING_REMINDER_DONE', wellbeingType });
    }
  }
});
