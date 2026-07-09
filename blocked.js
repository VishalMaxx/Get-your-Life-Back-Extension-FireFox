// ── CONFIG & PARAMS ──
const params = new URLSearchParams(window.location.search);
const appLabel = params.get('app') || 'Website';
const targetUrl = params.get('url') || 'https://www.google.com';

let appDomain = 'website';
try {
  appDomain = new URL(targetUrl).hostname.replace('www.', '');
} catch(e) {
  appDomain = targetUrl;
}

// Global state variables
let reflectionCount = 0;
let reflectionInterval;
let breatheInterval;
let pickerMode = 'block'; // 'block' or 'use'
let selectedMinutes = 10; // Default selected time
let countdownInterval;

const itemHeight = 128; // height of each scroll item in css (matches lineOffset * 2)

// ── DOM ELEMENTS ──
const viewReflection = document.getElementById('viewReflection');
const viewPicker = document.getElementById('viewPicker');
const viewTimer = document.getElementById('viewTimer');

const bodyEl = document.body;

// ── INIT ──
document.addEventListener('DOMContentLoaded', () => {
  setupDynamicLogo();
  checkActiveBlock();
});

// Setup dynamic favicon loading based on domain name
function setupDynamicLogo() {
  const faviconUrl = `https://www.google.com/s2/favicons?sz=64&domain=${appDomain}`;
  const pickerIcon = document.getElementById('pickerAppIcon');
  const timerIcon = document.getElementById('timerAppIcon');
  
  if (pickerIcon) pickerIcon.src = faviconUrl;
  if (timerIcon) timerIcon.src = faviconUrl;
  
  // Also replace any static website placeholders in labels
  document.getElementById('blockNudgeBtn').textContent = `Block ${appLabel}`;
  document.getElementById('continueBtn').textContent = `Continue Anyway`;
}

// Check if this domain is currently locked under an active block session
function checkActiveBlock() {
  chrome.storage.local.get(['active_blocks'], (result) => {
    const activeBlocks = result.active_blocks || {};
    const expiration = activeBlocks[appDomain];
    
    if (expiration && expiration > Date.now()) {
      // Direct jump to Timer View (Blue Calm)
      switchToView('timer');
      startStrictTimer(expiration);
    } else {
      // Normal reflection gate (Red Alert)
      switchToView('reflection');
      startReflectionGate();
    }
  });
}

// View manager
function switchToView(viewName) {
  viewReflection.classList.remove('active');
  viewPicker.classList.remove('active');
  viewTimer.classList.remove('active');
  
  if (viewName === 'reflection') {
    viewReflection.classList.add('active');
    bodyEl.className = 'wash-red';
  } else if (viewName === 'picker') {
    viewPicker.classList.add('active');
    bodyEl.className = 'wash-transition';
  } else if (viewName === 'timer') {
    viewTimer.classList.add('active');
    bodyEl.className = 'wash-blue';
  }
}

// ── VIEW 1: REFLECTION GATE ──
function startReflectionGate() {
  // Clear any existing timers
  clearInterval(reflectionInterval);
  clearInterval(breatheInterval);
  
  reflectionCount = 0;
  const timerEl = document.getElementById('reflectionTimer');
  const continueBtn = document.getElementById('continueBtn');
  const breatheText = document.getElementById('breatheText');
  
  timerEl.textContent = '0s';
  continueBtn.disabled = true;
  continueBtn.textContent = 'Continue Anyway (10s)';
  
  // 1. Reflection stopwatch counts up
  reflectionInterval = setInterval(() => {
    reflectionCount++;
    timerEl.textContent = `${reflectionCount}s`;
    
    // Gate unlocks after 10s
    if (reflectionCount >= 10) {
      continueBtn.disabled = false;
      continueBtn.textContent = 'Continue Anyway';
    } else {
      continueBtn.textContent = `Continue Anyway (${10 - reflectionCount}s)`;
    }
  }, 1000);
  
  // 2. Breathing text loop (4s in, 4s out)
  let breatheCycle = 0;
  breatheText.innerHTML = 'Breathe<br>In';
  
  breatheInterval = setInterval(() => {
    breatheCycle++;
    if (breatheCycle % 2 === 0) {
      breatheText.innerHTML = 'Breathe<br>In';
    } else {
      breatheText.innerHTML = 'Breathe<br>Out';
    }
  }, 4000);
  
  // 3. Action Bindings
  document.getElementById('blockNudgeBtn').onclick = () => {
    openPicker('block');
  };
  
  continueBtn.onclick = () => {
    if (!continueBtn.disabled) {
      openPicker('use');
    }
  };
  
  document.getElementById('exitBtn').onclick = () => {
    handleExit();
  };
}

function handleExit() {
  // background.js owns what happens next (Settings > "When I tap Exit") via chrome.tabs,
  // which works regardless of how this tab was opened — unlike window.close(), which only
  // works for tabs opened by a script and silently no-ops otherwise.
  chrome.runtime.sendMessage({
    action: "comply_domain",
    domain: appDomain,
    isScheduledWindow: false
  });
}


// ── VIEW 2: TIME PICKER ──
function openPicker(mode) {
  pickerMode = mode;
  switchToView('picker');
  
  // Adjust picker layout and labels
  const titleEl = document.getElementById('pickerTitle');
  const usagePanel = document.getElementById('pickerUsagePanel');
  const startBtn = document.getElementById('pickerStartBtn');
  
  if (mode === 'block') {
    titleEl.textContent = `Block ${appLabel}`;
    usagePanel.style.display = 'flex';
    startBtn.textContent = 'Start Now';
    // Generate dummy usage data (can be replaced with live stats later)
    document.getElementById('usageToday').textContent = '2h 3m';
    document.getElementById('usageWeek').textContent = '5h 6m';
  } else {
    titleEl.textContent = `Use ${appLabel}`;
    usagePanel.style.display = 'none';
    startBtn.textContent = 'Start Now';
  }
  
  // Build and position the scroll wheel
  buildScrollWheel();
  
  // Bind buttons
  document.getElementById('pickerBackBtn').onclick = () => {
    switchToView('reflection');
  };
  
  startBtn.onclick = () => {
    executePickerAction();
  };
}

