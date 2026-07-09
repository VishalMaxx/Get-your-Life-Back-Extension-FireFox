// GetYourLifeBack Chrome Extension — Popup Controller
const isExtension = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

const storage = {
  get: (key, callback) => {
    if (isExtension) {
      chrome.storage.local.get([key], (result) => callback(result[key]));
    } else {
      const data = localStorage.getItem(key);
      callback(data ? JSON.parse(data) : null);
    }
  },
  set: (key, value, callback) => {
    if (isExtension) {
      chrome.storage.local.set({ [key]: value }, callback);
    } else {
      localStorage.setItem(key, JSON.stringify(value));
      if (callback) callback();
    }
  }
};

// State Variables. Scores seed at the same baselines the local engine returns for a
// signed-out user (see background.js recalculateScores) so the first paint is honest
// rather than a demo number that then jumps when real values load.
let blockedDomains = ["youtube.com", "instagram.com", "twitter.com"];
let sovereignty = 100;
let streakDays = 0;
let clarity = 50;
let compliance = 65;
let sovereigntyLevel = 1;
let sovereigntyChange = 0;
let complianceChange = 0;
let clarityChange = 0;
let protocolTimeRemaining = 0;
let protocolInterval = null;

// DOM Elements
const syncStatusDot = document.getElementById("syncStatusDot");
const syncStatusText = document.getElementById("syncStatusText");
const sovereigntyValue = document.getElementById("sovereigntyValue");
const levelValue = document.getElementById("levelValue");
const sovereigntyChangeValue = document.getElementById("sovereigntyChangeValue");
const complianceChangeValue = document.getElementById("complianceChangeValue");
const clarityChangeValue = document.getElementById("clarityChangeValue");
const streakValue = document.getElementById("streakValue");
const complianceValue = document.getElementById("complianceValue");
const clarityValue = document.getElementById("clarityValue");
const protocolTimer = document.getElementById("protocolNavTimer");
const protocolBadge = document.getElementById("protocolNavSubtitle");
const domainList = document.getElementById("domainList");
const domainInput = document.getElementById("domainInput");
const addDomainBtn = document.getElementById("addDomainBtn");
const blockerCount = document.getElementById("blockerCount");

// Auth DOM Elements
const authView = document.getElementById("authView");
const dashboardView = document.getElementById("dashboardView");
const authEmail = document.getElementById("authEmail");
const authPassword = document.getElementById("authPassword");
const signInBtn = document.getElementById("signInBtn");
const signInBtnText = document.getElementById("signInBtnText");
const signInBtnSpinner = document.getElementById("signInBtnSpinner");
const authErrorMsg = document.getElementById("authErrorMsg");

// Google Auth Elements
const googleSignInBtn = document.getElementById("googleSignInBtn");
const googleBtnText = document.getElementById("googleBtnText");
const googleBtnSpinner = document.getElementById("googleBtnSpinner");

// Free/Pro Header Elements
const connectAccountBtn = document.getElementById("connectAccountBtn");
const backToLocalBtn = document.getElementById("backToLocalBtn");

// Nav Cards
const navBlockedSites = document.getElementById("navBlockedSites");
const navQuickFocus = document.getElementById("navQuickFocus");
const navWorkProfile = document.getElementById("navWorkProfile");
const navWellbeingTools = document.getElementById("navWellbeingTools");
const navProfile = document.getElementById("navProfile");

// Blocklist Subview
const blocklistView = document.getElementById("blocklistView");
const blocklistBackBtn = document.getElementById("blocklistBackBtn");
const domainListEmpty = document.getElementById("domainListEmpty");

// Pro Wall
const proWallOverlay = document.getElementById("proWallOverlay");
const proWallTitle = document.getElementById("proWallTitle");
const proWallDesc = document.getElementById("proWallDesc");
const proWallDismissBtn = document.getElementById("proWallDismissBtn");
const proWallUpgradeBtn = document.getElementById("proWallUpgradeBtn");
const proWallBenefits = document.getElementById("proWallBenefits");

// Benefits Arrays
const EXTENSION_BENEFITS = [
  "🛡️ Free tier features plus Work Profile",
  "⚡ Quick block sessions to stay focused",
  "📅 Plan your day with active session scheduling",
  "💼 Work Profile lets you fully schedule your days and weeks for work"
];

const SUITE_BENEFITS = [
  "🚀 Everything in Extension Pro plus GetYourLifeBack App",
  "📱 Android App deep lock protocols and mobile blocks",
  "🔄 Cross-device mobile and web blocker sync",
  "☁️ Real-time score and active protocol sync across all devices"
];

// Track current authenticated state
let isProUser = false;
let lastDashboardMode = "free"; // "free" or "synced"
let lastUid = null;

// Auth view mode — mirrors the Android app's SignUpScreen, which always shows account
// creation first and lets a returning user switch to "Sign in". Previously this popup only
// ever called SIGN_IN, with no way to create a brand-new account from the extension at all.
let authMode = "SIGN_UP"; // "SIGN_UP" | "SIGN_IN"

// ── SUBVIEW TRANSITIONS ──
// Every full-takeover subview (Blocklist, Quick Focus, Work Profile, Profile) used to
// snap in/out with an instant display:none <-> flex swap. These two helpers give them a
// consistent fade + slide instead, without touching each subview's own data-loading logic.
const SUBVIEW_TRANSITION_MS = 200;

function revealSubview(el) {
  el.style.display = "flex";
  el.classList.remove("subview-visible");
  void el.offsetWidth; // force reflow so the class add below actually transitions
  requestAnimationFrame(() => el.classList.add("subview-visible"));
}

// onHidden (if given) fires AFTER the fade-out finishes and display is set to none — never
// synchronously. Every call site used to show the destination view immediately, while this
// view kept rendering (display:flex, mid fade-out) for another 200ms — since subviews are
// plain normal-flow siblings with no overlay/z-index, both were visible stacked on top of
// each other for that window. Routing the destination show through this callback closes
// that gap.
function dismissSubview(el, onHidden) {
  el.classList.remove("subview-visible");
  setTimeout(() => {
    el.style.display = "none";
    if (onHidden) onHidden();
  }, SUBVIEW_TRANSITION_MS);
}

// Initialize UI
function init() {
  setAuthMode("SIGN_UP"); // binds the toggle link before checkAuth/showFreeDashboard resolve
  checkAuth();
  refreshAppCheck();

  // Set up event listeners
  addDomainBtn.addEventListener("click", handleAddDomain);
  domainInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") handleAddDomain();
  });
  
  signInBtn.addEventListener("click", handleSignIn);
  googleSignInBtn.addEventListener("click", handleGoogleSignIn);

  connectAccountBtn.addEventListener("click", showAuth);
  backToLocalBtn.addEventListener("click", (e) => {
    e.preventDefault();
    showFreeDashboard();
  });

  // Nav Card Clicks
  navBlockedSites.addEventListener("click", openBlocklistView);
  navQuickFocus.addEventListener("click", () => {
    if (isProUser) {
      openQuickFocusView();
    } else {
      showProWall("⚡ Quick Focus Session", "Start a timed focus session that blocks all distracting websites for a set duration. Earn bonus Sovereignty points for every completed session.", "extension");
    }
  });
  navWorkProfile.addEventListener("click", () => {
    if (isProUser) {
      openWorkProfileView();
    } else {
      showProWall("💼 Work Profile", "Create a daily or weekly schedule of allowed work websites. Everything else gets blocked during work hours. Earn +10 Sovereignty bonus points per hour of compliance.", "extension");
    }
  });
  // Wellbeing Tools is open to everyone — Water Break is Free tier; only the Eye Rest card
  // inside is Pro-gated (see setupWellbeingToolsListeners).
  navWellbeingTools.addEventListener("click", openWellbeingToolsView);
  navProfile.addEventListener("click", openProfileView);

  setupQuickFocusListeners();
  setupWorkProfileListeners();
  setupWellbeingToolsListeners();
  setupProfileListeners();
  setupSettingsListeners();
  setupConsentListeners();

  // Blocklist Pro Upsell Click
  const proUpsell = document.getElementById("blocklistProUpsell");
  if (proUpsell) {
    proUpsell.addEventListener("click", () => {
      showProWall("💼 Work Profile & Scheduling", "Upgrade to Pro to schedule allowed website schedules, create daily/weekly work profiles, and unlock timed quick focus sessions.", "extension");
    });
  }

  // Blocklist back button
  blocklistBackBtn.addEventListener("click", returnToDashboard);

  // Pro Wall Pricing Option Selection
  const priceOptions = document.querySelectorAll(".price-option");
  priceOptions.forEach(option => {
    option.addEventListener("click", () => {
      priceOptions.forEach(opt => opt.classList.remove("selected"));
      option.classList.add("selected");
      updateProWallBenefits(option.getAttribute("data-tier"));
    });
  });

  // Pro Wall dismiss and upgrade
  proWallDismissBtn.addEventListener("click", hideProWall);
  proWallUpgradeBtn.addEventListener("click", handleUpgradeClick);
}

// Start checkout for the selected pricing option. Requires sign-in first (founder
// decision — a purchase must always be matchable to an account): if the user isn't
// signed in, this sends them to the sign-in screen instead of starting checkout.
function handleUpgradeClick() {
  const proWallError = document.getElementById("proWallError");
  if (proWallError) proWallError.style.display = "none";

  if (!isExtension) {
    console.log("Checkout is only available inside the Chrome Extension.");
    return;
  }

  if (lastDashboardMode !== "synced" || !lastUid) {
    hideProWall();
    showAuth();
    showError("Sign in to upgrade to Extension Pro — this lets us match your purchase to your account.");
    return;
  }

  const selectedOption = document.querySelector(".price-option.selected");
  const priceId = selectedOption ? selectedOption.getAttribute("data-price-id") : "ext_monthly";
  const productId = WebEntitlementEngine.productIdForPriceId(priceId);

  proWallUpgradeBtn.disabled = true;
  const originalText = proWallUpgradeBtn.textContent;
  proWallUpgradeBtn.textContent = "Opening checkout…";

  chrome.runtime.sendMessage({ action: "START_CHECKOUT", productId }, (response) => {
    proWallUpgradeBtn.disabled = false;
    proWallUpgradeBtn.textContent = originalText;

    if (response && response.success) {
      // The checkout tab now has focus, which closes this popup automatically (same
      // unavoidable MV3 behavior as Google Sign-In) — reopening the extension afterward
      // will reflect the new tier once the checkout tab closes and the background
      // entitlement check completes.
      return;
    }
    if (response && response.reason === "sign_in_required") {
      hideProWall();
      showAuth();
      showError("Sign in to upgrade to Extension Pro — this lets us match your purchase to your account.");
      return;
    }
    // Surface the failure in the Pro Wall itself — previously this only logged to the
    // console, so a failed checkout (e.g. a misconfigured product) looked to the user like
    // the Upgrade button silently did nothing.
    const reason = (response && response.reason) || "Could not start checkout. Please try again.";
    console.error("Checkout failed:", reason);
    if (proWallError) {
      proWallError.textContent = reason;
      proWallError.style.display = "block";
    }
  });
}

