// oauth.test.js — run with `node --test` (zero dependencies).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Load configurations and background source code
const configCode = fs.readFileSync(path.join(__dirname, 'config.js'), 'utf8');
const backgroundCode = fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8');

// Strip importScripts
const cleanedBgCode = backgroundCode.replace(/importScripts\([^)]*\);?/, '');

function setupAuthSandbox(redirectUrlToMock) {
  const sandbox = {
    console: {
      log: () => {},
      error: () => {},
      warn: () => {}
    },
    // Mock the chrome extension APIs needed
    chrome: {
      identity: {
        getRedirectURL: () => redirectUrlToMock,
        launchWebAuthFlow: (options, callback) => {
          sandbox.capturedAuthUrl = options.url;
          // Simulate successful Google OAuth redirect back to the extension with ID token
          const tokenUrl = `${options.url.split('&redirect_uri=')[1].split('&')[0]}#id_token=mock_google_id_token`;
          setTimeout(() => callback(tokenUrl), 0);
        }
      },
      storage: {
        local: {
          get: (keys, callback) => {
            if (callback) setTimeout(() => callback({}), 0);
            return Promise.resolve({});
          },
          set: (items, callback) => {
            if (callback) setTimeout(callback, 0);
            return Promise.resolve();
          }
        },
        onChanged: { addListener: () => {} }
      },
      declarativeNetRequest: {
        getDynamicRules: () => Promise.resolve([]),
        updateDynamicRules: () => Promise.resolve()
      },
      runtime: {
        onInstalled: { addListener: () => {} },
        onStartup: { addListener: () => {} },
        onMessage: { addListener: () => {} },
        getURL: (p) => `chrome-extension://mock-id/${p}`,
        sendMessage: () => Promise.resolve()
      },
      alarms: {
        onAlarm: { addListener: () => {} },
        create: () => {}
      },
      notifications: {
        onButtonClicked: { addListener: () => {} },
        onClicked: { addListener: () => {} },
        create: () => {},
        clear: () => {}
      },
      tabs: {
        onRemoved: { addListener: () => {} },
        get: () => Promise.resolve({}),
        update: () => Promise.resolve(),
        create: () => Promise.resolve({}),
        remove: () => Promise.resolve()
      }
    },
    capturedAuthUrl: null,
    capturedFirebasePayload: null,
    // Mock fetch to intercept the Firebase IDP exchange call
    fetch: async (url, options) => {
      if (url.includes('accounts:signInWithIdp')) {
        sandbox.capturedFirebasePayload = JSON.parse(options.body);
        return {
          ok: true,
          json: async () => ({
            idToken: 'mock_firebase_id_token',
            email: 'test@gylb.app',
            localId: 'mock_uid'
          })
        };
      }
      return { ok: true, json: async () => ({}) };
    },
    Math: {
      random: () => 0.12345
    },
    Promise,
    setTimeout
  };

  // Run the configuration and background code inside the sandbox
  const context = vm.createContext(sandbox);
  vm.runInContext(configCode, context);
  vm.runInContext(cleanedBgCode, context);

  return { sandbox, context };
}

test('Google Sign-In Flow on Chrome Extension', async () => {
  const chromeRedirect = 'https://abcdefghijklmnopqrstuvwxyzabcdef.chromiumapp.org/';
  const { sandbox, context } = setupAuthSandbox(chromeRedirect);

  // Trigger Google Sign-In inside the VM sandbox
  const signInWithGoogle = vm.runInContext('signInWithGoogle', context);
  const authPromise = signInWithGoogle();
  await authPromise;

  // 1. Verify Google OAuth URL parameters
  assert.ok(sandbox.capturedAuthUrl);
  const parsedUrl = new URL(sandbox.capturedAuthUrl);
  assert.equal(parsedUrl.searchParams.get('redirect_uri'), chromeRedirect);

  const firebaseConfig = vm.runInContext('FIREBASE_CONFIG', context);
  assert.equal(parsedUrl.searchParams.get('client_id'), firebaseConfig.googleClientId);

  // 2. Verify Firebase exchange requestUri
  assert.ok(sandbox.capturedFirebasePayload);
  assert.equal(sandbox.capturedFirebasePayload.requestUri, chromeRedirect);
  assert.equal(sandbox.capturedFirebasePayload.postBody, 'id_token=mock_google_id_token&providerId=google.com');
});

test('Google Sign-In Flow on Firefox Extension (Subdomain UUID & Firebase Pre-authorized URL)', async () => {
  const firefoxRedirect = 'https://79456c85-8109-40f2-abd9-0c53f8333082.identity.getfirefox.com/';
  const expectedLoopback = 'http://127.0.0.1/mozoauth2/79456c85-8109-40f2-abd9-0c53f8333082';
  const expectedFirebaseHandler = 'https://get-your-life-back-prod-3eae6.firebaseapp.com/__/auth/handler';
  
  const { sandbox, context } = setupAuthSandbox(firefoxRedirect);

  // Trigger Google Sign-In inside the VM sandbox
  const signInWithGoogle = vm.runInContext('signInWithGoogle', context);
  const authPromise = signInWithGoogle();
  await authPromise;

  // 1. Verify Google OAuth URL gets the loopback URI
  assert.ok(sandbox.capturedAuthUrl);
  const parsedUrl = new URL(sandbox.capturedAuthUrl);
  assert.equal(parsedUrl.searchParams.get('redirect_uri'), expectedLoopback);

  // 2. Verify Firebase exchange gets the pre-authorized Firebase auth handler
  assert.ok(sandbox.capturedFirebasePayload);
  assert.equal(sandbox.capturedFirebasePayload.requestUri, expectedFirebaseHandler);
});

test('Supabase Config contains active database credentials', () => {
  const sandbox = {};
  const context = vm.createContext(sandbox);
  vm.runInContext(configCode, context);

  const supabaseConfig = vm.runInContext('SUPABASE_CONFIG', context);
  assert.ok(supabaseConfig);
  assert.equal(supabaseConfig.url, 'https://zqakkteyhggwseydmsoz.supabase.co');
  assert.ok(supabaseConfig.anonKey.startsWith('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'));
});
