importScripts('config.js', 'LifeScoreCalculator.js', 'InterventionSignalAggregator.js', 'EngagementSignalCalculator.js', 'WorkProfileEngine.js', 'QuickFocusEngine.js', 'QuickFocusSkipEngine.js', 'ExitBehaviorEngine.js', 'WebEntitlementEngine.js', 'HeartbeatEngine.js', 'WellbeingRemindersEngine.js');


// Helper to escape regex special characters
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Extract a display-friendly app name from a domain
function getAppName(domain) {
  const name = domain.split('.')[0];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// ── BLOCKER RULES MANAGER ──
// Rebuilds the declarativeNetRequest rule set from (a) the base blocklist, (b) the Work
// Profile's decision for RIGHT NOW (WorkProfileEngine.effectiveBlock), and (c) a live
// Quick Focus session (QuickFocusEngine.effectiveBlock). The two engines are merged via
// QuickFocusEngine.mergeWithBlockDecision (most-restrictive-wins):
//   ALL           → Quick Focus hard-blocks EVERY site except the session's pre-committed
//                   `whitelist` (chosen before Start, fixed for the session's lifetime).
//   FOCUS         → Work Profile catch-all redirect + higher-priority ALLOW rules for
//                   the active window's allowlist (the deep-work lockdown).
//   HARD_BLOCKLIST→ Quick Focus hard-blocks the (Work-Profile-resolved) blocklist,
//                   ignoring temporary bypass whitelists.
//   LIGHT/NONE    → redirect the resolved blocklist, honoring temporary bypasses.
// ALL/FOCUS/HARD_BLOCKLIST all ignore TEMPORARY bypass whitelists (`whitelisted_domains`,
// the per-domain snooze) — you can't whitelist your way out of a hard lock mid-session.
// ALL's own `whitelist` is different: it's baked into the session at start time, not a
// live escape hatch. Must stay a single updateDynamicRules() call so the rule set swaps
// atomically.
let updateRulesPromise = Promise.resolve();

// Computes the same effective block decision updateBlockerRules() turns into DNR rules,
// but as data — shared with applyExitBehavior() so the exit redirect can check "would
// navigating here just get blocked again" without duplicating the merge logic.
async function computeCurrentBlockDecision() {
  const result = await chrome.storage.local.get(['blocked_domains', 'whitelisted_domains', 'work_profile', 'quick_focus_session']);
  const baseDomains = result.blocked_domains || ["youtube.com", "instagram.com", "twitter.com"];
  const whitelisted = result.whitelisted_domains || {};
  const now = Date.now();
  const nowDate = new Date();

  // effectiveBlock returns already-normalized domains (lowercase, no scheme/www).
  const wpEff = WorkProfileEngine.effectiveBlock(result.work_profile, baseDomains, nowDate);
  const qfEff = QuickFocusEngine.effectiveBlock(result.quick_focus_session, nowDate);
  const eff = QuickFocusEngine.mergeWithBlockDecision(qfEff, wpEff);
  return { eff, whitelisted, now };
}

// Would `urlOrDomain` be blocked RIGHT NOW under the current decision? Used to keep the
// block screen's "Exit" button from bouncing the user to a CUSTOM_URL that isn't part of
// the currently active allowlist/blocklist — see applyExitBehavior().
function isDomainBlockedByDecision(urlOrDomain, decision) {
  const domain = WorkProfileEngine.normalizeDomain(urlOrDomain);
  if (!domain) return false;
  const { eff, whitelisted, now } = decision;
  const matches = (d) => domain === d || domain.endsWith(`.${d}`);

  if (eff.mode === QuickFocusEngine.MODE_ALL || eff.mode === 'FOCUS') {
    return !eff.allow.some(matches); // allowlist modes: blocked unless explicitly allowed
  }
  const blocked = eff.block.some(matches);
  if (!blocked) return false;
  if (eff.ignoreBypass) return true;
  const expiry = whitelisted[domain];
  return !(expiry && expiry > now); // an active temporary bypass makes it reachable
}

async function updateBlockerRules() {
  updateRulesPromise = updateRulesPromise.then(async () => {
    try {
      const { eff, whitelisted, now } = await computeCurrentBlockDecision();

      const redirectRule = (id, regexFilter, appLabel) => ({
        id,
        priority: 1,
        action: {
          type: "redirect",
          redirect: {
            regexSubstitution: chrome.runtime.getURL("blocked.html") + `?app=${encodeURIComponent(appLabel)}&url=\\0`
          }
        },
        condition: { regexFilter, resourceTypes: ["main_frame"] }
      });
      // "allow" at a HIGHER priority than the catch-all so allowlisted sites pass through.
      const allowRule = (id, domain) => ({
        id,
        priority: 2,
        action: { type: "allow" },
        condition: {
          regexFilter: `^https?://(?:[a-z0-9-]+\\.)*${escapeRegExp(domain)}(/.*)?`,
          resourceTypes: ["main_frame"]
        }
      });

      const newRules = [];
      if (eff.mode === QuickFocusEngine.MODE_ALL) {
        newRules.push(redirectRule(1, `^https?://`, "Focus"));
        // Higher-priority allow rules for the whitelist chosen BEFORE this session started
        // (QuickFocusEngine session.whitelist) — the one pre-committed exception; there is
        // no message handler that can grow this list once the session is live.
        eff.allow.forEach((domain, i) => { if (domain) newRules.push(allowRule(i + 2, domain)); });
      } else if (eff.mode === 'FOCUS') {
        newRules.push(redirectRule(1, `^https?://`, "Focus"));
        eff.allow.forEach((domain, i) => { if (domain) newRules.push(allowRule(i + 2, domain)); });
      } else {
        // HARD_BLOCKLIST / LIGHT / NONE — honor temporary bypasses unless this decision
        // says to ignore them (a live Quick Focus hard-block).
        const active = eff.block.filter(domain => {
          if (eff.ignoreBypass) return true;
          const expiry = whitelisted[domain];
          if (expiry && expiry > now) {
            console.log(`Domain "${domain}" is currently whitelisted. Skipping blocker registration.`);
            return false;
          }
          return true;
        });
        active.forEach((domain, i) => {
          if (domain) newRules.push(redirectRule(i + 1, `^https?://(?:www\\.)?${escapeRegExp(domain)}(/.*)?`, getAppName(domain)));
        });
      }

      const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existingRules.map(rule => rule.id),
        addRules: newRules
      });

      console.log(`Blocker updated (${eff.mode}): registered ${newRules.length} rules.`);
    } catch (error) {
      console.error("Error updating blocker rules:", error);
    }
  });
  return updateRulesPromise;
}

// ── FIREBASE AUTH & TOKEN REFRESH ENGINE ──

// Authenticate user with Email and Password
async function signIn(email, password) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_CONFIG.apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(friendlyAuthError(data.error?.message) || "Sign-in failed");
  }

  // Save auth info in storage with expiry timestamp
  const expiryTime = Date.now() + parseInt(data.expiresIn) * 1000;
  await chrome.storage.local.set({
    uid: data.localId,
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    authEmail: data.email,
    tokenExpiry: expiryTime,
    authProvider: 'password'
  });
  await chrome.storage.local.set({ emailVerified: await fetchEmailVerified(data.idToken) });

  console.log(`User ${data.email} successfully logged in.`);
  return { uid: data.localId };
}

// Create a new Firebase account with Email and Password (the extension previously had no
// sign-up path at all — only SIGN_IN — so there was no way to create an account from the
// popup itself, matching the mobile app's create-account-first flow).
async function signUp(email, password) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_CONFIG.apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(friendlyAuthError(data.error?.message) || "Sign-up failed");
  }

  const expiryTime = Date.now() + parseInt(data.expiresIn) * 1000;
  await chrome.storage.local.set({
    uid: data.localId,
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    authEmail: data.email,
    tokenExpiry: expiryTime,
    authProvider: 'password',
    emailVerified: false // brand-new password account — always starts unverified
  });

  console.log(`Account created and logged in for ${data.email}.`);
  return { uid: data.localId };
}

// Looks up the signed-in user's current emailVerified flag via Identity Toolkit's
// accounts:lookup (the REST equivalent of the Android SDK's user.reload()) — Firebase's own
// signIn/signUp responses don't include this field. Called after sign-in and again after a
// successful OTP verification, so the extension's locally-cached flag stays accurate.
async function fetchEmailVerified(idToken) {
  try {
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_CONFIG.apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    });
    const data = await response.json();
    if (!response.ok) return false;
    return !!(data.users && data.users[0] && data.users[0].emailVerified);
  } catch (error) {
    console.error("Failed to fetch emailVerified status:", error);
    return false;
  }
}

// Maps Firebase's raw Identity Toolkit REST error codes (e.g. "EMAIL_EXISTS",
// "WEAK_PASSWORD : Password should be at least 6 characters") onto the same plain-language
// messages the Android app's AuthRepository surfaces, instead of showing the raw code.
function friendlyAuthError(rawMessage) {
  if (!rawMessage) return null;
  const code = rawMessage.split(' : ')[0];
  switch (code) {
    case 'EMAIL_EXISTS':
      return 'An account with this email already exists. Try signing in instead.';
    case 'EMAIL_NOT_FOUND':
    case 'INVALID_PASSWORD':
    case 'INVALID_LOGIN_CREDENTIALS':
      return 'Incorrect email or password.';
    case 'WEAK_PASSWORD':
      return 'Password should be at least 6 characters.';
    case 'INVALID_EMAIL':
      return 'Enter a valid email address.';
    case 'TOO_MANY_ATTEMPTS_TRY_LATER':
      return 'Too many attempts. Please wait a moment and try again.';
    default:
      return rawMessage;
  }
}

// Google Sign-In via Web Auth Flow
async function signInWithGoogle() {
  let redirectUri = chrome.identity.getRedirectURL(); // e.g. https://<ext-id>.chromiumapp.org/
  if (redirectUri.includes('identity.getfirefox.com')) {
    redirectUri = redirectUri.replace('https://identity.getfirefox.com/', 'http://127.0.0.1/mozoauth2/');
  }
  const nonce = Math.random().toString(36).substring(2, 15);
  const clientId = FIREBASE_CONFIG.googleClientId;
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&response_type=id_token&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent('openid email profile')}&nonce=${nonce}`;

  console.log("Launching Google OAuth web flow...");
  
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, async (responseUrl) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (!responseUrl) {
        return reject(new Error("Google Sign-In was cancelled or failed to redirect."));
      }

      try {
        const matches = responseUrl.match(/id_token=([^&]+)/);
        if (!matches || !matches[1]) {
          return reject(new Error("OAuth response URL did not contain ID Token."));
        }
        const googleIdToken = matches[1];

        // Exchange Google ID Token for Firebase credentials
        const exchangeUrl = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${FIREBASE_CONFIG.apiKey}`;
        const response = await fetch(exchangeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            postBody: `id_token=${googleIdToken}&providerId=google.com`,
            requestUri: redirectUri,
            returnIdpCredential: true,
            returnSecureToken: true
          })
        });

        const data = await response.json();
        if (!response.ok) {
          return reject(new Error(data.error?.message || "Firebase IDP exchange failed"));
        }

        const expiryTime = Date.now() + parseInt(data.expiresIn) * 1000;
        await chrome.storage.local.set({
          uid: data.localId,
          idToken: data.idToken,
          refreshToken: data.refreshToken,
          authEmail: data.email,
          tokenExpiry: expiryTime,
          authProvider: 'google',
          emailVerified: true // Google-verified — never needs the OTP flow
        });

        console.log(`User ${data.email} logged in successfully via Google Sign-In.`);
        resolve({ uid: data.localId });
      } catch (err) {
        reject(err);
      }
    });
  });
}

// Sign Out
async function signOut() {
  await chrome.storage.local.remove([
    'uid', 'idToken', 'refreshToken', 'authEmail', 'tokenExpiry',
    'authProvider', 'emailVerified',
    'appCheckToken', 'appCheckExpiry',
    'sync_watermarks', 'local_intervention_events', 'protocol_runs_list',
    'web_blocked_sites_list', 'engagement_state', 'practice_state',
    'work_profile', 'quick_focus_session', 'quick_focus_reward_history',
    'quick_focus_skip_history', 'work_profile_reward_history',
    'last_synced_at', 'subscriptionTier'
  ]);
  console.log("User logged out. Auth keys and synced cache cleared.");
  // Re-initialize blocker rules to defaults
  await updateBlockerRules();
}