// Check if user is authenticated via background service worker
function checkAuth() {
  if (isExtension) {
    chrome.runtime.sendMessage({ action: "CHECK_AUTH" }, (response) => {
      if (response && response.authenticated) {
        showDashboard(response.uid);
      } else {
        showFreeDashboard(); // Default to Free Mode instead of forcing Sign In
      }
    });
  } else {
    // Non-extension fallback (development)
    const mockAuth = localStorage.getItem("mock_auth_uid");
    if (mockAuth) {
      showDashboard(mockAuth);
    } else {
      showFreeDashboard();
    }
  }
}

// Show the authentication screen — always resets to Sign Up first, same as the mobile app.
function showAuth() {
  setAuthMode("SIGN_UP");
  authView.style.display = "flex";
  dashboardView.style.display = "none";
  connectAccountBtn.style.display = "none";
  syncStatusDot.className = "status-dot";
  syncStatusText.textContent = "Connecting";
  authEmail.focus();
}

// Switch the auth card between "Create your account" (default) and "Welcome back" (Sign
// In), re-labeling the submit button, Google button, and the toggle link itself.
function setAuthMode(mode) {
  authMode = mode;
  authErrorMsg.style.display = "none";

  const authTitle = document.getElementById("authTitle");
  const authSubtitle = document.getElementById("authSubtitle");
  const toggle = document.getElementById("authModeToggle");

  if (mode === "SIGN_IN") {
    if (authTitle) authTitle.textContent = "Welcome back";
    if (authSubtitle) authSubtitle.textContent = "Sign in to sync your focus blocks, active protocols, and scorecard with your Android app.";
    signInBtnText.textContent = "Sign In";
    googleBtnText.textContent = "Sign in with Google";
    if (toggle) toggle.innerHTML = 'New here? <a href="#" id="authModeToggleLink">Create an account</a>';
  } else {
    if (authTitle) authTitle.textContent = "Create your account";
    if (authSubtitle) authSubtitle.textContent = "Sign up to sync your focus blocks, active protocols, and scorecard with your Android app.";
    signInBtnText.textContent = "Create Account";
    googleBtnText.textContent = "Sign up with Google";
    if (toggle) toggle.innerHTML = 'Already have an account? <a href="#" id="authModeToggleLink">Sign in</a>';
  }

  const link = document.getElementById("authModeToggleLink");
  if (link) {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      setAuthMode(authMode === "SIGN_UP" ? "SIGN_IN" : "SIGN_UP");
    });
  }
}

// Show the dashboard screen in Free Mode (Local only, no cloud sync)
function showFreeDashboard() {
  lastDashboardMode = "free";
  lastUid = null;
  authView.style.display = "none";
  dashboardView.style.display = "flex";
  connectAccountBtn.style.display = "inline-block";
  syncStatusDot.className = "status-dot"; // Gray dot (no pulse)
  syncStatusText.textContent = "Free Tier";

  // Load blocked domains from local storage
  storage.get("blocked_domains", (domains) => {
    if (domains) {
      blockedDomains = domains;
    } else {
      storage.set("blocked_domains", blockedDomains);
    }
    updateBlockerCount();
  });

  // Load scores and protocol data locally (Free Tier computes everything locally)
  loadLiveScoresAndProtocols();

  // Apply tier-based card layout
  applyTierLayout();

  // Start Protocol Countdown Timer
  startProtocolTimer();
}

// Show the dashboard screen in Synced Mode (Connected to Firestore)
function showDashboard(uid) {
  lastDashboardMode = "synced";
  lastUid = uid;
  authView.style.display = "none";
  dashboardView.style.display = "flex";
  connectAccountBtn.style.display = "none";
  // Honest starting state — a real "Synced" only lands once background.js's
  // syncFirestoreLoop() actually finishes (see the SYNC_STATUS listener in init()).
  syncStatusDot.className = "status-dot syncing";
  syncStatusText.textContent = "Syncing…";

  // Load blocked domains from local storage
  storage.get("blocked_domains", (domains) => {
    if (domains) {
      blockedDomains = domains;
    } else {
      storage.set("blocked_domains", blockedDomains);
    }
    updateBlockerCount();
  });

  // Load scores and protocol data (will be synced from Firestore in Task 3)
  loadLiveScoresAndProtocols();

  // Apply tier-based card layout
  applyTierLayout();

  // Start Protocol Countdown Timer
  startProtocolTimer();

  // Actually request a sync — nothing else guarantees one happens when the popup opens
  // (background.js's own cycle runs on its own 5-minute cadence otherwise, which could
  // leave the status honestly stuck on "Syncing…" for minutes with nothing to show for it).
  if (isExtension) {
    chrome.runtime.sendMessage({ action: "SYNC_PULL" });
  }
}

// Update the blocker count badge on the nav card
function updateBlockerCount() {
  const count = Object.keys(blockedDomains).length;
  blockerCount.textContent = count;
  // Show/hide empty state in blocklist subview
  if (domainListEmpty) {
    domainListEmpty.style.display = count === 0 ? "flex" : "none";
  }
}

// Open the Blocklist Management subview
function openBlocklistView() {
  dashboardView.style.display = "none";
  revealSubview(blocklistView);
  renderDomains();
  domainInput.focus();
}

// Return from a subview back to the correct dashboard mode
function returnToDashboard() {
  dismissSubview(blocklistView, () => {
    if (lastDashboardMode === "synced") {
      showDashboard(lastUid);
    } else {
      showFreeDashboard();
    }
  });
}

// Show Pro Wall with customized feature title and description
function showProWall(title, desc, defaultTier = "extension") {
  proWallTitle.textContent = title || "Unlock Pro Features";
  proWallDesc.textContent = desc || "Upgrade to Pro to access advanced scheduling, timed focus sessions, and full cloud sync.";
  
  // Reset selected state to match defaultTier
  const priceOptions = document.querySelectorAll(".price-option");
  priceOptions.forEach(opt => {
    opt.classList.remove("selected");
    // Default-select the monthly option of the selected tier
    if (opt.getAttribute("data-tier") === defaultTier && opt.getAttribute("data-price-id").includes("monthly")) {
      opt.classList.add("selected");
    }
  });

  updateProWallBenefits(defaultTier);
  proWallOverlay.style.display = "flex";
}

// Update benefits checklist dynamically depending on tier
function updateProWallBenefits(tier) {
  proWallBenefits.innerHTML = "";
  const benefits = tier === "suite" ? SUITE_BENEFITS : EXTENSION_BENEFITS;
  benefits.forEach(benefit => {
    const item = document.createElement("div");
    item.className = "pro-benefit";
    item.textContent = benefit;
    proWallBenefits.appendChild(item);
  });
}

// Dismiss Pro Wall
function hideProWall() {
  proWallOverlay.style.display = "none";
}

// Subscription Tiers: "free" | "extension_pro" | "full_pro"
let subscriptionTier = "free";

// Read the real tier from storage (background.js's Phase 4 entitlement check writes it
// here) before rendering — this used to always render as "free" since nothing loaded the
// stored value into this variable.
function applyTierLayout() {
  storage.get("subscriptionTier", (tier) => {
    subscriptionTier = tier || "free";
    renderTierLayout();
  });
}

function renderTierLayout() {
  const navTodayProtocol = document.getElementById("navTodayProtocol");
  const scoreCard = document.querySelector(".score-card-hero");
  const quickFocusBadge = navQuickFocus.querySelector(".nav-card-pro-badge");
  const workProfileBadge = navWorkProfile.querySelector(".nav-card-pro-badge");
  const proUpsell = document.getElementById("blocklistProUpsell");

  if (subscriptionTier === "full_pro") {
    // Full Pro ($9.99/mo or $99.99/yr): Show protocol card above blocked websites
    navTodayProtocol.style.display = "flex";
    // Move protocol card right after the score card (above blocked websites)
    scoreCard.after(navTodayProtocol);
    
    // Hide PRO badges
    if (quickFocusBadge) quickFocusBadge.style.display = "none";
    if (workProfileBadge) workProfileBadge.style.display = "none";
    isProUser = true;
  } else if (subscriptionTier === "extension_pro") {
    // Extension Pro ($3.99/mo or $39.99/yr): No protocol card, unlock features
    navTodayProtocol.style.display = "none";
    if (quickFocusBadge) quickFocusBadge.style.display = "none";
    if (workProfileBadge) workProfileBadge.style.display = "none";
    isProUser = true;
  } else {
    // Free: Protocol card hidden, features locked with PRO badges
    navTodayProtocol.style.display = "none";
    if (quickFocusBadge) quickFocusBadge.style.display = "inline-block";
    if (workProfileBadge) workProfileBadge.style.display = "inline-block";
    isProUser = false;
  }

  if (proUpsell) {
    proUpsell.style.display = isProUser ? "none" : "flex";
  }
}

// Load dynamic scores and protocol progress
function loadLiveScoresAndProtocols() {
  if (isExtension) {
    chrome.storage.local.get([
      "sovereignty", "streakDays", "clarity", "compliance", "activeProtocol",
      "sovereigntyLevel", "sovereigntyChange", "complianceChange", "clarityChange"
    ], (data) => {
      sovereignty = data.sovereignty ?? 100;
      streakDays = data.streakDays ?? 0;
      clarity = data.clarity ?? 50;
      compliance = data.compliance ?? 65;
      sovereigntyLevel = data.sovereigntyLevel ?? 1;
      sovereigntyChange = data.sovereigntyChange ?? 0;
      complianceChange = data.complianceChange ?? 0;
      clarityChange = data.clarityChange ?? 0;

      updateScorecard();

      if (data.activeProtocol) {
        document.getElementById("protocolTitle").textContent = data.activeProtocol.title || "Deep Lock Mode";
        document.getElementById("protocolDesc").textContent = data.activeProtocol.description || "Adaptive website blocking active.";
        if (data.activeProtocol.timeRemaining !== undefined) {
          protocolTimeRemaining = data.activeProtocol.timeRemaining;
        }
      }
    });
  } else {
    updateScorecard();
  }
}

// Handle Sign Up / Sign In submission (same form, routed by authMode)
function handleSignIn() {
  const email = authEmail.value.trim();
  const password = authPassword.value;

  if (!email || !password) {
    showError("Please enter both email and password.");
    return;
  }

  requireConsent(() => performSignIn(email, password));
}