function buildScrollWheel() {
  const wheel = document.getElementById('minutesWheel');
  wheel.innerHTML = '';
  
  // Populate numbers 1 to 300
  for (let i = 1; i <= 300; i++) {
    const item = document.createElement('div');
    item.className = 'wheel-item';
    item.textContent = i;
    item.dataset.val = i;
    wheel.appendChild(item);
  }
  
  // Handle wheel scrolling to update deltas live
  wheel.onscroll = () => {
    const scrollPos = wheel.scrollTop;
    const index = Math.round(scrollPos / itemHeight);
    const val = Math.max(1, Math.min(300, index + 1));
    
    if (val !== selectedMinutes) {
      selectedMinutes = val;
      updateLiveDeltas(selectedMinutes);
    }
  };
  
  // Scroll to default (10 minutes)
  selectedMinutes = 10;
  wheel.scrollTop = (selectedMinutes - 1) * itemHeight;
  updateLiveDeltas(selectedMinutes);
}

function updateLiveDeltas(minutes) {
  const complianceVal = document.getElementById('deltaValCompliance');
  const sovereigntyVal = document.getElementById('deltaValSovereignty');
  const compulsionVal = document.getElementById('deltaValCompulsion');
  
  const complianceArrow = document.getElementById('deltaArrowCompliance');
  const sovereigntyArrow = document.getElementById('deltaArrowSovereignty');
  const compulsionArrow = document.getElementById('deltaArrowCompulsion');
  
  if (pickerMode === 'block') {
    // Commit Block Deltas (All Green)
    // Compliance: +0.5 per min
    // Sovereignty: +0.25 per min
    // Compulsion: -1.0 per min
    const comp = (0.5 * minutes).toFixed(1).replace('.0', '');
    const sov = (0.25 * minutes).toFixed(2).replace('.00', '');
    const compl = minutes;
    
    complianceVal.textContent = comp;
    sovereigntyVal.textContent = sov;
    compulsionVal.textContent = compl;
    
    complianceArrow.className = 'delta-arrow green';
    complianceArrow.textContent = '↗';
    sovereigntyArrow.className = 'delta-arrow green';
    sovereigntyArrow.textContent = '↗';
    compulsionArrow.className = 'delta-arrow green';
    compulsionArrow.textContent = '↘';
  } else {
    // Continue Anyway Deltas (All Red)
    // Compliance: -2.0 flat
    // Sovereignty: -0.5 flat
    // Compulsion: +5.0 scales up with selected bypass minutes (capped at 30m)
    const factor = Math.min(3.0, Math.max(0.5, minutes / 10.0));
    const compl = (5.0 * factor).toFixed(1).replace('.0', '');
    
    complianceVal.textContent = '2';
    sovereigntyVal.textContent = '0.5';
    compulsionVal.textContent = compl;
    
    complianceArrow.className = 'delta-arrow red';
    complianceArrow.textContent = '↘';
    sovereigntyArrow.className = 'delta-arrow red';
    sovereigntyArrow.textContent = '↘';
    compulsionArrow.className = 'delta-arrow red';
    compulsionArrow.textContent = '↗';
  }
}

// Save active block or register temporary whitelist bypass
function executePickerAction() {
  if (pickerMode === 'block') {
    const expiration = Date.now() + selectedMinutes * 60 * 1000;
    
    // Save to storage
    chrome.storage.local.get(['active_blocks'], (result) => {
      const activeBlocks = result.active_blocks || {};
      activeBlocks[appDomain] = expiration;
      
      chrome.storage.local.set({ active_blocks: activeBlocks }, () => {
        // Log SELF_BLOCK event and sync
        chrome.runtime.sendMessage({
          action: "self_block_domain",
          domain: appDomain,
          minutes: selectedMinutes
        }, () => {
          // Transition to active timer view
          switchToView('timer');
          startStrictTimer(expiration);
        });
      });
    });
  } else {
    // Register bypass whitelist duration in background worker and let it redirect the tab
    chrome.runtime.sendMessage({ 
      action: "whitelist_domain", 
      domain: appDomain, 
      minutes: selectedMinutes,
      url: targetUrl
    });
  }
}


// ── VIEW 3: STRICT TIMER ──
function startStrictTimer(expiration) {
  clearInterval(countdownInterval);
  
  document.getElementById('timerTitle').textContent = `${appLabel} Blocked`;
  
  const minEl = document.getElementById('timerMinutes');
  const secEl = document.getElementById('timerSeconds');
  
  function update() {
    const remainingMs = expiration - Date.now();
    
    if (remainingMs <= 0) {
      clearInterval(countdownInterval);
      // Remove expired block from storage and check status
      chrome.storage.local.get(['active_blocks'], (result) => {
        const activeBlocks = result.active_blocks || {};
        delete activeBlocks[appDomain];
        chrome.storage.local.set({ active_blocks: activeBlocks }, () => {
          checkActiveBlock();
        });
      });
      return;
    }
    
    const totalSecs = Math.ceil(remainingMs / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    
    minEl.textContent = mins;
    secEl.textContent = secs.toString().padStart(2, '0');
  }
  
  update();
  countdownInterval = setInterval(update, 1000);
  
  document.getElementById('timerExitBtn').onclick = () => {
    handleExit();
  };
}