// Retrieve or refresh a valid Firebase ID Token
async function getValidIdToken() {
  const result = await chrome.storage.local.get(['idToken', 'refreshToken', 'tokenExpiry']);
  if (!result.idToken || !result.refreshToken) {
    return null; // Not logged in
  }

  // Refresh if token is expired or close to expiry (within 5 minutes)
  const now = Date.now();
  if (result.tokenExpiry && result.tokenExpiry - now > 5 * 60 * 1000) {
    return result.idToken;
  }

  console.log("Firebase ID Token expired or expiring soon. Refreshing...");
  try {
    const url = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_CONFIG.apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(result.refreshToken)}`
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || "Token refresh failed");
    }

    const newExpiry = Date.now() + parseInt(data.expires_in) * 1000;
    await chrome.storage.local.set({
      idToken: data.id_token,
      refreshToken: data.refresh_token,
      tokenExpiry: newExpiry
    });

    console.log("Firebase ID Token refreshed successfully.");
    return data.id_token;
  } catch (error) {
    console.error("Token refresh failed:", error);
    // Force sign-out on auth credentials failure
    await signOut();
    return null;
  }
}

// ── FIREBASE APP CHECK TOKEN EXCHANGE ──

// Exchange reCAPTCHA v3 token for an App Check token
async function exchangeAppCheckToken(recaptchaToken) {
  try {
    console.log("Exchanging reCAPTCHA token for App Check token...");
    const url = `https://firebaseappcheck.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/apps/${FIREBASE_CONFIG.appId}:exchangeRecaptchaV3Token?key=${FIREBASE_CONFIG.apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recaptchaV3Token: recaptchaToken })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || "App Check token exchange failed");
    }

    // TTL matches standard response (e.g. "86400s" or "3600s"). Parse to seconds.
    const ttlSeconds = parseInt(data.ttl) || 86400; 
    const expiry = Date.now() + ttlSeconds * 1000;

    await chrome.storage.local.set({
      appCheckToken: data.attestationToken,
      appCheckExpiry: expiry
    });

    console.log("App Check token successfully cached. Expiry in", ttlSeconds, "seconds.");
    return data.attestationToken;
  } catch (error) {
    console.error("App Check Exchange failed:", error);
    throw error;
  }
}

// Get cached or request active App Check token
async function getValidAppCheckToken() {
  const result = await chrome.storage.local.get(['appCheckToken', 'appCheckExpiry']);
  if (result.appCheckToken && result.appCheckExpiry && result.appCheckExpiry > Date.now()) {
    return result.appCheckToken;
  }
  return null; // App check token needs refresh from client pages
}

// ── FIRESTORE REST API CODECS (LWW COMPATIBLE) ──

function decodeFirestoreValue(val) {
  if (!val) return null;
  if (val.stringValue !== undefined) return val.stringValue;
  if (val.integerValue !== undefined) return parseInt(val.integerValue, 10);
  if (val.doubleValue !== undefined) return parseFloat(val.doubleValue);
  if (val.booleanValue !== undefined) return val.booleanValue;
  if (val.arrayValue !== undefined) {
    return (val.arrayValue.values || []).map(decodeFirestoreValue);
  }
  if (val.mapValue !== undefined) {
    return parseFirestoreFields(val.mapValue.fields || {});
  }
  if (val.nullValue !== undefined) return null;
  return undefined;
}

function parseFirestoreFields(fields) {
  const result = {};
  for (const [key, val] of Object.entries(fields)) {
    result[key] = decodeFirestoreValue(val);
  }
  return result;
}

function encodeFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (Number.isInteger(val)) return { integerValue: String(val) };
  if (typeof val === 'number') return { doubleValue: val };
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map(encodeFirestoreValue) } };
  }
  if (typeof val === 'object') {
    return { mapValue: { fields: encodeFirestoreFields(val) } };
  }
  return { nullValue: null };
}

function encodeFirestoreFields(obj) {
  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    result[key] = encodeFirestoreValue(val);
  }
  return result;
}

// ── FIRESTORE REST API NETWORK CLIENTS ──

async function queryFirestoreSubcollection(uid, collectionId, sinceMs) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/users/${uid}:runQuery?key=${FIREBASE_CONFIG.apiKey}`;
  
  const idToken = await getValidIdToken();
  if (!idToken) return [];
  
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${idToken}`
  };
  
  const appCheckToken = await getValidAppCheckToken();
  if (appCheckToken) {
    headers['X-Firebase-AppCheck'] = appCheckToken;
  }
  
  const body = {
    structuredQuery: {
      from: [{ collectionId }],
      where: {
        fieldFilter: {
          field: { fieldPath: "updatedAt" },
          op: "GREATER_THAN",
          value: { integerValue: String(sinceMs) }
        }
      },
      orderBy: [
        {
          field: { fieldPath: "updatedAt" },
          direction: "ASCENDING"
        }
      ]
    }
  };
  
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  
  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error?.message || `runQuery failed for ${collectionId}`);
  }
  
  const data = await response.json();
  if (!Array.isArray(data)) return [];
  
  return data
    .filter(result => result.document)
    .map(result => {
      const doc = result.document;
      const syncId = doc.name.split('/').pop();
      const fullFields = parseFirestoreFields(doc.fields || {});
      const updatedAt = fullFields.updatedAt || 0;
      const deleted = fullFields.deleted || false;
      
      delete fullFields.updatedAt;
      delete fullFields.deleted;
      
      return {
        syncId,
        updatedAt,
        deleted,
        payload: fullFields
      };
    });
}