function performSignIn(email, password) {
  // Show loading spinner
  signInBtn.disabled = true;
  signInBtnText.style.display = "none";
  signInBtnSpinner.style.display = "inline-block";
  authErrorMsg.style.display = "none";

  const action = authMode === "SIGN_UP" ? "SIGN_UP" : "SIGN_IN";

  if (isExtension) {
    chrome.runtime.sendMessage({ action, email, password }, (response) => {
      // Re-enable button
      signInBtn.disabled = false;
      signInBtnText.style.display = "inline";
      signInBtnSpinner.style.display = "none";

      if (response && response.success) {
        showDashboard(response.uid);
        // Ask for the verification code right away — not as a separate, easy-to-miss
        // Profile-screen action — mirroring the Android app's post-sign-up OTP step.
        if (action === "SIGN_UP") triggerPostSignupOtp();
      } else {
        showError(response ? response.error : "Authentication failed.");
      }
    });
  } else {
    // Mock login/signup for developer testing outside Chrome
    setTimeout(() => {
      signInBtn.disabled = false;
      signInBtnText.style.display = "inline";
      signInBtnSpinner.style.display = "none";
      if (action === "SIGN_UP" || (email === "test@gylb.com" && password === "password")) {
        localStorage.setItem("mock_auth_uid", "mock_uid_123");
        showDashboard("mock_uid_123");
      } else {
        showError("Invalid email or password (use test@gylb.com / password).");
      }
    }, 1000);
  }
}

// Handle Google Sign In
function handleGoogleSignIn() {
  requireConsent(() => performGoogleSignIn());
}

function performGoogleSignIn() {
  googleSignInBtn.disabled = true;
  googleBtnText.style.display = "none";
  googleBtnSpinner.style.display = "inline-block";
  authErrorMsg.style.display = "none";

  if (isExtension) {
    chrome.runtime.sendMessage({ action: "SIGN_IN_GOOGLE" }, (response) => {
      googleSignInBtn.disabled = false;
      googleBtnText.style.display = "inline";
      googleBtnSpinner.style.display = "none";

      if (response && response.success) {
        showDashboard(response.uid);
      } else {
        showError(response ? response.error : "Google Sign-In failed.");
      }
    });
  } else {
    setTimeout(() => {
      googleSignInBtn.disabled = false;
      googleBtnText.style.display = "inline";
      googleBtnSpinner.style.display = "none";
      showError("Google Sign-In is only supported inside the Chrome Extension.");
    }, 1000);
  }
}

// ── CONSENT (Chrome Web Store Limited Use policy, effective 2026-08-01: disclosure must
// be prominent and precede consent). Shown once, before the FIRST sign-in/account-link
// action — free-tier/signed-out use never triggers this, since it makes no network calls
// and collects nothing. Once accepted, `consent_accepted_at` is stored and this never
// shows again.
let pendingConsentAction = null;

function requireConsent(onAccepted) {
  storage.get("consent_accepted_at", (acceptedAt) => {
    if (acceptedAt) {
      onAccepted();
    } else {
      pendingConsentAction = onAccepted;
      document.getElementById("consentOverlay").style.display = "flex";
    }
  });
}

function setupConsentListeners() {
  const agreeBtn = document.getElementById("consentAgreeBtn");
  const cancelBtn = document.getElementById("consentCancelBtn");
  const overlay = document.getElementById("consentOverlay");

  if (agreeBtn) {
    agreeBtn.addEventListener("click", () => {
      storage.set("consent_accepted_at", Date.now(), () => {
        overlay.style.display = "none";
        const action = pendingConsentAction;
        pendingConsentAction = null;
        if (action) action();
      });
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
      pendingConsentAction = null;
      overlay.style.display = "none";
    });
  }
}

// Handle Sign Out
function handleSignOut() {
  if (isExtension) {
    chrome.runtime.sendMessage({ action: "SIGN_OUT" }, () => {
      showAuth();
    });
  } else {
    localStorage.removeItem("mock_auth_uid");
    showAuth();
  }
}

// Render error message in Auth View
function showError(message) {
  authErrorMsg.textContent = message;
  authErrorMsg.style.display = "block";
}

// Render a "vs yesterday" delta as an arrow + magnitude, colored by direction.
function renderDeltaBadge(el, delta) {
  if (!el) return;
  const rounded = Math.round(Math.abs(delta) * 10) / 10;
  if (delta > 0) {
    el.textContent = `↗ ${rounded}`;
    el.className = "score-change-badge positive";
  } else if (delta < 0) {
    el.textContent = `↘ ${rounded}`;
    el.className = "score-change-badge negative";
  } else {
    el.textContent = "→ 0";
    el.className = "score-change-badge neutral";
  }
}

// Update scorecard values in the DOM
function updateScorecard() {
  sovereigntyValue.textContent = sovereignty;
  streakValue.textContent = streakDays;
  clarityValue.textContent = clarity;
  complianceValue.textContent = compliance;
  levelValue.textContent = sovereigntyLevel;
  renderDeltaBadge(sovereigntyChangeValue, sovereigntyChange);
  renderDeltaBadge(complianceChangeValue, complianceChange);
  renderDeltaBadge(clarityChangeValue, clarityChange);
}

// Render the blocked domains
function renderDomains() {
  domainList.innerHTML = "";
  blockedDomains.forEach((domain) => {
    const item = document.createElement("div");
    item.className = "domain-item";

    const name = document.createElement("span");
    name.className = "domain-name";
    name.textContent = domain;

    const removeBtn = document.createElement("button");
    removeBtn.className = "domain-remove";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => handleRemoveDomain(domain));

    item.appendChild(name);
    item.appendChild(removeBtn);
    domainList.appendChild(item);
  });
  
  updateBlockerCount();
}

// Add a domain to the blocklist
function handleAddDomain() {
  const value = domainInput.value.trim().toLowerCase();
  const cleanDomain = value.replace(/^(https?:\/\/)?(www\.)?/, "").split("/")[0];
  
  if (cleanDomain && !blockedDomains.includes(cleanDomain)) {
    blockedDomains.push(cleanDomain);
    storage.set("blocked_domains", blockedDomains, () => {
      renderDomains();
      if (isExtension) {
        chrome.runtime.sendMessage({ action: "UPDATE_BLOCKLIST" });
        // Records this add in the synced website-blocklist mirror so it pushes to
        // Firestore and shows up in the phone app's Extension Control screen too.
        chrome.runtime.sendMessage({ action: "SYNC_WEB_SITE_CHANGE", domain: cleanDomain, deleted: false });
      }
    });
    domainInput.value = "";
  }
}

// Remove a domain from the blocklist
function handleRemoveDomain(domain) {
  blockedDomains = blockedDomains.filter((d) => d !== domain);
  storage.set("blocked_domains", blockedDomains, () => {
    renderDomains();
    if (isExtension) {
      chrome.runtime.sendMessage({ action: "UPDATE_BLOCKLIST" });
      chrome.runtime.sendMessage({ action: "SYNC_WEB_SITE_CHANGE", domain, deleted: true });
    }
  });
}

// Countdown timer formatting
function startProtocolTimer() {
  clearInterval(protocolInterval);
  protocolInterval = setInterval(() => {
    if (protocolTimeRemaining > 0) {
      protocolTimeRemaining--;
      const minutes = Math.floor(protocolTimeRemaining / 60);
      const seconds = protocolTimeRemaining % 60;
      protocolTimer.textContent = `${minutes}:${seconds.toString().padStart(2, "0")}`;
    } else {
      clearInterval(protocolInterval);
      protocolTimer.textContent = "0:00";
      protocolBadge.textContent = "Completed";
      protocolBadge.style.backgroundColor = "rgba(34, 197, 94, 0.15)";
      protocolBadge.style.borderColor = "rgba(34, 197, 94, 0.4)";
      protocolBadge.style.color = "var(--discipline-green)";
    }
  }, 1000);
}

// Request App Check token from reCAPTCHA v3 and send to background
function refreshAppCheck() {
  if (isExtension) {
    const iframe = document.getElementById('sandboxIframe');
    if (!iframe) return;

    // Set up one-time listener for the sandbox message response
    const handleSandboxMessage = (event) => {
      if (event.data && event.data.action === 'RECAPTCHA_TOKEN') {
        const token = event.data.token;
        chrome.runtime.sendMessage({ action: "SET_RECAPTCHA_TOKEN", token }, (response) => {
          if (response && response.success) {
            console.log("App Check token successfully refreshed from popup via sandbox.");
          } else {
            console.warn("App Check refresh failed:", response ? response.error : "unknown error");
          }
        });
        window.removeEventListener('message', handleSandboxMessage);
      } else if (event.data && event.data.action === 'RECAPTCHA_ERROR') {
        console.error("reCAPTCHA failed in sandbox:", event.data.error);
        window.removeEventListener('message', handleSandboxMessage);
      }
    };

    window.addEventListener('message', handleSandboxMessage);

    // Send a message to the iframe to run reCAPTCHA
    const postToSandbox = () => {
      iframe.contentWindow.postMessage({ action: 'GET_RECAPTCHA' }, '*');
    };

    if (iframe.contentDocument && iframe.contentDocument.readyState === 'complete') {
      postToSandbox();
    } else {
      iframe.onload = postToSandbox;
    }
  }
}

// ── QUICK FOCUS ENGINE (POPUP CONTROLLER) ──
let quickFocusPollInterval = null;
let selectedScope = "BLOCKLIST";
let selectedDuration = 25;
// Whitelist chosen BEFORE Start, only meaningful for scope ALL. Fixed for the session's
// lifetime once started — see QuickFocusEngine.js's DATA MODEL comment.
let qfWhitelist = [];

/** Renders the editable whitelist pills (Start screen) into #qfWhitelistDomains. */
function renderQfWhitelistPills() {
  const container = document.getElementById("qfWhitelistDomains");
  if (!container) return;
  container.innerHTML = qfWhitelist.map(domain => `
    <span class="wp-site-pill">
      ${domain}
      <button class="wp-site-remove" data-domain="${domain}">×</button>
    </span>
  `).join('');
  container.querySelectorAll(".wp-site-remove").forEach(btn => {
    btn.addEventListener("click", () => {
      qfWhitelist = qfWhitelist.filter(d => d !== btn.getAttribute("data-domain"));
      renderQfWhitelistPills();
    });
  });
}

/** Renders the LOCKED read-only whitelist pills (Active screen) — no remove button at all. */
function renderQfActiveWhitelistPills(domains) {
  const card = document.getElementById("qfActiveWhitelistCard");
  const container = document.getElementById("qfActiveWhitelistDomains");
  if (!card || !container) return;
  if (!domains || domains.length === 0) {
    card.style.display = "none";
    return;
  }
  container.innerHTML = domains.map(domain => `
    <span class="wp-site-pill qf-locked-pill">${domain}</span>
  `).join('');
  card.style.display = "block";
}

function setQfWhitelistCardExpanded(expanded) {
  const card = document.getElementById("qfWhitelistCard");
  if (card) card.classList.toggle("expanded", expanded);
}

function openQuickFocusView() {
  dashboardView.style.display = "none";
  revealSubview(document.getElementById("quickFocusView"));

  // Initialize scope and duration defaults
  selectedScope = "BLOCKLIST";
  selectedDuration = 25;
  qfWhitelist = [];
  renderQfWhitelistPills();
  setQfWhitelistCardExpanded(false);
  const whitelistInput = document.getElementById("qfWhitelistInput");
  if (whitelistInput) whitelistInput.value = "";

  // Pre-seed the configured Exit redirect site into the ALL-scope whitelist by default —
  // same reasoning as handleAddWpWindow: with scope "Block Everything" and no whitelist,
  // tapping Exit on the block screen would bounce right back to it. The user can still
  // remove the pill before starting the session if they don't want the exception.
  storage.get("exit_behavior", (behavior) => {
    if (behavior !== "CUSTOM_URL") return;
    storage.get("exit_custom_url", (url) => {
      const domain = WorkProfileEngine.normalizeDomain(url || "");
      if (domain && !qfWhitelist.includes(domain)) {
        qfWhitelist.push(domain);
        renderQfWhitelistPills();
      }
    });
  });

  const scopeBlocklist = document.getElementById("qfScopeBlocklist");
  const scopeAll = document.getElementById("qfScopeAll");
  if (scopeBlocklist && scopeAll) {
    scopeBlocklist.classList.add("selected");
    scopeAll.classList.remove("selected");
  }

  const durationBtns = document.querySelectorAll(".qf-duration-btn");
  durationBtns.forEach(btn => {
    if (btn.dataset.mins === "25") {
      btn.classList.add("selected");
    } else {
      btn.classList.remove("selected");
    }
  });
  const customInput = document.getElementById("qfCustomMins");
  if (customInput) customInput.value = "";

  // Hide cancel confirm, show normal cancel
  const cancelConfirm = document.getElementById("qfCancelConfirmRow");
  const cancelNormal = document.getElementById("qfCancelNormalRow");
  if (cancelConfirm) cancelConfirm.style.display = "none";
  if (cancelNormal) cancelNormal.style.display = "block";

  // Hide start screen error
  const startError = document.getElementById("qfStartError");
  if (startError) startError.style.display = "none";

  updateQuickFocusUI();
}

function closeQuickFocusView() {
  if (quickFocusPollInterval) {
    clearInterval(quickFocusPollInterval);
    quickFocusPollInterval = null;
  }
  dismissSubview(document.getElementById("quickFocusView"), () => {
    if (lastDashboardMode === "synced") {
      showDashboard(lastUid);
    } else {
      showFreeDashboard();
    }
  });
}

function updateQuickFocusUI() {
  if (!isExtension) return;

  chrome.runtime.sendMessage({ action: "GET_QUICK_FOCUS_STATUS" }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("Error getting Quick Focus status:", chrome.runtime.lastError.message);
      return;
    }

    const startScreen = document.getElementById("qfStartScreen");
    const activeScreen = document.getElementById("qfActiveScreen");
    const completeScreen = document.getElementById("qfCompleteScreen");

    if (response && response.active) {
      // Running active session
      if (startScreen) startScreen.style.display = "none";
      if (completeScreen) completeScreen.style.display = "none";
      if (activeScreen) activeScreen.style.display = "block";

      // Timer formatting
      const remainingMs = response.remainingMs || 0;
      const totalSecs = Math.ceil(remainingMs / 1000);
      const mins = Math.floor(totalSecs / 60);
      const secs = totalSecs % 60;
      const timerDisplay = document.getElementById("qfTimerDisplay");
      if (timerDisplay) {
        timerDisplay.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
      }

      const scope = response.session ? response.session.scope : "BLOCKLIST";
      const activeScopeDisplay = document.getElementById("qfActiveScopeDisplay");
      if (activeScopeDisplay) {
        activeScopeDisplay.textContent = scope;
      }

      // Locked, read-only whitelist for the live session — untappable and unchangeable
      // for the rest of this session; the only way out is the Skip Pass cancel flow below
      // (QuickFocusSkipEngine), same as the rest of the hard-block.
      renderQfActiveWhitelistPills(scope === "ALL" ? (response.session && response.session.whitelist) : null);

      // Update Skip Pass
      updateSkipPassStatus();

      if (!quickFocusPollInterval) {
        quickFocusPollInterval = setInterval(updateQuickFocusUI, 1000);
      }
    } else {
      // No session is active
      if (quickFocusPollInterval) {
        clearInterval(quickFocusPollInterval);
        quickFocusPollInterval = null;
      }
      renderQfActiveWhitelistPills(null); // hide the locked card now that nothing is live

      if (activeScreen && activeScreen.style.display === "block") {
        // Transition from active screen to complete screen
        activeScreen.style.display = "none";
        if (startScreen) startScreen.style.display = "none";
        if (completeScreen) completeScreen.style.display = "block";

        setTimeout(() => {
          if (completeScreen) completeScreen.style.display = "none";
          if (startScreen) {
            startScreen.style.display = "block";
            const startError = document.getElementById("qfStartError");
            if (startError) startError.style.display = "none";
          }
        }, 3000);
      } else if (completeScreen && completeScreen.style.display !== "block") {
        // Normal start screen
        if (activeScreen) activeScreen.style.display = "none";
        if (completeScreen) completeScreen.style.display = "none";
        if (startScreen) startScreen.style.display = "block";
      }
    }
  });
}

function updateSkipPassStatus() {
  chrome.runtime.sendMessage({ action: "GET_SKIP_PASS_STATUS" }, (response) => {
    if (chrome.runtime.lastError) {
      console.error(chrome.runtime.lastError.message);
      return;
    }

    if (response) {
      const passesAvail = response.passesAvailable || 0;
      const freeRem = response.freeRemaining || 0;
      const notice = response.notice || "";

      const countDisplay = document.getElementById("qfPassCountDisplay");
      if (countDisplay) countDisplay.textContent = passesAvail;

      let descText = "";
      if (freeRem > 0) {
        descText = `${freeRem} of 3 free passes left this month.`;
      } else if (passesAvail > 0) {
        descText = `${passesAvail} purchased pass(es) available.`;
      } else {
        descText = "No passes left. Canceling will affect your score.";
      }
      const passStatusDesc = document.getElementById("qfPassStatusDesc");
      if (passStatusDesc) passStatusDesc.textContent = descText;

      const banner = document.getElementById("qfNoticeBanner");
      if (banner) {
        banner.textContent = notice;
        banner.style.display = notice ? "block" : "none";
      }

      const confirmNotice = document.getElementById("qfConfirmNoticeText");
      if (confirmNotice) confirmNotice.textContent = notice;
    }
  });
}

function setupQuickFocusListeners() {
  const backBtn = document.getElementById("quickFocusBackBtn");
  if (backBtn) backBtn.addEventListener("click", closeQuickFocusView);

  const scopeBlocklist = document.getElementById("qfScopeBlocklist");
  const scopeAll = document.getElementById("qfScopeAll");

  if (scopeBlocklist) {
    scopeBlocklist.addEventListener("click", () => {
      scopeBlocklist.classList.add("selected");
      if (scopeAll) scopeAll.classList.remove("selected");
      selectedScope = "BLOCKLIST";
      setQfWhitelistCardExpanded(false);
    });
  }

  if (scopeAll) {
    scopeAll.addEventListener("click", () => {
      scopeAll.classList.add("selected");
      if (scopeBlocklist) scopeBlocklist.classList.remove("selected");
      selectedScope = "ALL";
      setQfWhitelistCardExpanded(true);
    });
  }

  // Whitelist add — button click or Enter in the input, same pattern as Work Profile's
  // per-window site add.
  const whitelistInput = document.getElementById("qfWhitelistInput");
  const addWhitelistBtn = document.getElementById("qfAddWhitelistBtn");
  const performAddWhitelistDomain = () => {
    if (!whitelistInput) return;
    const val = whitelistInput.value.trim().toLowerCase();
    if (!val) return;
    const cleanDomain = WorkProfileEngine.normalizeDomain(val);
    if (cleanDomain && !qfWhitelist.includes(cleanDomain)) {
      qfWhitelist.push(cleanDomain);
      renderQfWhitelistPills();
    }
    whitelistInput.value = "";
  };
  if (addWhitelistBtn) addWhitelistBtn.addEventListener("click", performAddWhitelistDomain);
  if (whitelistInput) {
    whitelistInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") performAddWhitelistDomain();
    });
  }

  const durationBtns = document.querySelectorAll(".qf-duration-btn");
  const customInput = document.getElementById("qfCustomMins");

  durationBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      durationBtns.forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      selectedDuration = parseInt(btn.dataset.mins, 10);
      if (customInput) customInput.value = "";
    });
  });

  if (customInput) {
    customInput.addEventListener("input", () => {
      if (customInput.value) {
        durationBtns.forEach(b => b.classList.remove("selected"));
        selectedDuration = parseInt(customInput.value, 10);
      }
    });
  }

  // Start Button Click
  const startBtn = document.getElementById("qfStartBtn");
  if (startBtn) {
    startBtn.addEventListener("click", () => {
      if (!isExtension) return;

      // Read custom if filled
      if (customInput && customInput.value) {
        selectedDuration = parseInt(customInput.value, 10);
      }

      // Client side duration bounds checking
      if (isNaN(selectedDuration) || selectedDuration < 1 || selectedDuration > 180) {
        const errorPanel = document.getElementById("qfStartError");
        if (errorPanel) {
          errorPanel.textContent = "Duration must be between 1 and 180 minutes.";
          errorPanel.className = "qf-error-msg";
          errorPanel.style.display = "block";
        }
        return;
      }

      chrome.runtime.sendMessage({
        action: "START_QUICK_FOCUS",
        scope: selectedScope,
        durationMinutes: selectedDuration,
        whitelist: selectedScope === "ALL" ? qfWhitelist : []
      }, (response) => {
        if (response && response.success) {
          updateQuickFocusUI();
        } else {
          const errorPanel = document.getElementById("qfStartError");
          if (errorPanel) {
            errorPanel.textContent = response ? response.reason : "Failed to start focus session.";
            errorPanel.className = "qf-error-msg";
            errorPanel.style.display = "block";
          }
        }
      });
    });
  }

  // Cancel / Skip confirmation flow
  const triggerCancelBtn = document.getElementById("qfTriggerCancelBtn");
  const keepFocusBtn = document.getElementById("qfKeepFocusBtn");
  const confirmCancelBtn = document.getElementById("qfConfirmCancelBtn");

  if (triggerCancelBtn) {
    triggerCancelBtn.addEventListener("click", () => {
      const cancelNormal = document.getElementById("qfCancelNormalRow");
      const cancelConfirm = document.getElementById("qfCancelConfirmRow");
      if (cancelNormal) cancelNormal.style.display = "none";
      if (cancelConfirm) cancelConfirm.style.display = "block";
    });
  }

  if (keepFocusBtn) {
    keepFocusBtn.addEventListener("click", () => {
      const cancelConfirm = document.getElementById("qfCancelConfirmRow");
      const cancelNormal = document.getElementById("qfCancelNormalRow");
      if (cancelConfirm) cancelConfirm.style.display = "none";
      if (cancelNormal) cancelNormal.style.display = "block";
    });
  }

  if (confirmCancelBtn) {
    confirmCancelBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ action: "CANCEL_QUICK_FOCUS" }, (response) => {
        const cancelConfirm = document.getElementById("qfCancelConfirmRow");
        const cancelNormal = document.getElementById("qfCancelNormalRow");
        if (cancelConfirm) cancelConfirm.style.display = "none";
        if (cancelNormal) cancelNormal.style.display = "block";

        if (response && response.success) {
          updateQuickFocusUI();

          // Render success cancellation message banner on start screen
          const errorPanel = document.getElementById("qfStartError");
          if (errorPanel) {
            errorPanel.style.display = "block";
            if (response.method === "pass") {
              errorPanel.textContent = `Skip Pass used. 1 pass spent — ${response.passesRemaining} left this month.`;
              errorPanel.className = "qf-info-banner";
            } else {
              errorPanel.textContent = "Session ended. This will affect your score since you're out of free passes this month.";
              errorPanel.className = "qf-warning-banner";
            }
          }
        } else {
          const errorPanel = document.getElementById("qfStartError");
          if (errorPanel) {
            errorPanel.textContent = response ? response.reason : "Failed to cancel session.";
            errorPanel.className = "qf-error-msg";
            errorPanel.style.display = "block";
          }
        }
      });
    });
  }
}