// Single-document REST GET on users/{uid}/private/entitlement — the canonical entitlement
// doc both the Adapty and Dodo webhooks write server-side (see gylb-astro's
// resolveEntitlement.ts). Same ID-token + App-Check auth pattern as queryFirestoreSubcollection,
// just a document GET instead of a runQuery. Returns null if the doc doesn't exist yet
// (brand-new account, never purchased). firestore.rules already allows owns(uid) read access
// here — no rules change needed.
async function getEntitlementDoc(uid) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/users/${uid}/private/entitlement?key=${FIREBASE_CONFIG.apiKey}`;

  const idToken = await getValidIdToken();
  if (!idToken) return null;

  const headers = { 'Authorization': `Bearer ${idToken}` };
  const appCheckToken = await getValidAppCheckToken();
  if (appCheckToken) {
    headers['X-Firebase-AppCheck'] = appCheckToken;
  }

  const response = await fetch(url, { headers });
  if (response.status === 404) return null;
  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error?.message || `getEntitlementDoc failed: ${response.status}`);
  }

  const doc = await response.json();
  return parseFirestoreFields(doc.fields || {});
}

async function pushFirestoreInterventionEvents(uid, events) {
  if (events.length === 0) return;
  
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents:commit?key=${FIREBASE_CONFIG.apiKey}`;
  
  const idToken = await getValidIdToken();
  if (!idToken) return;
  
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${idToken}`
  };
  
  const appCheckToken = await getValidAppCheckToken();
  if (appCheckToken) {
    headers['X-Firebase-AppCheck'] = appCheckToken;
  }
  
  const writes = events.map(event => {
    const fullPayload = {
      ...event.payload,
      updatedAt: event.updatedAt,
      deleted: event.deleted
    };
    
    const docPath = `projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/users/${uid}/interventionEvents/${event.syncId}`;
    
    return {
      update: {
        name: docPath,
        fields: encodeFirestoreFields(fullPayload)
      }
    };
  });
  
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ writes })
  });
  
  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error?.message || "commit failed for interventionEvents");
  }
}

// Upsert a SINGLE Firestore document at users/{uid}/{collectionId}/{docId}. Used for the
// work profile (one canonical doc per user), unlike the append-only interventionEvents.
async function pushFirestoreDoc(uid, collectionId, docId, payload) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents:commit?key=${FIREBASE_CONFIG.apiKey}`;

  const idToken = await getValidIdToken();
  if (!idToken) return;

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${idToken}`
  };
  const appCheckToken = await getValidAppCheckToken();
  if (appCheckToken) {
    headers['X-Firebase-AppCheck'] = appCheckToken;
  }

  const docPath = `projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/users/${uid}/${collectionId}/${docId}`;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ writes: [{ update: { name: docPath, fields: encodeFirestoreFields(payload) } }] })
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error?.message || `commit failed for ${collectionId}/${docId}`);
  }
}

// Batch-upsert several docs into the same list-collection in one commit. Used for
// `webBlockedSites` (each doc keyed by its own docId, unlike interventionEvents' fixed
// syncId scheme) — generalizes pushFirestoreInterventionEvents's batching for a
// collection where the extension itself picks the doc id (the domain string).
async function pushFirestoreCollectionDocs(uid, collectionId, docs) {
  if (docs.length === 0) return;

  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents:commit?key=${FIREBASE_CONFIG.apiKey}`;

  const idToken = await getValidIdToken();
  if (!idToken) return;

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${idToken}`
  };
  const appCheckToken = await getValidAppCheckToken();
  if (appCheckToken) {
    headers['X-Firebase-AppCheck'] = appCheckToken;
  }

  const writes = docs.map(doc => {
    const fullPayload = { ...doc.payload, updatedAt: doc.updatedAt, deleted: doc.deleted };
    const docPath = `projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/users/${uid}/${collectionId}/${doc.docId}`;
    return { update: { name: docPath, fields: encodeFirestoreFields(fullPayload) } };
  });

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ writes })
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error?.message || `commit failed for ${collectionId}`);
  }
}

// Small random id — same two-piece base36 scheme already used inline for
// interventionEvents' syncId (recordInterventionEvent), factored out for reuse by any
// new locally-originated record (e.g. a website added via the extension's own UI).
function generateSyncId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// ── LOCAL DATABASE LWW DEDUPLICATION & MERGING ──

// Merges the phone-owned/extension-owned `webBlockedSites` Firestore subcollection
// (one doc per real website domain — NOT the Android `blockedApps` collection, which is
// keyed by Android packageName and has no valid domain for a browser DNR rule; that
// collection is intentionally never pulled here anymore, see EXTENSION_ARCHITECTURE_PLAN.md
// §4.4). Bidirectional: either the phone app's Extension Control screen or this
// extension's own "Blocked Websites" add-domain UI (popup.js handleAddDomain/
// handleRemoveDomain, via the SYNC_WEB_SITE_CHANGE message below) can add/remove a
// domain; both sides converge via plain last-write-wins on `updatedAt`, same pattern as
// every other synced collection in this file.
async function mergeWebBlockedSites(pulledRecords) {
  return new Promise((resolve) => {
    chrome.storage.local.get(['web_blocked_sites_list', 'blocked_domains'], (result) => {
      const currentList = result.web_blocked_sites_list || [];

      const listMap = {};
      currentList.forEach(item => {
        listMap[item.syncId] = item;
        if (item.domain) {
          listMap[item.domain] = item;
        }
      });

      let changed = false;

      pulledRecords.forEach(record => {
        const domain = record.payload.domain;
        if (!domain) return;

        const existing = listMap[record.syncId] || listMap[domain];

        if (!existing || record.updatedAt > existing.updatedAt) {
          listMap[record.syncId] = {
            syncId: record.syncId,
            domain: domain,
            enabled: record.payload.enabled !== false,
            deleted: record.deleted,
            updatedAt: record.updatedAt,
            synced: true
          };
          changed = true;
        }
      });

      if (!changed && result.web_blocked_sites_list) {
        resolve();
        return;
      }

      const newList = Object.values(listMap).filter((item, index, self) =>
        self.findIndex(t => t.syncId === item.syncId) === index
      );

      const newDomainsSet = new Set();
      newList.forEach(item => {
        if (!item.deleted && item.enabled) {
          newDomainsSet.add(item.domain);
        }
      });

      const newDomains = Array.from(newDomainsSet);

      chrome.storage.local.set({
        web_blocked_sites_list: newList,
        blocked_domains: newDomains
      }, () => {
        console.log(`Synced webBlockedSites list. Active domains: ${newDomains.length}`);
        resolve();
      });
    });
  });
}

async function mergeState(pulledRecords) {
  return new Promise((resolve) => {
    chrome.storage.local.get(['engagement_state', 'practice_state'], (result) => {
      const currentEng = result.engagement_state || { updatedAt: 0 };
      const currentPrac = result.practice_state || { updatedAt: 0 };
      
      let newEng = { ...currentEng };
      let newPrac = { ...currentPrac };
      let changed = false;
      
      pulledRecords.forEach(record => {
        if (record.syncId === 'engagement') {
          if (record.updatedAt > (currentEng.updatedAt || 0)) {
            newEng = {
              dayTokens: record.payload.dayTokens || [],
              updatedAt: record.updatedAt
            };
            changed = true;
          }
        } else if (record.syncId === 'practiceCompletion') {
          if (record.updatedAt > (currentPrac.updatedAt || 0)) {
            newPrac = {
              runSyncId: record.payload.runSyncId || null,
              completedDays: record.payload.completedDays || [],
              updatedAt: record.updatedAt
            };
            changed = true;
          }
        }
      });
      
      if (!changed) {
        resolve();
        return;
      }
      
      chrome.storage.local.set({
        engagement_state: newEng,
        practice_state: newPrac
      }, () => {
        console.log("Synced state documents.");
        resolve();
      });
    });
  });
}

async function mergeProtocolRuns(pulledRecords) {
  return new Promise((resolve) => {
    chrome.storage.local.get(['protocol_runs_list'], (result) => {
      const currentList = result.protocol_runs_list || [];
      const runMap = {};
      currentList.forEach(run => {
        runMap[run.syncId] = run;
      });
      
      let changed = false;
      pulledRecords.forEach(record => {
        const existing = runMap[record.syncId];
        if (!existing || record.updatedAt > existing.updatedAt) {
          runMap[record.syncId] = {
            syncId: record.syncId,
            protocolId: record.payload.protocolId,
            status: record.payload.status,
            currentDay: record.payload.currentDay || 1,
            deleted: record.deleted,
            updatedAt: record.updatedAt
          };
          changed = true;
        }
      });
      
      if (!changed && result.protocol_runs_list) {
        resolve();
        return;
      }
      
      const newList = Object.values(runMap);
      chrome.storage.local.set({
        protocol_runs_list: newList
      }, () => {
        console.log(`Synced protocolRuns.`);
        resolve();
      });
    });
  });
}

// ── PHASE 3b: WORK PROFILE FOCUS COMPLETION REWARD ──
// Work Profile has no discrete session lifecycle like Quick Focus (start/end messages) —
// it's continuously re-evaluated every minute by wp_tick. WorkProfileEngine.detectCompletedFocusWindows
// notices when a previously-live FOCUS window drops out of the active set (which anti-cheat
// guarantees only happens by reaching its own `end`) by diffing against a snapshot taken on
// the prior tick. Same extension-only post-adjustment pattern as Phase 3a: credited to
// `work_profile_reward_history`, folded into recalculateScores() as a Sovereignty-only bonus,
// same reasoning as the Quick Focus reward for why this stays outside the mirrored
// LifeScoreCalculator (see recalculateScores()'s own architecture note).
async function checkWorkProfileFocusCompletions() {
  const result = await chrome.storage.local.get([
    'work_profile', 'work_profile_focus_snapshot', 'work_profile_reward_history'
  ]);
  const now = new Date();
  const profile = result.work_profile;
  const activeFocus = profile
    ? WorkProfileEngine.activeWindows(profile, now).filter((w) => w.mode === WorkProfileEngine.MODE_FOCUS)
    : [];

  const { completed, nextSnapshot } = WorkProfileEngine.detectCompletedFocusWindows(
    result.work_profile_focus_snapshot, activeFocus, now
  );

  const updates = { work_profile_focus_snapshot: nextSnapshot };
  if (completed.length > 0) {
    const history = result.work_profile_reward_history || [];
    let anyAwarded = false;
    for (const { id, dateKey, window } of completed) {
      const points = WorkProfileEngine.focusBonusPoints(window);
      if (points > 0) {
        history.push({ timestamp: Date.now(), points, windowId: id, dateKey });
        anyAwarded = true;
        await recordExtensionScoreEvent('work_profile_reward', { sovereigntyDelta: points });
      }
    }
    if (anyAwarded) {
      updates.work_profile_reward_history = history;
      console.log(`Work Profile FOCUS window(s) completed: ${completed.length}, bonus points credited.`);
    }
  }

  await chrome.storage.local.set(updates);
  if (updates.work_profile_reward_history) {
    await recalculateScores();
  }
}

// ── EXTENSION SCORE EVENTS (cross-platform sync shadow) ──
// The four reward/penalty histories below (quick_focus_reward_history, quick_focus_skip_history,
// work_profile_reward_history, wellbeing_reward_history) are EXTENSION-ONLY and stay exactly as
// they are — recalculateScores() keeps reading them directly for this device's own live score,
// unchanged. This is a SEPARATE, normalized shadow copy of the same events, pushed to Firestore
// so the Android app (which has no concept of Quick Focus/Work Profile/Wellbeing Tools) can
// independently compute the identical Sovereignty/Compliance/Clarity adjustment itself, instead
// of the two platforms silently diverging (see the 2026-07-09 cross-platform Sovereignty
// mismatch this was built to fix). Android is pull-only here — it never originates one of these
// events, so there's no local/remote merge conflict to resolve, just append-and-pull.
//
// Firestore shape (users/{uid}/extensionScoreEvents/{docId}):
//   { source: 'quick_focus_reward'|'quick_focus_skip'|'work_profile_reward'|'wellbeing_reward',
//     updatedAt, deleted: false,
//     sovereigntyDelta, complianceDelta, clarityDelta,   // pre-summed for every source EXCEPT
//                                                         // quick_focus_skip, which needs the
//                                                         // raw fields below replayed in order
//                                                         // through the same decaying-heat
//                                                         // algorithm QuickFocusSkipEngine uses
//                                                         // (a Kotlin port of it, not a sum).
//     minutesUsedAfterSkip }                              // quick_focus_skip only, else null

// Appends one normalized event to the local shadow array. `docId` is optional — pass a STABLE
// id (not a fresh random one) when a later call needs to UPDATE this same event rather than
// create a new one (see the skip-penalty provisional -> finalized flow below).
async function recordExtensionScoreEvent(source, fields, docId) {
  const result = await chrome.storage.local.get(['extension_score_events']);
  const events = result.extension_score_events || [];
  const id = docId || generateSyncId();
  const existingIdx = events.findIndex((e) => e.docId === id);
  const entry = {
    docId: id,
    source,
    updatedAt: Date.now(),
    sovereigntyDelta: fields.sovereigntyDelta || 0,
    complianceDelta: fields.complianceDelta || 0,
    clarityDelta: fields.clarityDelta || 0,
    minutesUsedAfterSkip: typeof fields.minutesUsedAfterSkip === 'number' ? fields.minutesUsedAfterSkip : null,
    synced: false,
  };
  if (existingIdx !== -1) {
    events[existingIdx] = entry;
  } else {
    events.push(entry);
  }
  await chrome.storage.local.set({ extension_score_events: events });
}

// ── WELLBEING TOOLS (Eye Rest 20-20-20 + Water Break) ──
// Water Break is Free tier; Eye Rest requires Extension Pro (isEntitledToExtensionPro()).
// Both share one config object (WellbeingRemindersEngine.defaultConfig()) under storage key
// `wellbeing_tools`, checked every minute by the `wellbeing_tick` alarm — see
// WellbeingRemindersEngine.js's header for the full data model and why a 1-minute
// re-evaluation is used instead of per-type dynamic-period alarms.

async function getWellbeingConfig() {
  const result = await chrome.storage.local.get(['wellbeing_tools']);
  return result.wellbeing_tools || WellbeingRemindersEngine.defaultConfig();
}

async function playTimerEndSound() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    let exists = false;
    for (const context of contexts) {
      if (context.documentUrl.endsWith('offscreen.html')) {
        exists = true;
        break;
      }
    }
    if (!exists) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'Play timer end sound for water break'
      });
    }
    setTimeout(() => {
      chrome.runtime.sendMessage({ action: 'PLAY_SOUND', file: 'timerend.mp3' }).catch(() => {});
    }, 200);
  } catch (err) {
    console.error("Failed to play timer end sound via offscreen:", err);
  }
}

// Fires whichever of the two reminders is due, per its own configured mode.
async function checkWellbeingReminders() {
  const config = await getWellbeingConfig();
  const now = Date.now();
  let changed = false;

  const eyeEntitled = config.eyeRest.enabled && await isEntitledToExtensionPro();
  if (eyeEntitled && WellbeingRemindersEngine.shouldFire(WellbeingRemindersEngine.TYPE_EYE_REST, config.eyeRest, now)) {
    config.eyeRest.lastFiredAt = now;
    changed = true;
    await fireWellbeingReminder(WellbeingRemindersEngine.TYPE_EYE_REST, config.eyeRest.mode);
  }

  if (WellbeingRemindersEngine.shouldFire(WellbeingRemindersEngine.TYPE_WATER_BREAK, config.waterBreak, now)) {
    config.waterBreak.lastFiredAt = now;
    changed = true;
    playTimerEndSound();
    await fireWellbeingReminder(WellbeingRemindersEngine.TYPE_WATER_BREAK, config.waterBreak.mode);
  }

  if (changed) {
    await chrome.storage.local.set({ wellbeing_tools: config });
  }
}

// Dispatches one reminder occurrence per its configured mode. Notification button-click
// completion is handled by the chrome.notifications.onButtonClicked listener below; pause-
// screen completion is handled by the WELLBEING_REMINDER_DONE message from wellbeing_break.js.
async function fireWellbeingReminder(type, mode) {
  const content = WellbeingRemindersEngine.contentFor(type);

  if (mode === WellbeingRemindersEngine.MODE_NOTIFICATION) {
    // Encode the type directly in the notification ID (rather than a separate storage
    // lookup) so onButtonClicked can recover it even if the worker went idle and woke up
    // fresh in between — there's no other state to reconcile.
    const notificationId = `wellbeing_notif_${type}_${Date.now()}`;
    chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: 'focus_dashboard_icon.jpg',
      title: content.title,
      message: content.message,
      buttons: [{ title: content.notificationButtonTitle }],
      priority: 1,
    });
    return;
  }

  // PAUSE_SCREEN: interrupt the user's current active tab, same idiom as opening any other
  // extension-owned page over a live tab (see closeAndOpenNewTab/ExitBehaviorEngine usage).
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs[0];
    if (!tab || !tab.id) return; // no window open to interrupt — quietly skip, no penalty
    const url = chrome.runtime.getURL(`wellbeing_break.html?${WellbeingRemindersEngine.pauseScreenQuery(type)}`);
    await chrome.tabs.update(tab.id, { url });
  } catch (err) {
    console.error('Failed to open Wellbeing pause screen:', err);
  }
}

// Called when the user actually complies (clicks the notification's Done button, or
// finishes the pause-screen flow) — awards points per WellbeingRemindersEngine's founder-
// approved batching rule and folds them into the scorecard the same way Quick Focus/Work
// Profile bonuses are (see recalculateScores()'s architecture note).
async function completeWellbeingReminder(type) {
  const config = await getWellbeingConfig();
  const reminder = type === WellbeingRemindersEngine.TYPE_EYE_REST ? config.eyeRest : config.waterBreak;
  const isNotificationMode = reminder.mode === WellbeingRemindersEngine.MODE_NOTIFICATION;
  const award = WellbeingRemindersEngine.computeCompletionAward(reminder.completedCount);
  reminder.completedCount = award.newCount;

  const result = await chrome.storage.local.get(['wellbeing_reward_history']);
  const history = result.wellbeing_reward_history || [];
  // No points if notification mode is active, per founder's instruction.
  const anyPoints = !isNotificationMode && (award.clarityDelta || award.complianceDelta || award.sovereigntyDelta);
  if (anyPoints) {
    history.push({
      timestamp: Date.now(), type,
      clarityDelta: award.clarityDelta, complianceDelta: award.complianceDelta, sovereigntyDelta: award.sovereigntyDelta,
    });
  }

  await chrome.storage.local.set({ wellbeing_tools: config, wellbeing_reward_history: history });
  if (anyPoints) {
    await recordExtensionScoreEvent('wellbeing_reward', {
      clarityDelta: award.clarityDelta, complianceDelta: award.complianceDelta, sovereigntyDelta: award.sovereigntyDelta,
    });
    await recalculateScores();
  }
}

// Notification "Done ✓" button click — the only button on a Wellbeing notification, so
// buttonIndex isn't checked beyond existing.
chrome.notifications.onButtonClicked.addListener((notificationId) => {
  const match = notificationId.match(/^wellbeing_notif_(EYE_REST|WATER_BREAK)_\d+$/);
  if (!match) return;
  chrome.notifications.clear(notificationId);
  completeWellbeingReminder(match[1]).catch(err => console.error('Failed to record Wellbeing reminder completion:', err));
});

// ── PURE SCORING CALCULATIONS PIPELINE ──

// Sum of bonus points (Quick Focus completions, Work Profile FOCUS completions) recorded
// at or before `cutoffMs` — no decay, a completed session's earned points are permanent
// (unlike the escalating Skip Pass penalty).
function sumQuickFocusRewardPoints(history, cutoffMs) {
  return (history || []).reduce((sum, r) => (r.timestamp <= cutoffMs ? sum + (r.points || 0) : sum), 0);
}

// Same shape of helper for `wellbeing_reward_history` entries, which carry three separate
// deltas (clarity/compliance/sovereignty) per entry instead of one `points` field — see
// WellbeingRemindersEngine.computeCompletionAward.
function sumWellbeingRewardField(history, field, cutoffMs) {
  return (history || []).reduce((sum, r) => (r.timestamp <= cutoffMs ? sum + (r[field] || 0) : sum), 0);
}

async function recalculateScores() {
  return new Promise((resolve) => {
    chrome.storage.local.get([
      'uid',
      'subscriptionTier',
      'local_intervention_events',
      'engagement_state',
      'protocol_runs_list',
      'practice_state',
      'quick_focus_reward_history',
      'quick_focus_skip_history',
      'work_profile_reward_history',
      'wellbeing_reward_history'
    ], (result) => {
      if (!result.uid) {
        // Logged out: return default/baseline values
        chrome.storage.local.set({
          sovereignty: 100,
          compliance: 65,
          clarity: 50,
          streakDays: 0,
          longestStreakDays: 0,
          sovereigntyLevel: 1,
          levelProgress: 0.0,
          complianceChange: 0,
          sovereigntyChange: 0,
          clarityChange: 0
        }, () => resolve());
        return;
      }

      const rawEvents = (result.local_intervention_events || [])
        .filter(e => !e.deleted && e.payload)
        .map(e => ({
          syncId: e.syncId,
          type: e.payload.type,
          packageName: e.payload.packageName,
          timestamp: e.payload.timestamp,
          magnitude: e.payload.magnitude,
          origin: e.payload.origin
        }));
      const nowMs = Date.now();
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      
      // Determine midnight local time boundaries
      const nowDateStr = new Date(nowMs).toISOString().split('T')[0];
      const yesterdayDateStr = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const todayStartMs = new Date(new Date(nowMs).setHours(0,0,0,0)).getTime();

      // 1. Aggregate InterventionEvents at today vs yesterday
      const nowAgg = InterventionSignalAggregator.aggregate(rawEvents, nowMs, zone);
      const yesterdayAgg = InterventionSignalAggregator.aggregate(rawEvents, todayStartMs, zone);

      // 2. Fetch or compute streaks from engagement day tokens
      const engagement = result.engagement_state || { dayTokens: [], updatedAt: nowMs };
      const nowEng = EngagementSignalCalculator.compute(engagement.dayTokens, nowDateStr);
      const yesterdayEng = EngagementSignalCalculator.compute(engagement.dayTokens, yesterdayDateStr);

      // 3. Compute protocol achievements
      const allRuns = result.protocol_runs_list || [];
      let completedProtocolDays = 0;
      let protocolsCompleted = 0;
      let activeRun = null;

      allRuns.forEach(run => {
        if (!run.deleted) {
          if (run.status === 'COMPLETED') {
            completedProtocolDays += run.currentDay;
            protocolsCompleted++;
          } else if (run.status === 'ACTIVE') {
            activeRun = run;
            completedProtocolDays += Math.max(0, run.currentDay - 1);
          }
        }
      });

      // 4. Inactivity calculation
      const inactivityDaysNow = EngagementSignalCalculator.inactivityDays(engagement.dayTokens, nowDateStr);
      const inactivityDaysYesterday = EngagementSignalCalculator.inactivityDays(engagement.dayTokens, yesterdayDateStr);

      // 5. Assemble signals
      const makeSignals = (agg, eng, inactivity) => ({
        complyCount: agg.complyCount,
        bypassCount: agg.bypassCount,
        weakComplyCount: agg.weakComplyCount,
        cleanDays: agg.cleanDays,
        scheduledHeldDays: agg.scheduledHeldDays,
        recentResist: agg.recentResist,
        recentRelapse: agg.recentRelapse,
        completedProtocolDays,
        protocolsCompleted,
        currentStreakDays: eng.currentStreakDays,
        longestStreakDays: eng.longestStreakDays,
        engagedDays: eng.engagedDays,
        selfBlockMinutes: agg.selfBlockMinutes,
        inactivityDays: inactivity,
        skipShortPenaltyUnits: agg.skipShortPenaltyUnits
      });

      const nowSignals = makeSignals(nowAgg, nowEng, inactivityDaysNow);
      const yesterdaySignals = makeSignals(yesterdayAgg, yesterdayEng, inactivityDaysYesterday);

      // 6. Calculate scores. LifeScoreCalculator.compute() is an exact mirror of the
      // Kotlin app's calculator (see its own header comment) — Quick Focus, Work Profile
      // FOCUS completions, and now Wellbeing Tools reminders are EXTENSION-ONLY features
      // with no Android equivalent yet, so rather than adding fields to that shared,
      // mirrored signal contract (which would force a matching no-op change in the Kotlin
      // calculator for features it doesn't have), they're layered on top as separate
      // adjustments here — Sovereignty for Quick Focus/Work Profile, and all three scores
      // for Wellbeing Tools (see WellbeingRemindersEngine.computeCompletionAward). If
      // Android ever ships an equivalent feature, fold this into the shared calculator +
      // Kotlin mirror instead (guardrail #2 in BACKEND_HANDOFF.md).
      const nowScoresBase = LifeScoreCalculator.compute(nowSignals);
      const yesterdayScoresBase = LifeScoreCalculator.compute(yesterdaySignals);

      const rewardHistory = result.quick_focus_reward_history || [];
      const skipHistory = result.quick_focus_skip_history || [];
      const wpRewardHistory = result.work_profile_reward_history || [];
      const wbRewardHistory = result.wellbeing_reward_history || [];
      const nowQfBonus = sumQuickFocusRewardPoints(rewardHistory, nowMs) + sumQuickFocusRewardPoints(wpRewardHistory, nowMs);
      const yesterdayQfBonus = sumQuickFocusRewardPoints(rewardHistory, todayStartMs) + sumQuickFocusRewardPoints(wpRewardHistory, todayStartMs);
      const nowQfPenalty = QuickFocusSkipEngine.aggregatePenalties(
        skipHistory.filter(h => h.timestamp <= nowMs)
      ).totalPenaltyUnits;
      const yesterdayQfPenalty = QuickFocusSkipEngine.aggregatePenalties(
        skipHistory.filter(h => h.timestamp <= todayStartMs)
      ).totalPenaltyUnits;

      const nowWbSovereignty = sumWellbeingRewardField(wbRewardHistory, 'sovereigntyDelta', nowMs);
      const yesterdayWbSovereignty = sumWellbeingRewardField(wbRewardHistory, 'sovereigntyDelta', todayStartMs);
      const nowWbClarity = sumWellbeingRewardField(wbRewardHistory, 'clarityDelta', nowMs);
      const yesterdayWbClarity = sumWellbeingRewardField(wbRewardHistory, 'clarityDelta', todayStartMs);
      const nowWbCompliance = sumWellbeingRewardField(wbRewardHistory, 'complianceDelta', nowMs);
      const yesterdayWbCompliance = sumWellbeingRewardField(wbRewardHistory, 'complianceDelta', todayStartMs);

      const nowScores = {
        ...nowScoresBase,
        sovereignty: Math.max(0, Math.round(nowScoresBase.sovereignty + nowQfBonus - nowQfPenalty + nowWbSovereignty)),
        clarity: Math.max(0, Math.round(nowScoresBase.clarity + nowWbClarity)),
        compliance: Math.max(0, Math.round(nowScoresBase.compliance + nowWbCompliance)),
      };
      const yesterdayScores = {
        ...yesterdayScoresBase,
        sovereignty: Math.max(0, Math.round(yesterdayScoresBase.sovereignty + yesterdayQfBonus - yesterdayQfPenalty + yesterdayWbSovereignty)),
        clarity: Math.max(0, Math.round(yesterdayScoresBase.clarity + yesterdayWbClarity)),
        compliance: Math.max(0, Math.round(yesterdayScoresBase.compliance + yesterdayWbCompliance)),
      };
      const level = LifeScoreCalculator.levelFor(nowScores.sovereignty);

      // 7. Write back all scorecard metadata to storage for the popup UI
      chrome.storage.local.set({
        sovereignty: nowScores.sovereignty,
        compliance: nowScores.compliance,
        clarity: nowScores.clarity,
        streakDays: nowEng.currentStreakDays,
        longestStreakDays: nowEng.longestStreakDays,
        sovereigntyLevel: level.level,
        levelProgress: level.progressToNext,
        complianceChange: nowScores.compliance - yesterdayScores.compliance,
        sovereigntyChange: nowScores.sovereignty - yesterdayScores.sovereignty,
        clarityChange: nowScores.clarity - yesterdayScores.clarity
      }, () => {
        console.log(`Recalculated scores: Sovereignty=${nowScores.sovereignty} (L${level.level}), Compliance=${nowScores.compliance}, Clarity=${nowScores.clarity}`);
        
        // Notify popup to reload values if open
        chrome.runtime.sendMessage({ action: "SCORES_UPDATED" }).catch(() => {
          // Ignore error if popup is closed
        });
        resolve();
      });
    });
  });
}

// ── RECORD COMPLY/BYPASS INTERVENTION EVENT ──

// `origin` MUST be the BlockOrigin enum NAME (a plain string) — exactly what the Android
// app writes to Firestore (core-pil/.../domain/blocking/BlockOrigin.kt: PER_APP,
// SELF_BLOCK, SCHEDULED_BYPASSABLE, SCHEDULED_STRICT). This used to be written here as an
// object ({isScheduledWindow: bool}) instead of Android's string, so every Android-authored
// scheduled-window event pulled in via Firestore sync silently read as "not scheduled"
// (InterventionSignalAggregator checked `e.origin.isScheduledWindow`, which is undefined on
// a string) — scheduledHeldDays came out permanently 0 for that data, undercounting
// Sovereignty (3/day) and Compliance (2/day) for every day a scheduled window was actually
// held. Fixed to match Android's schema exactly.
function blockOriginFor(type, isScheduledWindow) {
  if (type === 'SELF_BLOCK') return 'SELF_BLOCK';
  return isScheduledWindow ? 'SCHEDULED_BYPASSABLE' : 'PER_APP';
}

async function recordInterventionEvent(type, packageName, magnitude = null, isScheduledWindow = false) {
  return new Promise((resolve) => {
    chrome.storage.local.get(['uid', 'local_intervention_events', 'engagement_state'], (result) => {
      const uid = result.uid;
      const events = result.local_intervention_events || [];
      const now = Date.now();

      const syncId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

      const newEvent = {
        syncId,
        updatedAt: now,
        deleted: false,
        synced: false,
        payload: {
          type,
          packageName,
          timestamp: now,
          hourBucket: new Date(now).getUTCHours(),
          magnitude,
          contextProtocolId: null,
          contextDayIndex: null,
          origin: blockOriginFor(type, isScheduledWindow)
        }
      };
      
      events.push(newEvent);
      
      const engagement = result.engagement_state || { dayTokens: [], updatedAt: now };
      const todayStr = new Date(now).toISOString().split('T')[0];
      const tokensSet = new Set(engagement.dayTokens);
      let engagementUpdated = false;
      
      if (!tokensSet.has(todayStr)) {
        tokensSet.add(todayStr);
        engagement.dayTokens = Array.from(tokensSet);
        engagement.updatedAt = now;
        engagementUpdated = true;
      }
      
      const updates = { local_intervention_events: events };
      if (engagementUpdated) {
        updates.engagement_state = engagement;
      }
      
      chrome.storage.local.set(updates, async () => {
        console.log(`Recorded local event: ${type} for ${packageName}`);
        await recalculateScores();
        
        if (uid) {
          syncFirestoreLoop().catch(err => console.error("Auto sync failed:", err));
        }
        resolve();
      });
    });
  });
}

// ── CLOUD FIRESTORE MASTER SYNC ENGINE ──

let isSyncing = false;

// Broadcast the REAL sync lifecycle so the popup can show an honest status instead of a
// canned animation. Previously nothing told the popup a sync had started or actually
// finished — showDashboard() just said "Synced" the instant it rendered, before any real
// network round-trip happened, and the popup never listened for these regardless.
function broadcastSyncStatus(status) {
  chrome.runtime.sendMessage({ action: "SYNC_STATUS", status }).catch(() => {
    // Popup isn't open — nothing to notify.
  });
}

async function syncFirestoreLoop() {
  if (isSyncing) return;
  isSyncing = true;
  console.log("Starting Firestore sync cycle...");

  try {
    const result = await chrome.storage.local.get([
      'uid', 'sync_watermarks', 'local_intervention_events', 'work_profile', 'web_blocked_sites_list',
      'exit_behavior', 'exit_custom_url', 'exit_settings_updated_at', 'extension_score_events'
    ]);
    const uid = result.uid;
    if (!uid) {
      console.log("Sync skipped: user signed out.");
      isSyncing = false;
      return;
    }

    broadcastSyncStatus("syncing");

    const watermarks = result.sync_watermarks || {
      state: 0,
      webBlockedSites: 0,
      protocolRuns: 0,
      interventionEvents: 0
    };
    // Backfill new watermark keys on pre-existing installs (older watermark objects
    // won't have these): pull cursor + the updatedAt we last pushed for the work profile.
    if (watermarks.workProfile === undefined) watermarks.workProfile = 0;
    if (watermarks.workProfilePushedAt === undefined || watermarks.workProfilePushedAt === 0) {
      watermarks.workProfilePushedAt = (result.work_profile && result.work_profile.updatedAt) || 0;
    }
    // webBlockedSites replaces the old (broken) blockedApps-derived pull — see
    // mergeWebBlockedSites's header comment. Backfill for installs that only have the
    // legacy `blockedApps` watermark key.
    if (watermarks.webBlockedSites === undefined) watermarks.webBlockedSites = 0;
    // extensionSettings — Exit Behavior, single canonical doc (mirrors workProfile).
    if (watermarks.extensionSettings === undefined) watermarks.extensionSettings = 0;
    if (watermarks.extensionSettingsPushedAt === undefined || watermarks.extensionSettingsPushedAt === 0) {
      watermarks.extensionSettingsPushedAt = result.exit_settings_updated_at || 0;
    }

    // 1. PULL & MERGE FROM CLOUD

    // A. state collection
    const stateRecords = await queryFirestoreSubcollection(uid, "state", watermarks.state);
    if (stateRecords.length > 0) {
      await mergeState(stateRecords);
      watermarks.state = Math.max(...stateRecords.map(r => r.updatedAt));
    }

    // B. webBlockedSites collection — the phone's Extension Control screen and this
    // extension's own "Blocked Websites" UI both write here (bidirectional LWW). The
    // Android `blockedApps` collection (packageName-keyed, not a domain) is intentionally
    // never read by the extension anymore.
    const siteRecords = await queryFirestoreSubcollection(uid, "webBlockedSites", watermarks.webBlockedSites);
    if (siteRecords.length > 0) {
      await mergeWebBlockedSites(siteRecords);
      watermarks.webBlockedSites = Math.max(...siteRecords.map(r => r.updatedAt));
    }

    // C. protocolRuns collection
    const runRecords = await queryFirestoreSubcollection(uid, "protocolRuns", watermarks.protocolRuns);
    if (runRecords.length > 0) {
      await mergeProtocolRuns(runRecords);
      watermarks.protocolRuns = Math.max(...runRecords.map(r => r.updatedAt));
    }

    // D. interventionEvents collection
    const eventRecords = await queryFirestoreSubcollection(uid, "interventionEvents", watermarks.interventionEvents);
    if (eventRecords.length > 0) {
      // Re-read latest events to avoid overwriting local additions during query
      const latestRes = await chrome.storage.local.get(['local_intervention_events']);
      const localEvents = latestRes.local_intervention_events || [];
      const localMap = {};
      localEvents.forEach(e => { localMap[e.syncId] = e; });
      
      let localChanged = false;
      eventRecords.forEach(record => {
        const existing = localMap[record.syncId];
        if (!existing) {
          localEvents.push({
            syncId: record.syncId,
            updatedAt: record.updatedAt,
            deleted: record.deleted,
            synced: true,
            payload: record.payload
          });
          localChanged = true;
        }
      });
      
      if (localChanged) {
        await chrome.storage.local.set({ local_intervention_events: localEvents });
      }
      watermarks.interventionEvents = Math.max(...eventRecords.map(r => r.updatedAt));
    }

    // E. workProfile (single canonical doc at users/{uid}/workProfile/profile).
    //    LWW + anti-cheat merge via the engine: a remote device can NOT loosen a focus
    //    window that's live on this device (WorkProfileEngine.mergeRemote).
    const wpRecords = await queryFirestoreSubcollection(uid, "workProfile", watermarks.workProfile);
    if (wpRecords.length > 0) {
      const newestRemote = wpRecords.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
      const remoteProfile = { ...newestRemote.payload, updatedAt: newestRemote.updatedAt };
      
      // Re-read latest work profile right before merging to avoid overwriting local changes made since the start of the loop
      const latestWpRes = await chrome.storage.local.get(['work_profile']);
      const currentLocalWp = latestWpRes.work_profile;
      
      const merge = WorkProfileEngine.mergeRemote(currentLocalWp, remoteProfile, new Date());
      if (merge.changed) {
        await chrome.storage.local.set({ work_profile: merge.profile });
        result.work_profile = merge.profile; // reflect for the push decision below
        updateBlockerRules();
      }
      watermarks.workProfilePushedAt = Math.max(watermarks.workProfilePushedAt || 0, newestRemote.updatedAt);
      watermarks.workProfile = Math.max(...wpRecords.map(r => r.updatedAt));
    }

    // F. extensionSettings (single canonical doc at users/{uid}/extensionSettings/settings)
    //    — currently just Exit Behavior. Plain LWW: whichever side stamped the newer
    //    exit_settings_updated_at wins, same as every other single-doc setting here.
    const settingsRecords = await queryFirestoreSubcollection(uid, "extensionSettings", watermarks.extensionSettings);
    if (settingsRecords.length > 0) {
      const newestRemote = settingsRecords.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
      
      // Re-read latest settings right before merging
      const latestSettingsRes = await chrome.storage.local.get(['exit_settings_updated_at', 'exit_behavior', 'exit_custom_url']);
      const currentExitUpdatedAt = latestSettingsRes.exit_settings_updated_at || 0;
      
      if (newestRemote.updatedAt > currentExitUpdatedAt) {
        await chrome.storage.local.set({
          exit_behavior: newestRemote.payload.exitBehavior,
          exit_custom_url: newestRemote.payload.exitCustomUrl || '',
          exit_settings_updated_at: newestRemote.updatedAt
        });
        result.exit_behavior = newestRemote.payload.exitBehavior;
        result.exit_custom_url = newestRemote.payload.exitCustomUrl || '';
        result.exit_settings_updated_at = newestRemote.updatedAt;
      }
      watermarks.extensionSettingsPushedAt = Math.max(watermarks.extensionSettingsPushedAt || 0, newestRemote.updatedAt);
      watermarks.extensionSettings = Math.max(...settingsRecords.map(r => r.updatedAt));
    }

    // 2. PUSH LOCAL UNSYNCED EVENTS TO CLOUD
    // Re-read latest events before identifying unsynced ones to avoid stale reads
    const pushRes = await chrome.storage.local.get(['local_intervention_events']);
    const localEvents = pushRes.local_intervention_events || [];
    const unsynced = localEvents.filter(e => !e.synced && !e.deleted);
    
    if (unsynced.length > 0) {
      console.log(`Pushing ${unsynced.length} unsynced local events to Firestore...`);
      await pushFirestoreInterventionEvents(uid, unsynced);
      
      // Re-read latest events again right before writing, to preserve any new events recorded during network push
      const finalRes = await chrome.storage.local.get(['local_intervention_events']);
      const finalEvents = finalRes.local_intervention_events || [];
      const syncedSyncIds = new Set(unsynced.map(e => e.syncId));
      finalEvents.forEach(e => {
        if (syncedSyncIds.has(e.syncId)) {
          e.synced = true;
        }
      });
      await chrome.storage.local.set({ local_intervention_events: finalEvents });
    }

    // Push local unsynced website blocklist changes (adds AND removals — unlike
    // interventionEvents, a `deleted` row here is a real removal that must propagate to
    // the phone app / other devices, so it is NOT filtered out).
    // Re-read latest sites before identifying unsynced ones to avoid stale reads
    const pushSitesRes = await chrome.storage.local.get(['web_blocked_sites_list']);
    const localSites = pushSitesRes.web_blocked_sites_list || [];
    const unsyncedSites = localSites.filter(s => !s.synced);

    if (unsyncedSites.length > 0) {
      console.log(`Pushing ${unsyncedSites.length} unsynced website blocklist change(s) to Firestore...`);
      await pushFirestoreCollectionDocs(uid, "webBlockedSites", unsyncedSites.map(s => ({
        docId: s.syncId,
        payload: { domain: s.domain, enabled: s.enabled !== false },
        updatedAt: s.updatedAt,
        deleted: !!s.deleted
      })));

      // Re-read latest sites again right before writing, to preserve any edits made during network push
      const finalSitesRes = await chrome.storage.local.get(['web_blocked_sites_list']);
      const finalSites = finalSitesRes.web_blocked_sites_list || [];
      const syncedSiteIds = new Set(unsyncedSites.map(s => s.syncId));
      finalSites.forEach(s => {
        if (syncedSiteIds.has(s.syncId)) {
          s.synced = true;
        }
      });
      await chrome.storage.local.set({ web_blocked_sites_list: finalSites });
    }

    // Push the local work profile when it's newer than what we last pushed.
    // Re-read latest work profile right before pushing to verify it hasn't changed since start of loop
    const wpCheckRes = await chrome.storage.local.get(['work_profile']);
    const localWp = wpCheckRes.work_profile;
    if (localWp && (localWp.updatedAt || 0) > (watermarks.workProfilePushedAt || 0)) {
      console.log("Pushing local work profile to Firestore...");
      await pushFirestoreDoc(uid, "workProfile", "profile", {
        enabled: localWp.enabled === true,
        week: localWp.week || {},
        overrides: localWp.overrides || {},
        updatedAt: localWp.updatedAt || Date.now(),
        deleted: false
      });
      watermarks.workProfilePushedAt = localWp.updatedAt || Date.now();
    }

    // Push the local Exit Behavior setting when it's newer than what we last pushed.
    // Re-read latest exit behavior right before pushing
    const exitCheckRes = await chrome.storage.local.get(['exit_settings_updated_at', 'exit_behavior', 'exit_custom_url']);
    const localExitUpdatedAt = exitCheckRes.exit_settings_updated_at || 0;
    if (localExitUpdatedAt > (watermarks.extensionSettingsPushedAt || 0)) {
      console.log("Pushing local Exit Behavior setting to Firestore...");
      await pushFirestoreDoc(uid, "extensionSettings", "settings", {
        exitBehavior: exitCheckRes.exit_behavior || ExitBehaviorEngine.DEFAULT_BEHAVIOR,
        exitCustomUrl: exitCheckRes.exit_custom_url || '',
        updatedAt: localExitUpdatedAt,
        deleted: false
      });
      watermarks.extensionSettingsPushedAt = localExitUpdatedAt;
    }

    // Push unsynced Extension Score Events (Quick Focus/Work Profile/Wellbeing Tools bonus &
    // penalty shadow copies — see recordExtensionScoreEvent's header comment). Push-only, no
    // pull: the Android app is the only other reader, and it never writes one of these itself.
    // Re-read latest score events before identifying unsynced ones to avoid stale reads
    const pushScoreRes = await chrome.storage.local.get(['extension_score_events']);
    const scoreEvents = pushScoreRes.extension_score_events || [];
    const unsyncedScoreEvents = scoreEvents.filter((e) => !e.synced);
    if (unsyncedScoreEvents.length > 0) {
      console.log(`Pushing ${unsyncedScoreEvents.length} unsynced extension score event(s) to Firestore...`);
      await pushFirestoreCollectionDocs(uid, "extensionScoreEvents", unsyncedScoreEvents.map((e) => ({
        docId: e.docId,
        payload: {
          source: e.source,
          sovereigntyDelta: e.sovereigntyDelta,
          complianceDelta: e.complianceDelta,
          clarityDelta: e.clarityDelta,
          minutesUsedAfterSkip: e.minutesUsedAfterSkip,
        },
        updatedAt: e.updatedAt,
        deleted: false,
      })));
      
      // Re-read latest score events again right before writing, to preserve any new events recorded during network push
      const finalScoreRes = await chrome.storage.local.get(['extension_score_events']);
      const finalScoreEvents = finalScoreRes.extension_score_events || [];
      const syncedDocIds = new Set(unsyncedScoreEvents.map(e => e.docId));
      finalScoreEvents.forEach(e => {
        if (syncedDocIds.has(e.docId)) {
          e.synced = true;
        }
      });
      await chrome.storage.local.set({ extension_score_events: finalScoreEvents });
    }

    // Push a presence heartbeat every sync_pull tick (5 min) so the phone app can tell
    // whether the extension is installed/signed-in and alive. Separate doc from
    // extensionSettings/settings deliberately — see HeartbeatEngine.js header for why
    // sharing that doc would let heartbeat writes always win Exit-Behavior LWW races.
    await pushFirestoreDoc(uid, "extensionPresence", "heartbeat", HeartbeatEngine.buildHeartbeatPayload(Date.now()));

    // 3. SAVE WATERMARKS & RECALCULATE
    await chrome.storage.local.set({ sync_watermarks: watermarks });
    await recalculateScores();
    console.log("Firestore sync completed successfully.");
    await chrome.storage.local.set({ last_synced_at: Date.now() });
    broadcastSyncStatus("synced");

  } catch (error) {
    console.error("Firestore sync cycle failed:", error);
    broadcastSyncStatus("failed");
  } finally {
    isSyncing = false;
  }
}


// ── QUICK FOCUS SESSION ENGINE ──

// Renamed from isEntitledToQuickFocus — shared by any Extension-Pro-gated feature (Quick
// Focus, Work Profile, and now the Eye Rest wellbeing reminder; Water Break is Free tier
// and never calls this).
async function isEntitledToExtensionPro() {
  const result = await chrome.storage.local.get(['subscriptionTier']);
  return result.subscriptionTier === 'extension_pro' || result.subscriptionTier === 'full_pro';
}

// Ends a Quick Focus session — called by the one-shot `quick_focus_end` alarm, or
// defensively at startup if the worker was asleep past `endsAt` and missed it. Awards
// bonus Sovereignty only if the session actually reached its endsAt
// (QuickFocusEngine.completeSession never pays out on an early/duplicate call). A
// completion's points are appended to `quick_focus_reward_history` — recalculateScores()
// folds that history into the live Sovereignty number (Phase 3 — see its own comment for
// why this is an extension-only post-adjustment rather than a change to the mirrored
// LifeScoreCalculator itself).
async function completeQuickFocusSession() {
  const result = await chrome.storage.local.get(['quick_focus_session', 'quick_focus_reward_history']);
  const session = result.quick_focus_session;
  if (!session || session.completed) return;

  const { session: completed, awardedPoints } = QuickFocusEngine.completeSession(session, new Date());
  const updates = { quick_focus_session: completed };
  if (awardedPoints > 0) {
    const history = result.quick_focus_reward_history || [];
    history.push({ timestamp: Date.now(), points: awardedPoints });
    updates.quick_focus_reward_history = history;
    await recordExtensionScoreEvent('quick_focus_reward', { sovereigntyDelta: awardedPoints });
  }
  await chrome.storage.local.set(updates);
  console.log(`Quick Focus session ended (scope=${session.scope}). Bonus points computed: ${awardedPoints}.`);
  await updateBlockerRules();
  await recalculateScores();
}

// ── QUICK FOCUS SKIP PASS (early-exit economy) ──
// The founder's explicit design: a live Quick Focus session is never an absolute wall —
// it can always be ended early, either by spending a Skip Pass (3 free/month + a
// purchasable top-up, mirroring the Android Deep Lock Skip Pass) or, once passes run out,
// by accepting an adaptive score penalty instead (QuickFocusSkipEngine.aggregatePenalties).
// See QuickFocusSkipEngine.js for the full algorithm rationale.

// One-hour, 1-minute-granularity poll of whatever domain the active/focused tab is on,
// started right after an UNPAID skip. Coarse by design (matches the existing wp_tick
// polling style in this file) rather than a live per-second tab-activity tracker — good
// enough to separate "glanced at a blocked site for a minute" from "binged for 45".
async function startSkipUsageObservation(skipTimestamp, blocklistSnapshot) {
  await chrome.storage.local.set({
    quick_focus_skip_observation: {
      skipTimestamp,
      blocklistSnapshot: blocklistSnapshot || [],
      accruedMinutes: 0,
      ticksRemaining: QuickFocusSkipEngine.USAGE_CAP_MINUTES
    }
  });
  chrome.alarms.create("quick_focus_skip_observe_tick", { periodInMinutes: 1 });
}

async function tickSkipUsageObservation() {
  const result = await chrome.storage.local.get(['quick_focus_skip_observation', 'quick_focus_skip_history']);
  const obs = result.quick_focus_skip_observation;
  if (!obs) {
    chrome.alarms.clear("quick_focus_skip_observe_tick");
    return;
  }

  let onBlockedDomain = false;
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const activeUrl = tabs[0] && tabs[0].url;
    const activeDomain = activeUrl ? WorkProfileEngine.normalizeDomain(activeUrl) : null;
    onBlockedDomain = !!activeDomain && obs.blocklistSnapshot.some(d => WorkProfileEngine.normalizeDomain(d) === activeDomain);
  } catch (error) {
    console.error("Skip-usage observation tick failed to read the active tab:", error);
  }

  const accruedMinutes = obs.accruedMinutes + (onBlockedDomain ? 1 : 0);
  const ticksRemaining = obs.ticksRemaining - 1;

  if (ticksRemaining <= 0) {
    chrome.alarms.clear("quick_focus_skip_observe_tick");
    const history = result.quick_focus_skip_history || [];
    const idx = history.findIndex(h => h.timestamp === obs.skipTimestamp);
    if (idx !== -1) history[idx].minutesUsedAfterSkip = accruedMinutes;
    await chrome.storage.local.set({ quick_focus_skip_history: history, quick_focus_skip_observation: null });
    // Same stable docId as the provisional push in CANCEL_QUICK_FOCUS — this overwrites it
    // with the real minutesUsedAfterSkip now that observation has finished.
    await recordExtensionScoreEvent('quick_focus_skip', { minutesUsedAfterSkip: accruedMinutes }, `qfskip_${obs.skipTimestamp}`);
    console.log(`Skip-usage observation finished: ${accruedMinutes} min on a blocked domain after the skip.`);
    await recalculateScores(); // the provisional (floor-severity) penalty is now the real one
  } else {
    await chrome.storage.local.set({
      quick_focus_skip_observation: Object.assign({}, obs, { accruedMinutes, ticksRemaining })
    });
  }
}

// ── PHASE 4: WEB ENTITLEMENT + CHECKOUT ──
// Mirrors the Android app's existing Cloudflare Worker + Firestore bridge exactly (same
// backend, second client — see WebEntitlementEngine.js header + BACKEND_HANDOFF.md §7
// Phase 4). Requires sign-in first (founder decision): checkout is only reachable once
// `uid` exists in storage, so a purchase can always be matched to an account afterward.

let checkoutTabTracking = null; // { tabId, productId, startedAt } while a checkout tab is open

// Re-check entitlement against the Worker and apply the result to `subscriptionTier`.
// Debounced per WebEntitlementEngine.shouldCheck EXCEPT for explicit triggers (sign-in,
// manual refresh, checkout tab closing), which always run regardless of the last check.
// Re-checks entitlement. `/api/entitlement/link` is still called first — it's the only thing
// that makes the Worker reconcile a Dodo web purchase (email-keyed at purchase time) into the
// canonical `users/{uid}/private/entitlement` doc (see gylb-astro's linker.ts). But the actual
// subscriptionTier stored here now comes from READING that canonical doc directly via
// getEntitlementDoc() — the same doc the Android app and any future client read — rather than
// trusting `/link`'s own response body as the gating source. Falls back to `/link`'s response
// only if the Firestore doc read itself fails (network hiccup, App Check hiccup), so a purely
// transient read error doesn't regress the whole check.
async function checkWebEntitlement(reason) {
  const result = await chrome.storage.local.get(['uid', 'entitlement_checked_at']);
  if (!result.uid) return; // not signed in — nothing to check, extension stays on 'free'
  const uid = result.uid;

  const now = Date.now();
  if (!WebEntitlementEngine.shouldCheck(reason, result.entitlement_checked_at, now)) return;

  const idToken = await getValidIdToken();
  if (!idToken) return;

  let linkResponseData = null;
  try {
    const response = await fetch(WebEntitlementEngine.linkRequestUrl(), {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${idToken}` }
    });
    linkResponseData = await response.json();
    if (!response.ok) {
      console.error(`Entitlement link failed (${reason}):`, linkResponseData.error || response.status);
    }
  } catch (error) {
    console.error(`Entitlement link (${reason}) request failed:`, error);
  }

  let applied;
  try {
    const doc = await getEntitlementDoc(uid);
    applied = WebEntitlementEngine.applyEntitlementDoc(doc, now);
  } catch (error) {
    console.error(`Entitlement doc read (${reason}) failed, falling back to /link response:`, error);
    applied = WebEntitlementEngine.applyEntitlementResponse(linkResponseData);
  }

  await chrome.storage.local.set({
    subscriptionTier: applied.subscriptionTier,
    entitlement_expires_at: applied.expiresAt,
    entitlement_subscription_id: applied.subscriptionId,
    entitlement_checked_at: now
  });
  console.log(`Entitlement check (${reason}): ${applied.subscriptionTier}`);
  chrome.runtime.sendMessage({ action: "ENTITLEMENT_UPDATED", subscriptionTier: applied.subscriptionTier }).catch(() => {});
}