// ── WORK PROFILE ENGINE (POPUP CONTROLLER) ──
let currentProfile = null;
let activeWpDay = 1; // 0=Sun ... 6=Sat

function openWorkProfileView() {
  dashboardView.style.display = "none";
  revealSubview(document.getElementById("workProfileView"));

  // Hide any old error msgs
  const errorMsg = document.getElementById("wpErrorMsg");
  if (errorMsg) errorMsg.style.display = "none";
  
  // Set default day to today
  activeWpDay = new Date().getDay();
  
  // Read current profile
  if (isExtension) {
    chrome.storage.local.get("work_profile", (data) => {
      if (data && data.work_profile) {
        currentProfile = JSON.parse(JSON.stringify(data.work_profile));
      } else {
        currentProfile = createDefaultProfile();
      }
      renderWorkProfileUI();
    });
  } else {
    // FALLBACK for testing
    const localData = localStorage.getItem("work_profile");
    if (localData) {
      currentProfile = JSON.parse(localData);
    } else {
      currentProfile = createDefaultProfile();
    }
    renderWorkProfileUI();
  }
}

function closeWorkProfileView() {
  dismissSubview(document.getElementById("workProfileView"), () => {
    if (lastDashboardMode === "synced") {
      showDashboard(lastUid);
    } else {
      showFreeDashboard();
    }
  });
}

// ── WELLBEING TOOLS (Eye Rest 20-20-20 + Water Break) ──

let wellbeingConfig = null; // last config loaded from background, kept in sync with the UI

function openWellbeingToolsView() {
  dashboardView.style.display = "none";
  revealSubview(document.getElementById("wellbeingToolsView"));
  loadWellbeingConfig();
}

function closeWellbeingToolsView() {
  stopWaterCountdown();
  dismissSubview(document.getElementById("wellbeingToolsView"), () => {
    if (lastDashboardMode === "synced") {
      showDashboard(lastUid);
    } else {
      showFreeDashboard();
    }
  });
}

function defaultWellbeingConfig() {
  return {
    eyeRest: { enabled: false, mode: "PAUSE_SCREEN", lastFiredAt: null, completedCount: 0 },
    waterBreak: { enabled: false, mode: "PAUSE_SCREEN", intervalMinutes: 30, lastFiredAt: null, completedCount: 0 },
  };
}

function loadWellbeingConfig() {
  if (isExtension) {
    chrome.runtime.sendMessage({ action: "GET_WELLBEING_CONFIG" }, (response) => {
      wellbeingConfig = (response && response.config) || defaultWellbeingConfig();
      renderWellbeingToolsUI();
    });
  } else {
    wellbeingConfig = defaultWellbeingConfig();
    renderWellbeingToolsUI();
  }
}

let waterCountdownInterval = null;

function setWaterInputsDisabled(disabled) {
  const presets = document.querySelectorAll('#wellbeingToolsView .qf-duration-presets .qf-duration-btn');
  presets.forEach((btn) => {
    btn.disabled = disabled;
    btn.style.opacity = disabled ? "0.5" : "1";
    btn.style.pointerEvents = disabled ? "none" : "auto";
  });
  const customInput = document.getElementById("wbWaterCustomMins");
  if (customInput) {
    customInput.disabled = disabled;
    customInput.style.opacity = disabled ? "0.5" : "1";
  }
  const modes = [document.getElementById("wbWaterModePause"), document.getElementById("wbWaterModeNotify")];
  modes.forEach((mode) => {
    if (mode) {
      mode.style.opacity = disabled ? "0.5" : "1";
      mode.style.pointerEvents = disabled ? "none" : "auto";
    }
  });
}

function startWaterCountdown(lastFiredAt, intervalMinutes) {
  if (waterCountdownInterval) clearInterval(waterCountdownInterval);
  const countdownEl = document.getElementById("wbWaterCountdown");
  const timerArea = document.getElementById("wbWaterTimerArea");
  if (!countdownEl || !timerArea) return;

  timerArea.style.display = "flex";

  function update() {
    const elapsed = Date.now() - lastFiredAt;
    const totalMs = intervalMinutes * 60 * 1000;
    const remainingMs = Math.max(0, totalMs - elapsed);

    if (remainingMs <= 0) {
      countdownEl.textContent = "00:00";
      clearInterval(waterCountdownInterval);
      setTimeout(loadWellbeingConfig, 1000);
      return;
    }

    const totalSecs = Math.floor(remainingMs / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;

    countdownEl.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  update();
  waterCountdownInterval = setInterval(update, 1000);
}

function stopWaterCountdown() {
  if (waterCountdownInterval) {
    clearInterval(waterCountdownInterval);
    waterCountdownInterval = null;
  }
  const timerArea = document.getElementById("wbWaterTimerArea");
  if (timerArea) timerArea.style.display = "none";
}

function renderWellbeingToolsUI() {
  const cfg = wellbeingConfig;

  document.getElementById("wbEyeEnableToggle").checked = !!cfg.eyeRest.enabled;

  selectScopeOption("wbWaterModePause", "wbWaterModeNotify", cfg.waterBreak.mode === "NOTIFICATION" ? "wbWaterModeNotify" : "wbWaterModePause");
  selectScopeOption("wbEyeModePause", "wbEyeModeNotify", cfg.eyeRest.mode === "NOTIFICATION" ? "wbEyeModeNotify" : "wbEyeModePause");

  const presetBtns = document.querySelectorAll('#wellbeingToolsView .qf-duration-btn');
  const customInput = document.getElementById("wbWaterCustomMins");
  let matched = false;
  presetBtns.forEach((btn) => {
    const isMatch = parseInt(btn.dataset.mins, 10) === cfg.waterBreak.intervalMinutes;
    btn.classList.toggle("selected", isMatch);
    if (isMatch) matched = true;
  });
  customInput.value = matched ? "" : cfg.waterBreak.intervalMinutes;

  // Handle Water Start/Stop Button state
  const waterStartBtn = document.getElementById("wbWaterStartBtn");
  if (waterStartBtn) {
    if (cfg.waterBreak.enabled) {
      waterStartBtn.textContent = "Stop Water Timer";
      waterStartBtn.className = "qf-action-btn danger-outline";
      setWaterInputsDisabled(true);
      if (cfg.waterBreak.lastFiredAt) {
        startWaterCountdown(cfg.waterBreak.lastFiredAt, cfg.waterBreak.intervalMinutes);
      } else {
        stopWaterCountdown();
      }
    } else {
      waterStartBtn.textContent = "Start Water Timer";
      waterStartBtn.className = "qf-action-btn primary";
      setWaterInputsDisabled(false);
      stopWaterCountdown();
    }
  }

  // Lock the Eye Rest card visually for non-Pro users — its own toggle/mode clicks are
  // intercepted below and redirected to the Pro wall instead of saving.
  document.getElementById("wbEyeCard").classList.toggle("wb-locked", !isProUser);
  const eyeBadge = document.querySelector('#wbEyeCard .nav-card-pro-badge');
  if (eyeBadge) eyeBadge.style.display = isProUser ? "none" : "inline-block";
}

function selectScopeOption(pauseId, notifyId, selectedId) {
  document.getElementById(pauseId).classList.toggle("selected", selectedId === pauseId);
  document.getElementById(notifyId).classList.toggle("selected", selectedId === notifyId);
}

function showWellbeingSaved(ok, reason) {
  const errorMsg = document.getElementById("wbErrorMsg");
  const savedMsg = document.getElementById("wbSavedMsg");
  if (ok) {
    errorMsg.style.display = "none";
    savedMsg.style.display = "block";
    setTimeout(() => { savedMsg.style.display = "none"; }, 1500);
  } else {
    savedMsg.style.display = "none";
    errorMsg.textContent = reason || "Couldn't save.";
    errorMsg.style.display = "block";
  }
}

// Sends the current in-memory state of one reminder (`target`: 'eyeRest' | 'waterBreak') to
// background.js, which re-validates entitlement server-side before persisting.
function saveWellbeingTarget(target) {
  const reminder = wellbeingConfig[target];
  const payload = {
    action: "SET_WELLBEING_CONFIG",
    target,
    enabled: reminder.enabled,
    mode: reminder.mode,
    intervalMinutes: reminder.intervalMinutes,
    lastFiredAt: reminder.lastFiredAt,
  };
  if (!isExtension) {
    showWellbeingSaved(true);
    renderWellbeingToolsUI();
    return;
  }
  chrome.runtime.sendMessage(payload, (response) => {
    if (response && response.success) {
      wellbeingConfig = response.config || wellbeingConfig;
      showWellbeingSaved(true);
    } else {
      // Roll the toggle back visually if the background rejected it (e.g. not entitled).
      loadWellbeingConfig();
      showWellbeingSaved(false, response && response.reason);
    }
  });
}

function setupWellbeingToolsListeners() {
  const backBtn = document.getElementById("wellbeingToolsBackBtn");
  if (backBtn) backBtn.addEventListener("click", closeWellbeingToolsView);

  // ── Water Break (Free) ──
  const waterStartBtn = document.getElementById("wbWaterStartBtn");
  if (waterStartBtn) {
    waterStartBtn.addEventListener("click", () => {
      const isRunning = wellbeingConfig.waterBreak.enabled;
      if (isRunning) {
        wellbeingConfig.waterBreak.enabled = false;
        wellbeingConfig.waterBreak.lastFiredAt = null;
        saveWellbeingTarget("waterBreak");
      } else {
        wellbeingConfig.waterBreak.enabled = true;
        wellbeingConfig.waterBreak.lastFiredAt = Date.now();
        saveWellbeingTarget("waterBreak");
      }
    });
  }
  document.getElementById("wbWaterModePause").addEventListener("click", () => {
    wellbeingConfig.waterBreak.mode = "PAUSE_SCREEN";
    selectScopeOption("wbWaterModePause", "wbWaterModeNotify", "wbWaterModePause");
    saveWellbeingTarget("waterBreak");
  });
  document.getElementById("wbWaterModeNotify").addEventListener("click", () => {
    wellbeingConfig.waterBreak.mode = "NOTIFICATION";
    selectScopeOption("wbWaterModePause", "wbWaterModeNotify", "wbWaterModeNotify");
    saveWellbeingTarget("waterBreak");
  });
  document.querySelectorAll('#wellbeingToolsView .qf-duration-btn').forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll('#wellbeingToolsView .qf-duration-btn').forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      document.getElementById("wbWaterCustomMins").value = "";
      wellbeingConfig.waterBreak.intervalMinutes = parseInt(btn.dataset.mins, 10);
      saveWellbeingTarget("waterBreak");
    });
  });
  const customMinsInput = document.getElementById("wbWaterCustomMins");
  let customMinsDebounce = null;
  customMinsInput.addEventListener("input", () => {
    document.querySelectorAll('#wellbeingToolsView .qf-duration-btn').forEach((b) => b.classList.remove("selected"));
    clearTimeout(customMinsDebounce);
    customMinsDebounce = setTimeout(() => {
      const mins = parseInt(customMinsInput.value, 10);
      if (!Number.isFinite(mins) || mins < 5 || mins > 180) return;
      wellbeingConfig.waterBreak.intervalMinutes = mins;
      saveWellbeingTarget("waterBreak");
    }, 500);
  });

  // ── Eye Rest / 20-20-20 (Extension Pro) ──
  const eyeToggle = document.getElementById("wbEyeEnableToggle");
  eyeToggle.addEventListener("change", (e) => {
    if (!isProUser) {
      e.preventDefault();
      eyeToggle.checked = false;
      showProWall("👁️ 20-20-20 Rule", "Every 20 minutes, get reminded to look 20 feet away for 20 seconds — protects your eyes during long focus sessions.", "extension");
      return;
    }
    wellbeingConfig.eyeRest.enabled = e.target.checked;
    saveWellbeingTarget("eyeRest");
  });
  ["wbEyeModePause", "wbEyeModeNotify"].forEach((id) => {
    document.getElementById(id).addEventListener("click", () => {
      if (!isProUser) {
        showProWall("👁️ 20-20-20 Rule", "Every 20 minutes, get reminded to look 20 feet away for 20 seconds — protects your eyes during long focus sessions.", "extension");
        return;
      }
      wellbeingConfig.eyeRest.mode = id === "wbEyeModeNotify" ? "NOTIFICATION" : "PAUSE_SCREEN";
      selectScopeOption("wbEyeModePause", "wbEyeModeNotify", id);
      saveWellbeingTarget("eyeRest");
    });
  });
}