// Start a checkout session for `productId` and open it in a new tab. The current active
// tab (and its content) is left alone — the popup already closes on its own the instant a
// new tab steals focus (same unavoidable MV3 behavior as the Google sign-in flow), so a
// second tab vs. redirecting the current one doesn't cost anything extra here.
async function startCheckout(productId) {
  const result = await chrome.storage.local.get(['uid', 'authEmail']);
  if (!result.uid || !result.authEmail) {
    return { success: false, reason: 'sign_in_required' };
  }

  try {
    const response = await fetch(WebEntitlementEngine.checkoutRequestUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(WebEntitlementEngine.checkoutRequestBody(result.authEmail, productId))
    });
    const data = await response.json();
    if (!response.ok || !WebEntitlementEngine.isValidCheckoutResponse(data)) {
      return { success: false, reason: (data && data.error) || 'Checkout session could not be created.' };
    }

    const tab = await chrome.tabs.create({ url: data.url });
    checkoutTabTracking = { tabId: tab.id, productId, startedAt: Date.now() };
    return { success: true };
  } catch (error) {
    console.error('Checkout request failed:', error);
    return { success: false, reason: 'Could not reach checkout — check your connection and try again.' };
  }
}

// When the checkout tab closes (paid, cancelled, or just closed), re-check entitlement
// immediately — don't wait for the next foreground/periodic cycle. Works regardless of
// what page Dodo's return_url actually lands on, since it keys off the tab closing, not
// its content.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (checkoutTabTracking && checkoutTabTracking.tabId === tabId) {
    checkoutTabTracking = null;
    checkWebEntitlement(WebEntitlementEngine.REASON_CHECKOUT_RETURN).catch(err =>
      console.error("Post-checkout entitlement check failed:", err));
  }
});

// ── EXIT BEHAVIOR (block screen "Exit" button) ──
// The block screen's Exit button used to call window.close() (silently fails for any tab
// the user didn't open via script — i.e. almost always) and fall through to a hardcoded
// redirect to google.com. Now the user picks a real preference in the popup's Settings
// section, and this executes it via chrome.tabs (which works regardless of how the tab
// was opened, unlike the page's own window.close()). ExitBehaviorEngine.resolveExitAction
// owns the decision logic; this is just the chrome.tabs glue.
async function applyExitBehavior(tabId) {
  const result = await chrome.storage.local.get(['exit_behavior', 'exit_custom_url']);
  const action = ExitBehaviorEngine.resolveExitAction({
    exitBehavior: result.exit_behavior,
    customUrl: result.exit_custom_url
  });

  if (action.type === ExitBehaviorEngine.ACTION_NAVIGATE) {
    // If a Work Profile FOCUS window / Quick Focus session is currently only allowing a
    // specific whitelist and the user's chosen redirect site isn't on it, navigating there
    // would just get redirect-looped straight back to this block screen. Setup pre-seeds
    // the redirect site into a new FOCUS window's allowlist by default (see
    // handleAddWpWindow/openQuickFocusView in popup.js) so this is the user's choice, not a
    // trap — but if they removed it, fall back to a fresh tab instead of looping. Once the
    // window/session ends, the site is no longer blocked and this check stops firing, so
    // the configured redirect resumes automatically.
    const decision = await computeCurrentBlockDecision();
    if (isDomainBlockedByDecision(action.url, decision)) {
      await closeAndOpenNewTab(tabId);
      return;
    }
    await chrome.tabs.update(tabId, { url: action.url });
    return;
  }

  if (action.type === ExitBehaviorEngine.ACTION_BACK_HISTORY) {
    try {
      await chrome.tabs.goBack(tabId);
    } catch (error) {
      // No history to go back to (e.g. this was the first navigation in the tab).
      await closeAndOpenNewTab(tabId);
    }
    return;
  }

  await closeAndOpenNewTab(tabId);
}