function createDefaultProfile() {
  return {
    enabled: false,
    week: {
      "0": { windows: [] },
      "1": { windows: [] },
      "2": { windows: [] },
      "3": { windows: [] },
      "4": { windows: [] },
      "5": { windows: [] },
      "6": { windows: [] }
    },
    overrides: {}
  };
}

function renderWorkProfileUI() {
  if (!currentProfile) return;
  
  const now = new Date();
  
  // 1. Master Toggle
  const masterToggle = document.getElementById("wpMasterEnableToggle");
  if (masterToggle) {
    masterToggle.checked = currentProfile.enabled;
    
    // Anti-cheat lockdown check: if currently inside a live FOCUS window, disable Master Toggle!
    const isCurrentlyLocked = currentProfile.enabled && WorkProfileEngine.isLocked(currentProfile, now);
    masterToggle.disabled = isCurrentlyLocked;
  }
  
  // 2. Day Selector Pills
  const dayTabs = document.querySelectorAll(".wp-day-tab");
  dayTabs.forEach(tab => {
    const dayVal = parseInt(tab.getAttribute("data-day"), 10);
    if (dayVal === activeWpDay) {
      tab.classList.add("selected");
    } else {
      tab.classList.remove("selected");
    }
  });
  
  // 3. Active Day Title
  const daysOfWeekNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayTitle = document.getElementById("wpActiveDayTitle");
  if (dayTitle) {
    dayTitle.textContent = `${daysOfWeekNames[activeWpDay]} Schedule`;
  }
  
  // 4. Windows list
  const windowsList = document.getElementById("wpWindowsList");
  const emptyView = document.getElementById("wpWindowsEmpty");
  if (windowsList) windowsList.innerHTML = "";
  
  const daySchedule = currentProfile.week[String(activeWpDay)] || { windows: [] };
  const windows = daySchedule.windows || [];
  
  if (windows.length === 0) {
    if (emptyView) emptyView.style.display = "flex";
  } else {
    if (emptyView) emptyView.style.display = "none";
    
    windows.forEach((w) => {
      // Calculate lock status for this window
      const isLiveFocus = currentProfile.enabled && 
                          (activeWpDay === now.getDay()) && 
                          w.mode === "FOCUS" && 
                          (function() {
                            const currentMin = now.getHours() * 60 + now.getMinutes();
                            const s = WorkProfileEngine.parseHM(w.start);
                            const e = WorkProfileEngine.parseHM(w.end);
                            return currentMin >= s && currentMin < e;
                          })();
      
      const item = document.createElement("div");
      item.className = `wp-window-item${isLiveFocus ? " locked-live" : ""}`;
      
      // Lock badge if locked — rendered as an in-flow row (not absolutely positioned) so
      // it never overlaps the time/mode fields below it.
      let lockBadgeHtml = "";
      if (isLiveFocus) {
        lockBadgeHtml = `<div class="wp-window-lock-badge-row"><span class="wp-window-lock-badge">🔒 Locked Live</span></div>`;
      }
      
      // Generate site pills
      const sitePillsHtml = (w.sites || []).map(site => `
        <span class="wp-site-pill">
          ${site}
          <button class="wp-site-remove" data-site="${site}" ${isLiveFocus ? "disabled" : ""}>×</button>
        </span>
      `).join('');
      
      // Mode options
      const modeSelectHtml = `
        <select class="wp-mode-select" ${isLiveFocus ? "disabled" : ""}>
          <option value="FOCUS" ${w.mode === 'FOCUS' ? 'selected' : ''}>FOCUS (Deep Work Allowlist)</option>
          <option value="LIGHT" ${w.mode === 'LIGHT' ? 'selected' : ''}>LIGHT (Distractions Blocklist)</option>
        </select>
      `;
      
      item.innerHTML = `
        ${lockBadgeHtml}
        <div class="wp-time-row">
          <div class="wp-time-input-container">
            <span class="wp-time-label">Start</span>
            <input type="time" class="wp-time-input wp-start-time" value="${w.start}" ${isLiveFocus ? "disabled" : ""}>
          </div>
          <div class="wp-time-input-container">
            <span class="wp-time-label">End</span>
            <input type="time" class="wp-time-input wp-end-time" value="${w.end === "24:00" ? "23:59" : w.end}" ${isLiveFocus ? "disabled" : ""}>
          </div>
        </div>
        <div class="wp-mode-row">
          <span class="wp-mode-label">Mode</span>
          ${modeSelectHtml}
        </div>
        <div class="wp-sites-section">
          <span class="wp-sites-label">${w.mode === 'FOCUS' ? 'Allowed Websites' : 'Blocked Websites'}</span>
          <div class="wp-sites-container">
            ${sitePillsHtml}
          </div>
          <div class="wp-add-site-row">
            <input type="text" class="wp-new-site-input" placeholder="e.g. github.com" ${isLiveFocus ? "disabled" : ""}>
            <button class="wp-add-site-btn" ${isLiveFocus ? "disabled" : ""}>+</button>
          </div>
        </div>
        <button class="wp-delete-window-btn" ${isLiveFocus ? "disabled" : ""}>Remove Window</button>
      `;
      
      // Bind inline change handlers
      
      // Time changes
      const startInput = item.querySelector(".wp-start-time");
      const endInput = item.querySelector(".wp-end-time");
      
      startInput.addEventListener("change", (e) => {
        w.start = e.target.value;
      });
      endInput.addEventListener("change", (e) => {
        w.end = e.target.value === "23:59" ? "24:00" : e.target.value;
      });
      
      // Mode change
      const modeSelect = item.querySelector(".wp-mode-select");
      modeSelect.addEventListener("change", (e) => {
        w.mode = e.target.value;
        renderWorkProfileUI(); // Re-render to update sites label ("Allowed" vs "Blocked")
      });
      
      // Site Remove
      const removeBtns = item.querySelectorAll(".wp-site-remove");
      removeBtns.forEach(btn => {
        btn.addEventListener("click", () => {
          const siteToRemove = btn.getAttribute("data-site");
          w.sites = (w.sites || []).filter(s => s !== siteToRemove);
          renderWorkProfileUI();
        });
      });
      
      // Site Add
      const addSiteInput = item.querySelector(".wp-new-site-input");
      const addSiteBtn = item.querySelector(".wp-add-site-btn");
      
      const performAddSite = () => {
        const val = addSiteInput.value.trim().toLowerCase();
        if (val) {
          const cleanDomain = WorkProfileEngine.normalizeDomain(val);
          if (cleanDomain) {
            if (!w.sites) w.sites = [];
            if (!w.sites.includes(cleanDomain)) {
              w.sites.push(cleanDomain);
            }
          }
          renderWorkProfileUI();
        }
      };
      
      addSiteBtn.addEventListener("click", performAddSite);
      addSiteInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter") performAddSite();
      });
      
      // Window Delete
      const deleteBtn = item.querySelector(".wp-delete-window-btn");
      deleteBtn.addEventListener("click", () => {
        daySchedule.windows = daySchedule.windows.filter(win => win.id !== w.id);
        renderWorkProfileUI();
      });
      
      windowsList.appendChild(item);
    });
  }
}

function handleAddWpWindow() {
  const daySchedule = currentProfile.week[String(activeWpDay)] || { windows: [] };
  if (!currentProfile.week[String(activeWpDay)]) {
    currentProfile.week[String(activeWpDay)] = daySchedule;
  }

  // Create a new window with a unique ID and reasonable default times
  const newId = "win_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5);
  const defaultSites = ["github.com", "stackoverflow.com"];

  const finishAdd = (sites) => {
    daySchedule.windows.push({
      id: newId,
      start: "09:00",
      end: "17:00",
      mode: "FOCUS",
      sites
    });
    renderWorkProfileUI();
  };

  // Pre-seed the configured Exit redirect site into the new FOCUS window's allowlist by
  // default — otherwise tapping Exit on the block screen during this window bounces the
  // user right back to it (the redirect site isn't whitelisted). The user can still remove
  // the pill here if they don't want the exception; removing it makes Exit fall back to a
  // fresh tab instead while this window is live (see applyExitBehavior in background.js).
  storage.get("exit_behavior", (behavior) => {
    if (behavior !== "CUSTOM_URL") { finishAdd(defaultSites); return; }
    storage.get("exit_custom_url", (url) => {
      const domain = WorkProfileEngine.normalizeDomain(url || "");
      const sites = domain && !defaultSites.includes(domain) ? [domain, ...defaultSites] : defaultSites;
      finishAdd(sites);
    });
  });
}

function handleSaveWorkProfile() {
  if (!currentProfile) return;
  
  currentProfile.enabled = document.getElementById("wpMasterEnableToggle").checked;
  
  // Inject the updatedAt timestamp
  currentProfile.updatedAt = Date.now();
  
  if (isExtension) {
    chrome.runtime.sendMessage({
      action: "SET_WORK_PROFILE",
      profile: currentProfile
    }, (response) => {
      const errorMsg = document.getElementById("wpErrorMsg");
      if (response && response.success) {
        if (errorMsg) {
          errorMsg.style.display = "none";
        }
        // Success visual feedback (info banner styling)
        const errorPanel = document.getElementById("wpErrorMsg");
        if (errorPanel) {
          errorPanel.textContent = "Work Profile successfully saved and synced!";
          errorPanel.className = "qf-info-banner";
          errorPanel.style.display = "block";
          
          setTimeout(() => {
            errorPanel.style.display = "none";
          }, 3000);
        }
        renderWorkProfileUI();
      } else {
        // Show anti-cheat rejection message inline
        if (errorMsg) {
          errorMsg.textContent = response ? response.reason : "Failed to save Work Profile.";
          errorMsg.className = "qf-error-msg";
          errorMsg.style.display = "block";
        }
      }
    });
  } else {
    // Non-extension mock save
    localStorage.setItem("work_profile", JSON.stringify(currentProfile));
    const errorMsg = document.getElementById("wpErrorMsg");
    if (errorMsg) {
      errorMsg.textContent = "Mock Work Profile saved locally.";
      errorMsg.className = "qf-info-banner";
      errorMsg.style.display = "block";
      setTimeout(() => { errorMsg.style.display = "none"; }, 3000);
    }
  }
}

function setupWorkProfileListeners() {
  const backBtn = document.getElementById("workProfileBackBtn");
  if (backBtn) backBtn.addEventListener("click", closeWorkProfileView);
  
  const dayTabs = document.querySelectorAll(".wp-day-tab");
  dayTabs.forEach(tab => {
    tab.addEventListener("click", () => {
      activeWpDay = parseInt(tab.getAttribute("data-day"), 10);
      renderWorkProfileUI();
    });
  });
  
  const addBtn = document.getElementById("wpAddWindowBtn");
  if (addBtn) addBtn.addEventListener("click", handleAddWpWindow);
  
  const saveBtn = document.getElementById("wpSaveBtn");
  if (saveBtn) saveBtn.addEventListener("click", handleSaveWorkProfile);
}

// ── SETTINGS (block-screen Exit behavior) ──
const EXIT_BEHAVIOR_RADIO_IDS = {
  CLOSE_AND_NEW_TAB: "exitOptCloseNewTab",
  CUSTOM_URL: "exitOptCustomUrl",
  BACK_HISTORY: "exitOptBackHistory"
};

const EXIT_BEHAVIOR_SUMMARY_LABELS = {
  CLOSE_AND_NEW_TAB: "Close this tab & open a new tab",
  CUSTOM_URL: "Go to a website I choose",
  BACK_HISTORY: "Go back to where I was before"
};

function updateExitSummaryLabel(behavior) {
  const label = document.getElementById("profileExitCurrentLabel");
  if (label) label.textContent = EXIT_BEHAVIOR_SUMMARY_LABELS[behavior] || EXIT_BEHAVIOR_SUMMARY_LABELS.CLOSE_AND_NEW_TAB;
}

function loadExitBehaviorSettings() {
  storage.get("exit_behavior", (behavior) => {
    const resolved = behavior || "CLOSE_AND_NEW_TAB";
    const radioId = EXIT_BEHAVIOR_RADIO_IDS[resolved] || EXIT_BEHAVIOR_RADIO_IDS.CLOSE_AND_NEW_TAB;
    const radio = document.getElementById(radioId);
    if (radio) radio.checked = true;
    updateExitCustomUrlVisibility(resolved);
    updateExitSummaryLabel(resolved);
  });
  storage.get("exit_custom_url", (url) => {
    const input = document.getElementById("exitCustomUrlInput");
    if (input && url) input.value = url;
  });
}

function updateExitCustomUrlVisibility(behavior) {
  const input = document.getElementById("exitCustomUrlInput");
  if (input) input.style.display = behavior === "CUSTOM_URL" ? "block" : "none";
}

function saveExitBehaviorSetting(behavior, customUrl) {
  const savedMsg = document.getElementById("settingsSavedMsg");
  const finish = (ok) => {
    if (!savedMsg) return;
    savedMsg.textContent = ok ? "Saved" : "Couldn't save";
    savedMsg.style.color = ok ? "" : "var(--compulsion-red)";
    savedMsg.style.display = "inline";
    setTimeout(() => { savedMsg.style.display = "none"; }, 1500);
  };

  if (isExtension) {
    chrome.runtime.sendMessage({ action: "SET_EXIT_BEHAVIOR", exitBehavior: behavior, customUrl }, (response) => {
      finish(!!(response && response.success));
    });
  } else {
    storage.set("exit_behavior", behavior);
    storage.set("exit_custom_url", customUrl || "");
    finish(true);
  }
}

function setupSettingsListeners() {
  loadExitBehaviorSettings();

  const radios = document.querySelectorAll('input[name="exitBehavior"]');
  const customUrlInput = document.getElementById("exitCustomUrlInput");

  radios.forEach((radio) => {
    radio.addEventListener("change", () => {
      updateExitCustomUrlVisibility(radio.value);
      updateExitSummaryLabel(radio.value);
      saveExitBehaviorSetting(radio.value, customUrlInput ? customUrlInput.value : "");
    });
  });

  if (customUrlInput) {
    let saveDebounce = null;
    customUrlInput.addEventListener("input", () => {
      clearTimeout(saveDebounce);
      saveDebounce = setTimeout(() => {
        saveExitBehaviorSetting("CUSTOM_URL", customUrlInput.value);
      }, 600);
    });
  }
}

// ── PROFILE (account, sync, exit behavior, legal links) ──

function updateProfileSyncUI(status) {
  const dot = document.getElementById("profileSyncDot");
  const text = document.getElementById("profileSyncText");
  if (!dot || !text) return;
  if (lastDashboardMode !== "synced") {
    dot.className = "status-dot";
    text.textContent = "Free Tier";
    return;
  }
  if (status === "syncing") {
    dot.className = "status-dot syncing";
    text.textContent = "Syncing…";
  } else if (status === "failed") {
    dot.className = "status-dot";
    text.textContent = "Sync failed";
  } else {
    dot.className = "status-dot";
    text.textContent = "Synced";
  }
}

function openProfileView() {
  dashboardView.style.display = "none";
  revealSubview(document.getElementById("profileView"));

  const signInBtn = document.getElementById("profileSignInBtn");
  const signOutBtn2 = document.getElementById("profileSignOutBtn");
  const syncNowBtn = document.getElementById("profileSyncNowBtn");
  const emailEl = document.getElementById("profileAccountEmail");
  const statusEl = document.getElementById("profileAccountStatus");

  if (lastDashboardMode === "synced") {
    storage.get("authEmail", (email) => {
      if (emailEl) emailEl.textContent = email || "Signed in";
    });
    if (statusEl) statusEl.textContent = "Signed in — synced across devices";
    if (signInBtn) signInBtn.style.display = "none";
    if (signOutBtn2) signOutBtn2.style.display = "block";
    if (syncNowBtn) syncNowBtn.style.display = "inline-block";
    updateProfileSyncUI();
  } else {
    if (emailEl) emailEl.textContent = "Not signed in";
    if (statusEl) statusEl.textContent = "Free Tier — local only, no account";
    if (signInBtn) signInBtn.style.display = "block";
    if (signOutBtn2) signOutBtn2.style.display = "none";
    if (syncNowBtn) syncNowBtn.style.display = "none";
    updateProfileSyncUI();
  }

  updateVerifyEmailRow();
}

// Show the "Verify your email" row only for a signed-in, password-provider account that
// isn't verified yet (Google sign-in is always verified and never shows this).
function updateVerifyEmailRow() {
  const card = document.getElementById("profileVerifyCard");
  if (!card) return;
  if (lastDashboardMode !== "synced") {
    card.style.display = "none";
    return;
  }
  storage.get("authProvider", (authProvider) => {
    storage.get("emailVerified", (emailVerified) => {
      card.style.display = (authProvider === "password" && !emailVerified) ? "flex" : "none";
    });
  });
}

function closeProfileView() {
  dismissSubview(document.getElementById("profileView"), () => {
    if (lastDashboardMode === "synced") {
      showDashboard(lastUid);
    } else {
      showFreeDashboard();
    }
  });
}