// Opens a fresh tab in the SAME window first, then closes the block-screen tab — so the
// user is never left with zero tabs (which would close the whole window) even if this was
// the only tab open.
async function closeAndOpenNewTab(tabId) {
  let windowId;
  try {
    const tab = await chrome.tabs.get(tabId);
    windowId = tab.windowId;
  } catch (error) {
    // Tab may already be gone; fall through and create in the last-focused window.
  }
  await chrome.tabs.create(windowId !== undefined ? { windowId } : {});
  try {
    await chrome.tabs.remove(tabId);
  } catch (error) {
    // Already closed — nothing left to do.
  }
}

// ── MESSAGE LISTENER ──
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  
  // Whitelist/Bypass action from block screen
  if (request.action === "whitelist_domain") {
    const { domain, minutes, url } = request;
    const cleanDomain = domain.trim().toLowerCase();
    const expiration = Date.now() + minutes * 60 * 1000;
    
    chrome.storage.local.get(['whitelisted_domains'], (result) => {
      const whitelisted = result.whitelisted_domains || {};
      whitelisted[cleanDomain] = expiration;
      
      chrome.storage.local.set({ whitelisted_domains: whitelisted }, () => {
        chrome.alarms.create(`whitelist_${cleanDomain}`, { delayInMinutes: minutes });
        console.log(`Registered temporary whitelist for "${cleanDomain}" for ${minutes} minutes.`);
        updateBlockerRules();
        
        // Log the BYPASS event in database and sync
        recordInterventionEvent('BYPASS', cleanDomain, minutes, false).then(() => {
          if (sender.tab && sender.tab.id && url) {
            chrome.tabs.update(sender.tab.id, { url: url });
          }
          sendResponse({ success: true });
        }).catch(err => {
          console.error("Failed to log BYPASS:", err);
          sendResponse({ success: false, error: err.message });
        });
      });
    });
    return true; // Keep message channel open for async response
  }

  // Comply action from block screen
  if (request.action === "comply_domain") {
    const { domain, isScheduledWindow } = request;
    const cleanDomain = (domain || '').trim().toLowerCase();
    const tabId = sender.tab && sender.tab.id;
    recordInterventionEvent('COMPLY', cleanDomain, null, isScheduledWindow || false).then(() => {
      if (tabId) applyExitBehavior(tabId).catch(err => console.error("Failed to apply exit behavior:", err));
      sendResponse({ success: true });
    }).catch(err => {
      console.error("Failed to log COMPLY:", err);
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // Self block commitment from block screen or popup
  if (request.action === "self_block_domain") {
    const { domain, minutes } = request;
    const cleanDomain = (domain || '').trim().toLowerCase();
    recordInterventionEvent('SELF_BLOCK', cleanDomain, minutes, false).then(() => {
      sendResponse({ success: true });
    }).catch(err => {
      console.error("Failed to log SELF_BLOCK:", err);
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // Manual pull sync trigger from popup
  if (request.action === "SYNC_PULL") {
    syncFirestoreLoop().then(() => {
      sendResponse({ success: true });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // Authentication Status Check
  if (request.action === "CHECK_AUTH") {
    chrome.storage.local.get(['uid', 'idToken'], (result) => {
      if (result.uid && result.idToken) {
        sendResponse({ authenticated: true, uid: result.uid });
      } else {
        sendResponse({ authenticated: false });
      }
    });
    return true;
  }

  // Perform Sign In
  if (request.action === "SIGN_IN") {
    signIn(request.email, request.password)
      .then(res => {
        // Trigger initial sync in background
        syncFirestoreLoop().catch(err => console.error("Initial sync failed:", err));
        checkWebEntitlement(WebEntitlementEngine.REASON_SIGN_IN).catch(err => console.error("Entitlement check failed:", err));
        sendResponse({ success: true, uid: res.uid });
      })
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Perform Sign Up (create a brand-new account) — same post-auth flow as Sign In.
  if (request.action === "SIGN_UP") {
    signUp(request.email, request.password)
      .then(res => {
        syncFirestoreLoop().catch(err => console.error("Initial sync failed:", err));
        checkWebEntitlement(WebEntitlementEngine.REASON_SIGN_IN).catch(err => console.error("Entitlement check failed:", err));
        sendResponse({ success: true, uid: res.uid });
      })
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Send a fresh 6-digit email-verification code to the signed-in user's own address
  // (see gylb-astro's /api/otp/request — the ID token, not any client-supplied email,
  // determines who receives it).
  if (request.action === "REQUEST_OTP_CODE") {
    (async () => {
      const idToken = await getValidIdToken();
      if (!idToken) {
        sendResponse({ success: false, reason: "Not signed in." });
        return;
      }
      try {
        const response = await fetch(`${WebEntitlementEngine.WEB_ENTITLEMENT_BASE_URL}/api/otp/request`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${idToken}` }
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          sendResponse({ success: false, reason: data.error || 'Could not send verification code.' });
          return;
        }
        sendResponse({ success: true });
      } catch (error) {
        console.error("OTP request failed:", error);
        sendResponse({ success: false, reason: 'Could not reach the server. Check your connection and try again.' });
      }
    })();
    return true;
  }

  // Verify a submitted 6-digit code. On success, refreshes the locally-cached
  // emailVerified flag so the Profile screen's "Verify your email" row disappears
  // immediately without needing to reopen the popup.
  if (request.action === "VERIFY_OTP_CODE") {
    (async () => {
      const { code } = request;
      const idToken = await getValidIdToken();
      if (!idToken) {
        sendResponse({ success: false, reason: "Not signed in." });
        return;
      }
      try {
        const response = await fetch(`${WebEntitlementEngine.WEB_ENTITLEMENT_BASE_URL}/api/otp/verify`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${idToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ code })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          sendResponse({ success: false, reason: data.error || 'Could not verify code.' });
          return;
        }
        const emailVerified = await fetchEmailVerified(idToken);
        await chrome.storage.local.set({ emailVerified });
        sendResponse({ success: true });
      } catch (error) {
        console.error("OTP verify failed:", error);
        sendResponse({ success: false, reason: 'Could not reach the server. Check your connection and try again.' });
      }
    })();
    return true;
  }

  // Perform Google Sign In
  if (request.action === "SIGN_IN_GOOGLE") {
    signInWithGoogle()
      .then(res => {
        // Trigger initial sync in background
        syncFirestoreLoop().catch(err => console.error("Initial sync failed:", err));
        checkWebEntitlement(WebEntitlementEngine.REASON_SIGN_IN).catch(err => console.error("Entitlement check failed:", err));
        sendResponse({ success: true, uid: res.uid });
      })
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Perform Sign Out
  if (request.action === "SIGN_OUT") {
    signOut().then(() => sendResponse({ success: true }));
    return true;
  }

  // Update Blocker Rules (Triggered on manually blocking domains)
  if (request.action === "UPDATE_BLOCKLIST") {
    updateBlockerRules().then(() => sendResponse({ success: true }));
    return true;
  }

  // A domain was added/removed via the popup's own "Blocked Websites" UI
  // (handleAddDomain/handleRemoveDomain in popup.js). Records the change in the synced
  // website-blocklist mirror (marked unsynced) so the next Firestore sync pass pushes it
  // up — this is the extension-side half of the bidirectional sync with the phone app's
  // Extension Control screen (mergeWebBlockedSites handles the pull side).
  if (request.action === "SYNC_WEB_SITE_CHANGE") {
    const { domain, deleted } = request;
    (async () => {
      const result = await chrome.storage.local.get(['web_blocked_sites_list', 'uid']);
      const list = result.web_blocked_sites_list || [];
      const idx = list.findIndex(item => item.domain === domain);
      const now = Date.now();

      if (idx !== -1) {
        list[idx] = { ...list[idx], enabled: !deleted, deleted: !!deleted, updatedAt: now, synced: false };
      } else {
        list.push({
          syncId: generateSyncId(),
          domain,
          enabled: !deleted,
          deleted: !!deleted,
          updatedAt: now,
          synced: false
        });
      }

      await chrome.storage.local.set({ web_blocked_sites_list: list });
      if (result.uid) {
        syncFirestoreLoop().catch(err => console.error("Website blocklist sync failed:", err));
      }
      sendResponse({ success: true });
    })();
    return true;
  }

  // Save the Work Profile. Anti-cheat gated: while a Focus window is live the plan can
  // only be made stricter (WorkProfileEngine.validateEdit). Stamps updatedAt so the
  // profile is Firestore last-write-wins ready when the sync collection lands.
  if (request.action === "SET_WORK_PROFILE") {
    chrome.storage.local.get(['work_profile'], (result) => {
      const current = result.work_profile || { enabled: false, week: {}, overrides: {} };
      const proposed = request.profile || { enabled: false, week: {}, overrides: {} };
      const check = WorkProfileEngine.validateEdit(current, proposed, new Date());
      if (!check.allowed) {
        sendResponse({ success: false, reason: check.reason });
        return;
      }
      proposed.updatedAt = Date.now();
      chrome.storage.local.set({ work_profile: proposed }, () => {
        updateBlockerRules();
        // Push to Firestore right away instead of waiting for the 5-minute sync_pull
        // alarm — every other synced setting (website blocklist, exit behavior) already
        // does this; Work Profile was the one write path that didn't, so a save could sit
        // unsynced for up to 5 minutes.
        chrome.storage.local.get(['uid'], ({ uid }) => {
          if (uid) syncFirestoreLoop().catch(err => console.error("Work Profile sync failed:", err));
        });
        sendResponse({ success: true });
      });
    });
    return true;
  }

  // Wellbeing Tools — popup reads current config for the subview.
  if (request.action === "GET_WELLBEING_CONFIG") {
    getWellbeingConfig().then((config) => sendResponse({ success: true, config }));
    return true;
  }

  // Wellbeing Tools — save one reminder's settings (enabled/mode/interval). Water Break is
  // Free tier; Eye Rest requires Extension Pro, enforced here (not just hidden in the UI)
  // so a direct message can't bypass the paywall.
  if (request.action === "SET_WELLBEING_CONFIG") {
    (async () => {
      const { target, enabled, mode, intervalMinutes, lastFiredAt } = request;
      if (target !== 'eyeRest' && target !== 'waterBreak') {
        sendResponse({ success: false, reason: 'Unknown Wellbeing Tools reminder.' });
        return;
      }
      if (mode !== WellbeingRemindersEngine.MODE_NOTIFICATION && mode !== WellbeingRemindersEngine.MODE_PAUSE_SCREEN) {
        sendResponse({ success: false, reason: 'Unrecognized reminder mode.' });
        return;
      }
      if (target === 'eyeRest' && enabled && !(await isEntitledToExtensionPro())) {
        sendResponse({ success: false, reason: 'The 20-20-20 eye rest reminder is an Extension Pro feature.' });
        return;
      }

      const config = await getWellbeingConfig();
      config[target].enabled = !!enabled;
      config[target].mode = mode;
      if (lastFiredAt !== undefined) {
        config[target].lastFiredAt = lastFiredAt;
      }
      if (target === 'waterBreak') {
        config.waterBreak.intervalMinutes = WellbeingRemindersEngine.clampWaterInterval(intervalMinutes);
      }
      await chrome.storage.local.set({ wellbeing_tools: config });
      sendResponse({ success: true, config });
    })();
    return true;
  }

  // Sent by wellbeing_break.js when the user finishes the pause-screen flow (the 20s eye
  // rest hold elapses, or they tap "Done" on the water break) — awards points, then returns
  // the tab to whatever it was showing before, same as the block screen's Exit behavior.
  if (request.action === "WELLBEING_REMINDER_DONE") {
    (async () => {
      const type = request.wellbeingType;
      if (type !== WellbeingRemindersEngine.TYPE_EYE_REST && type !== WellbeingRemindersEngine.TYPE_WATER_BREAK) {
        sendResponse({ success: false });
        return;
      }
      await completeWellbeingReminder(type);
      const tabId = sender.tab && sender.tab.id;
      if (tabId != null) {
        try {
          await chrome.tabs.goBack(tabId);
        } catch (error) {
          await closeAndOpenNewTab(tabId);
        }
      }
      sendResponse({ success: true });
    })();
    return true;
  }

  // Save the block-screen Exit behavior setting (Settings section on the main dashboard,
  // or the phone app's Extension Control screen once its edit reaches here via sync).
  // Validated against ExitBehaviorEngine so a corrupted/unexpected value can never get
  // written and silently break the exit flow. Stamps exit_settings_updated_at so this
  // setting can be pushed/merged LWW against the phone app the same way every other
  // synced setting is (see the extensionSettings pull/push in syncFirestoreLoop).
  if (request.action === "SET_EXIT_BEHAVIOR") {
    const { exitBehavior, customUrl } = request;
    if (!ExitBehaviorEngine.isValidBehavior(exitBehavior)) {
      sendResponse({ success: false, reason: 'Unrecognized exit behavior.' });
      return true;
    }
    chrome.storage.local.set({
      exit_behavior: exitBehavior,
      exit_custom_url: customUrl || '',
      exit_settings_updated_at: Date.now()
    }, () => {
      chrome.storage.local.get(['uid'], (result) => {
        if (result.uid) syncFirestoreLoop().catch(err => console.error("Exit behavior sync failed:", err));
      });
      sendResponse({ success: true });
    });
    return true;
  }

  // Start a Dodo checkout session for the given product id. Requires sign-in (founder
  // decision — a purchase must always be matchable to an account). Opens the checkout in
  // a new tab; entitlement is re-checked automatically once that tab closes.
  if (request.action === "START_CHECKOUT") {
    startCheckout(request.productId).then(result => sendResponse(result));
    return true;
  }

  // Manual "refresh my Pro status" — always bypasses the debounce.
  if (request.action === "CHECK_ENTITLEMENT") {
    checkWebEntitlement(WebEntitlementEngine.REASON_MANUAL).then(() => {
      chrome.storage.local.get(['subscriptionTier'], (result) => {
        sendResponse({ success: true, subscriptionTier: result.subscriptionTier || 'free' });
      });
    }).catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Start a Quick Focus hard-block session. Extension Pro gated. Anti-cheat: rejects if a
  // session is already running (QuickFocusEngine.startSession) — no restarting/overwriting
  // a live hard-block. Schedules the one-shot `quick_focus_end` alarm that ends it.
  if (request.action === "START_QUICK_FOCUS") {
    (async () => {
      const { scope, durationMinutes, whitelist } = request;
      const entitled = await isEntitledToExtensionPro();
      if (!entitled) {
        sendResponse({ success: false, reason: 'Quick Focus is an Extension Pro feature.' });
        return;
      }
      const result = await chrome.storage.local.get(['quick_focus_session']);
      const outcome = QuickFocusEngine.startSession(
        result.quick_focus_session,
        { scope, durationMinutes, whitelist },
        new Date()
      );
      if (!outcome.ok) {
        sendResponse({ success: false, reason: outcome.reason });
        return;
      }
      await chrome.storage.local.set({ quick_focus_session: outcome.session });
      chrome.alarms.create("quick_focus_end", { delayInMinutes: outcome.session.durationMinutes });
      await updateBlockerRules();
      sendResponse({ success: true, session: outcome.session });
    })();
    return true;
  }

  // Read the current Quick Focus session status (for the popup to render a countdown).
  if (request.action === "GET_QUICK_FOCUS_STATUS") {
    chrome.storage.local.get(['quick_focus_session'], (result) => {
      const session = result.quick_focus_session || null;
      const now = new Date();
      sendResponse({
        active: QuickFocusEngine.isActive(session, now),
        session,
        remainingMs: QuickFocusEngine.remainingMs(session, now)
      });
    });
    return true;
  }

  // Read the Skip Pass balance (for the popup to show "2 of 3 passes left this month").
  if (request.action === "GET_SKIP_PASS_STATUS") {
    chrome.storage.local.get(['quick_focus_skip_balance'], (result) => {
      const balance = QuickFocusSkipEngine.rollBalance(result.quick_focus_skip_balance || null, new Date());
      sendResponse({
        passesAvailable: QuickFocusSkipEngine.passesAvailable(balance),
        freeRemaining: QuickFocusSkipEngine.freeRemaining(balance),
        notice: QuickFocusSkipEngine.EMERGENCY_ONLY_NOTICE
      });
    });
    return true;
  }

  // End a live Quick Focus session early. ALWAYS lets the user out — there is no absolute
  // hard lock — but it is never free: spend a Skip Pass (free monthly allowance first,
  // then a purchased top-up) or accept the adaptive score-reducer penalty instead
  // (QuickFocusSkipEngine.aggregatePenalties). request.useSkipPass defaults to true.
  if (request.action === "CANCEL_QUICK_FOCUS") {
    (async () => {
      const { useSkipPass = true, buyMorePasses = false } = request;
      const result = await chrome.storage.local.get([
        'quick_focus_session', 'quick_focus_skip_balance', 'quick_focus_skip_history', 'blocked_domains'
      ]);
      const now = new Date();
      const session = result.quick_focus_session;
      if (!QuickFocusEngine.isActive(session, now)) {
        sendResponse({ success: false, reason: 'No Quick Focus session is running.' });
        return;
      }

      const rolledBalance = QuickFocusSkipEngine.rollBalance(result.quick_focus_skip_balance || null, now);

      if (useSkipPass && QuickFocusSkipEngine.passesAvailable(rolledBalance) > 0) {
        const spend = QuickFocusSkipEngine.spendPass(rolledBalance, now);
        const { session: ended } = QuickFocusEngine.forfeitSession(session, now);
        await chrome.storage.local.set({ quick_focus_session: ended, quick_focus_skip_balance: spend.balance });
        await updateBlockerRules();
        sendResponse({
          success: true,
          method: 'pass',
          passesRemaining: QuickFocusSkipEngine.passesAvailable(spend.balance),
          notice: QuickFocusSkipEngine.EMERGENCY_ONLY_NOTICE
        });
        return;
      }

      if (useSkipPass && QuickFocusSkipEngine.passesAvailable(rolledBalance) <= 0 && buyMorePasses) {
        // Phase 4 territory — Dodo checkout URL format not decided yet (BACKEND_HANDOFF.md §7/§8).
        sendResponse({ success: false, reason: 'Buying extra Skip Passes isn’t wired up yet.' });
        return;
      }

      // No pass spent: end the session anyway, but log an unpaid skip for the adaptive
      // score-reducer penalty and start observing post-skip usage.
      const { session: ended, minutesRemaining } = QuickFocusEngine.forfeitSession(session, now);
      const history = result.quick_focus_skip_history || [];
      history.push({ timestamp: now.getTime(), minutesRemaining, minutesUsedAfterSkip: null });

      await chrome.storage.local.set({
        quick_focus_session: ended,
        quick_focus_skip_balance: rolledBalance,
        quick_focus_skip_history: history
      });
      // Stable docId keyed by the skip's own timestamp — tickSkipUsageObservation's finalize
      // step (below) re-records under the SAME id once minutesUsedAfterSkip is known, which
      // overwrites this provisional push in Firestore rather than creating a duplicate event.
      await recordExtensionScoreEvent('quick_focus_skip', { minutesUsedAfterSkip: null }, `qfskip_${now.getTime()}`);
      await startSkipUsageObservation(now.getTime(), result.blocked_domains || []);
      await updateBlockerRules();
      await recalculateScores(); // provisional penalty (floor severity) counts immediately
      sendResponse({ success: true, method: 'penalty', notice: QuickFocusSkipEngine.EMERGENCY_ONLY_NOTICE });
    })();
    return true;
  }

  // Store reCAPTCHA Token & Exchange
  if (request.action === "SET_RECAPTCHA_TOKEN") {
    exchangeAppCheckToken(request.token)
      .then(token => sendResponse({ success: true, appCheckToken: token }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// ── ALARMS ENGINE ──
chrome.alarms.onAlarm.addListener((alarm) => {
  console.log(`Alarm triggered: ${alarm.name}`);
  
  if (alarm.name.startsWith("whitelist_")) {
    const domain = alarm.name.replace("whitelist_", "");
    chrome.storage.local.get(['whitelisted_domains'], (result) => {
      const whitelisted = result.whitelisted_domains || {};
      delete whitelisted[domain];
      
      chrome.storage.local.set({ whitelisted_domains: whitelisted }, () => {
        console.log(`Bypass elapsed: re-blocking "${domain}".`);
        updateBlockerRules();
      });
    });
  } else if (alarm.name.startsWith("block_")) {
    const domain = alarm.name.replace("block_", "");
    chrome.storage.local.get(['active_blocks'], (result) => {
      const activeBlocks = result.active_blocks || {};
      delete activeBlocks[domain];
      
      chrome.storage.local.set({ active_blocks: activeBlocks }, () => {
        console.log(`Lock countdown elapsed: clearing strict block on "${domain}".`);
        updateBlockerRules();
      });
    });
  } else if (alarm.name === "quick_focus_end") {
    completeQuickFocusSession().catch(err => console.error("Failed to complete Quick Focus session:", err));
  } else if (alarm.name === "quick_focus_skip_observe_tick") {
    tickSkipUsageObservation().catch(err => console.error("Skip-usage observation tick failed:", err));
  } else if (alarm.name === "wp_tick") {
    // Re-evaluate the Work Profile every minute so a window's start/end boundary takes
    // effect on time — DNR rules are static once written, so nothing changes them until
    // we recompute. Cheap: it's one storage read + a rule diff.
    updateBlockerRules();
    // Phase 3b: notice any FOCUS window that just completed (see the function's own note).
    checkWorkProfileFocusCompletions().catch(err => console.error("Work Profile completion check failed:", err));
  } else if (alarm.name === "sync_pull") {
    syncFirestoreLoop().catch(err => console.error("Alarm sync failed:", err));
    // Piggyback the entitlement re-check on the same 5-minute cadence Android calls
    // "foreground" (debounced — see WebEntitlementEngine.shouldCheck).
    checkWebEntitlement(WebEntitlementEngine.REASON_FOREGROUND).catch(err => console.error("Entitlement check failed:", err));
  } else if (alarm.name === "wellbeing_tick") {
    // Same "re-evaluate every minute" idiom as wp_tick — checking both reminders' own
    // shouldFire() math every tick means changing Water Break's interval takes effect
    // immediately, with no per-type alarm to re-arm.
    checkWellbeingReminders().catch(err => console.error("Wellbeing reminders tick failed:", err));
  }
});

// ── INITIALIZER ──
async function initializeBlocker() {
  chrome.storage.local.get(['blocked_domains', 'whitelisted_domains', 'active_blocks'], (result) => {
    const domains = result.blocked_domains || ["youtube.com", "instagram.com", "twitter.com"];
    const whitelisted = result.whitelisted_domains || {};
    const activeBlocks = result.active_blocks || {};
    const now = Date.now();
    
    let updated = false;
    
    // Ensure default domains list
    if (!result.blocked_domains) {
      chrome.storage.local.set({ blocked_domains: domains });
      updated = true;
    }
    
    // Clean up expired whitelists
    for (const [dom, exp] of Object.entries(whitelisted)) {
      if (exp <= now) {
        delete whitelisted[dom];
        updated = true;
      } else {
        const remainingMin = (exp - now) / 60000;
        chrome.alarms.create(`whitelist_${dom}`, { delayInMinutes: remainingMin });
      }
    }
    
    // Clean up expired strict blocks
    for (const [dom, exp] of Object.entries(activeBlocks)) {
      if (exp <= now) {
        delete activeBlocks[dom];
        updated = true;
      } else {
        const remainingMin = (exp - now) / 60000;
        chrome.alarms.create(`block_${dom}`, { delayInMinutes: remainingMin });
      }
    }
    
    if (updated) {
      chrome.storage.local.set({ 
        whitelisted_domains: whitelisted,
        active_blocks: activeBlocks
      }, () => {
        updateBlockerRules();
      });
    } else {
      updateBlockerRules();
    }
  });

  // Create periodic alarm for sync (every 5 minutes)
  chrome.alarms.create("sync_pull", { periodInMinutes: 5 });

  // Re-evaluate the Work Profile schedule every minute (window start/end boundaries).
  chrome.alarms.create("wp_tick", { periodInMinutes: 1 });

  // Check both Wellbeing Tools reminders (Eye Rest / Water Break) every minute.
  chrome.alarms.create("wellbeing_tick", { periodInMinutes: 1 });

  // Reconcile any Quick Focus session across a worker restart: if it's still running,
  // re-arm the end alarm for the remaining time (MV3 alarms don't survive an uninstall of
  // the alarm itself, only the worker sleeping); if it already ran past endsAt while the
  // worker was asleep, complete it now so bonus points aren't lost.
  chrome.storage.local.get(['quick_focus_session'], (result) => {
    const session = result.quick_focus_session;
    if (!session || session.completed) return;
    const now = new Date();
    if (QuickFocusEngine.isActive(session, now)) {
      const remainingMin = QuickFocusEngine.remainingMs(session, now) / 60000;
      chrome.alarms.create("quick_focus_end", { delayInMinutes: remainingMin });
    } else {
      completeQuickFocusSession().catch(err => console.error("Failed to complete stale Quick Focus session:", err));
    }
  });

  // Same reconciliation for a Skip Pass usage observation in progress: re-arm the tick
  // alarm (extension updates/reinstalls can drop alarms even though the worker's own
  // sleep/wake cycle wouldn't).
  chrome.storage.local.get(['quick_focus_skip_observation'], (result) => {
    if (result.quick_focus_skip_observation) {
      chrome.alarms.create("quick_focus_skip_observe_tick", { periodInMinutes: 1 });
    }
  });

  // Initial local recalculation and cloud sync
  recalculateScores().then(() => {
    syncFirestoreLoop().catch(err => console.error("Startup sync failed:", err));
  });

  // Attempt token refresh on startup if user is logged in
  getValidIdToken().then(token => {
    if (token) {
      console.log("Session validated on worker startup.");
    }
  });

  // Worker startup is the closest extension-equivalent to Android's "app foreground"
  // trigger — re-check entitlement (debounced, so this doesn't hammer the endpoint every
  // time the service worker wakes up).
  checkWebEntitlement(WebEntitlementEngine.REASON_FOREGROUND).catch(err => console.error("Entitlement check failed:", err));
}

// Storage Listener to propagate rules update
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && (changes.blocked_domains || changes.whitelisted_domains || changes.active_blocks || changes.work_profile || changes.quick_focus_session)) {
    updateBlockerRules();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("GetYourLifeBack Extension installed.");
  initializeBlocker();
});

chrome.runtime.onStartup.addListener(() => {
  console.log("GetYourLifeBack Service Worker started.");
  initializeBlocker();
});