function setupProfileListeners() {
  setupOtpListeners();

  const backBtn = document.getElementById("profileBackBtn");
  if (backBtn) backBtn.addEventListener("click", closeProfileView);

  const summaryRow = document.getElementById("profileExitSummaryRow");
  const exitCard = summaryRow ? summaryRow.closest(".profile-exit-card") : null;
  if (summaryRow && exitCard) {
    summaryRow.addEventListener("click", () => {
      exitCard.classList.toggle("expanded");
    });
  }

  // Rate Extension Card
  const profileRateCard = document.getElementById("profileRateCard");
  if (profileRateCard) {
    profileRateCard.addEventListener("click", () => {
      const isFirefox = typeof InstallTrigger !== 'undefined' || navigator.userAgent.includes('Firefox');
      let rateUrl = `https://chromewebstore.google.com/detail/focus-wellbeing-companion/${chrome.runtime.id}`;
      if (isFirefox) {
        rateUrl = "https://addons.mozilla.org/en-US/firefox/addon/focus-wellbeing-companion/";
      }
      window.open(rateUrl, "_blank");
    });
  }

  // Suggest a Feature Card
  const featureSummaryRow = document.getElementById("profileFeatureSummaryRow");
  const featureCard = document.getElementById("profileFeatureCard");
  if (featureSummaryRow && featureCard) {
    featureSummaryRow.addEventListener("click", () => {
      featureCard.classList.toggle("expanded");
    });
  }

  const featureSubmitBtn = document.getElementById("featureSubmitBtn");
  const featureTextInput = document.getElementById("featureTextInput");
  const featureStatusMsg = document.getElementById("featureStatusMsg");
  if (featureSubmitBtn && featureTextInput && featureStatusMsg) {
    featureSubmitBtn.addEventListener("click", async () => {
      const text = featureTextInput.value.trim();
      if (!text) return;

      featureSubmitBtn.disabled = true;
      featureStatusMsg.style.color = "var(--color-silver-80)";
      featureStatusMsg.textContent = "Submitting...";

      try {
        const userState = await new Promise((resolve) => {
          chrome.storage.local.get(["user_email"], resolve);
        });
        const email = userState.user_email || "Anonymous";
        const isFirefox = typeof InstallTrigger !== 'undefined' || navigator.userAgent.includes('Firefox');

        const response = await fetch(`${SUPABASE_CONFIG.url}/rest/v1/feature_requests`, {
          method: "POST",
          headers: {
            "apikey": SUPABASE_CONFIG.anonKey,
            "Authorization": `Bearer ${SUPABASE_CONFIG.anonKey}`,
            "Content-Type": "application/json",
            "Prefer": "return=minimal"
          },
          body: JSON.stringify({
            content: text,
            email: email,
            browser: isFirefox ? "Firefox" : "Chrome"
          })
        });

        if (!response.ok) {
          throw new Error("Supabase insert failed");
        }

        featureTextInput.value = "";
        featureStatusMsg.style.color = "var(--color-emerald-50)";
        featureStatusMsg.textContent = "Thank you for your suggestion!";
        setTimeout(() => {
          featureCard.classList.remove("expanded");
          featureStatusMsg.textContent = "";
        }, 2000);
      } catch (err) {
        console.error("Feature submit error:", err);
        featureStatusMsg.style.color = "var(--color-red-50)";
        featureStatusMsg.textContent = "Failed to submit. Try again.";
      } finally {
        featureSubmitBtn.disabled = false;
      }
    });
  }

  const syncNowBtn = document.getElementById("profileSyncNowBtn");
  if (syncNowBtn) {
    syncNowBtn.addEventListener("click", () => {
      if (!isExtension) return;
      updateProfileSyncUI("syncing");
      chrome.runtime.sendMessage({ action: "SYNC_PULL" });
    });
  }

  const signInBtn = document.getElementById("profileSignInBtn");
  if (signInBtn) {
    signInBtn.addEventListener("click", () => {
      document.getElementById("profileView").style.display = "none";
      showAuth();
    });
  }

  const signOutBtn2 = document.getElementById("profileSignOutBtn");
  if (signOutBtn2) {
    signOutBtn2.addEventListener("click", () => {
      document.getElementById("profileView").style.display = "none";
      handleSignOut();
    });
  }
}

// ── EMAIL OTP (code-based verification) ──
function showOtpOverlay() {
  const input = document.getElementById("otpCodeInput");
  const errorMsg = document.getElementById("otpErrorMsg");
  if (input) input.value = "";
  if (errorMsg) errorMsg.style.display = "none";
  document.getElementById("otpOverlay").style.display = "flex";
  if (input) input.focus();
}

function hideOtpOverlay() {
  document.getElementById("otpOverlay").style.display = "none";
}

// Disables the code input/submit button and shows the spinner while a code is in flight —
// used both for the initial post-signup send and for "Resend code", so the overlay never
// sits there looking interactive while nothing can actually be submitted yet.
function setOtpOverlaySending(sending) {
  const input = document.getElementById("otpCodeInput");
  const submitBtn = document.getElementById("otpSubmitBtn");
  const submitBtnText = document.getElementById("otpSubmitBtnText");
  const submitBtnSpinner = document.getElementById("otpSubmitBtnSpinner");
  const resendLink = document.getElementById("otpResendLink");
  if (input) input.disabled = sending;
  if (submitBtn) submitBtn.disabled = sending;
  if (submitBtnText) {
    submitBtnText.textContent = "Verify";
    submitBtnText.style.display = sending ? "none" : "inline";
  }
  if (submitBtnSpinner) submitBtnSpinner.style.display = sending ? "inline-block" : "none";
  if (resendLink) resendLink.style.pointerEvents = sending ? "none" : "auto";
}

// Fired right after a successful SIGN_UP — opens the code-entry overlay immediately (in a
// loading state) rather than showing the bare dashboard for the network round-trip it takes
// to actually send the code. Asking for the code is not left as a separate action the user
// has to go find in Profile → Verify your email.
function triggerPostSignupOtp() {
  if (!isExtension) return;
  showOtpOverlay();
  setOtpOverlaySending(true);
  chrome.runtime.sendMessage({ action: "REQUEST_OTP_CODE" }, (response) => {
    setOtpOverlaySending(false);
    const input = document.getElementById("otpCodeInput");
    if (input) input.focus();
    if (!(response && response.success)) {
      const errorMsg = document.getElementById("otpErrorMsg");
      if (errorMsg) {
        errorMsg.textContent = response ? response.reason : "Could not send verification code.";
        errorMsg.style.display = "block";
      }
    }
  });
}

function setupOtpListeners() {
  const verifyBtn = document.getElementById("profileVerifyBtn");
  const verifyErrorMsg = document.getElementById("profileVerifyErrorMsg");

  const sendCode = (onDone) => {
    if (!isExtension) return;
    if (verifyBtn) { verifyBtn.disabled = true; verifyBtn.textContent = "Sending…"; }
    if (verifyErrorMsg) verifyErrorMsg.style.display = "none";
    chrome.runtime.sendMessage({ action: "REQUEST_OTP_CODE" }, (response) => {
      if (verifyBtn) { verifyBtn.disabled = false; verifyBtn.textContent = "Send code"; }
      if (response && response.success) {
        onDone();
      } else if (verifyErrorMsg) {
        verifyErrorMsg.textContent = response ? response.reason : "Could not send verification code.";
        verifyErrorMsg.style.display = "block";
      }
    });
  };

  if (verifyBtn) {
    verifyBtn.addEventListener("click", () => sendCode(showOtpOverlay));
  }

  const resendLink = document.getElementById("otpResendLink");
  if (resendLink) {
    resendLink.addEventListener("click", (e) => {
      e.preventDefault();
      if (!isExtension) return;
      const errorMsg = document.getElementById("otpErrorMsg");
      if (errorMsg) errorMsg.style.display = "none";
      setOtpOverlaySending(true);
      chrome.runtime.sendMessage({ action: "REQUEST_OTP_CODE" }, (response) => {
        setOtpOverlaySending(false);
        const input = document.getElementById("otpCodeInput");
        if (input) input.focus();
        if (!(response && response.success) && errorMsg) {
          errorMsg.textContent = response ? response.reason : "Could not send verification code.";
          errorMsg.style.display = "block";
        }
      });
    });
  }

  const cancelBtn = document.getElementById("otpCancelBtn");
  if (cancelBtn) cancelBtn.addEventListener("click", hideOtpOverlay);

  const codeInput = document.getElementById("otpCodeInput");
  if (codeInput) {
    codeInput.addEventListener("input", () => {
      codeInput.value = codeInput.value.replace(/\D/g, "").slice(0, 6);
    });
  }

  const submitBtn = document.getElementById("otpSubmitBtn");
  const submitBtnText = document.getElementById("otpSubmitBtnText");
  const submitBtnSpinner = document.getElementById("otpSubmitBtnSpinner");
  if (submitBtn) {
    submitBtn.addEventListener("click", () => {
      const code = codeInput ? codeInput.value.trim() : "";
      const errorMsg = document.getElementById("otpErrorMsg");
      if (code.length !== 6) {
        if (errorMsg) {
          errorMsg.textContent = "Enter the 6-digit code from your email.";
          errorMsg.style.display = "block";
        }
        return;
      }

      submitBtn.disabled = true;
      if (submitBtnText) submitBtnText.style.display = "none";
      if (submitBtnSpinner) submitBtnSpinner.style.display = "inline-block";
      if (errorMsg) errorMsg.style.display = "none";

      chrome.runtime.sendMessage({ action: "VERIFY_OTP_CODE", code }, (response) => {
        submitBtn.disabled = false;
        if (submitBtnText) submitBtnText.style.display = "inline";
        if (submitBtnSpinner) submitBtnSpinner.style.display = "none";

        if (response && response.success) {
          hideOtpOverlay();
          updateVerifyEmailRow();
        } else if (errorMsg) {
          errorMsg.textContent = response ? response.reason : "Could not verify code.";
          errorMsg.style.display = "block";
        }
      });
    });
  }
}

// ── LIVE BACKGROUND BROADCASTS ──
// Reflects the REAL sync/score/entitlement state instead of the popup's own guesses.
// Only meaningful in synced mode — Free Tier never syncs, so SYNC_STATUS is ignored there.
if (isExtension) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.wellbeing_tools) {
      wellbeingConfig = changes.wellbeing_tools.newValue || defaultWellbeingConfig();
      renderWellbeingToolsUI();
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "SYNC_STATUS" && lastDashboardMode === "synced") {
      if (message.status === "syncing") {
        syncStatusDot.className = "status-dot syncing";
        syncStatusText.textContent = "Syncing…";
      } else if (message.status === "synced") {
        syncStatusDot.className = "status-dot";
        syncStatusText.textContent = "Synced";
      } else if (message.status === "failed") {
        syncStatusDot.className = "status-dot";
        syncStatusText.textContent = "Sync failed";
      }
      updateProfileSyncUI(message.status);
    } else if (message.action === "SCORES_UPDATED") {
      loadLiveScoresAndProtocols();
    } else if (message.action === "ENTITLEMENT_UPDATED") {
      applyTierLayout();
    }
  });
}

// Run init
init();
