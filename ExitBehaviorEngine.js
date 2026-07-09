// ExitBehaviorEngine.js
// Enterprise-grade UMD module. Compatible with Node.js (node --test) and the MV3
// Chrome Service Worker via importScripts().
//
// WHAT THIS IS
// The pure decision core for "what happens when the user taps Exit on the block screen."
// Previously this was hardcoded in blocked.js as `window.close()` (silently fails for any
// tab the user navigated to normally — only script-opened tabs can be closed that way)
// falling through to an unconditional redirect to google.com. This module owns ONLY the
// decision of WHICH action to take given the user's saved preference; background.js (which
// has chrome.tabs access) executes it. No chrome APIs, no I/O — exhaustively unit-testable.
//
// SETTINGS DATA MODEL (chrome.storage.local keys `exit_behavior` + `exit_custom_url`)
//   exit_behavior: "CLOSE_AND_NEW_TAB" | "CUSTOM_URL" | "BACK_HISTORY"  (default: CLOSE_AND_NEW_TAB)
//   exit_custom_url: string — only used when exit_behavior is CUSTOM_URL
//
// DOCUMENTED EDGE-CASE DECISIONS
//   • A Chrome extension cannot read the browser's actual configured homepage setting —
//     no API exposes it. So "go to home page" is implemented as "go to a URL you set once
//     in Settings" (CUSTOM_URL), not a literal homepage lookup.
//   • CUSTOM_URL with no URL configured yet falls back to CLOSE_AND_NEW_TAB rather than
//     erroring or doing nothing — a half-configured setting should never leave the user
//     stuck on the block screen.
//   • BACK_HISTORY reports its own fallback (CLOSE_AND_NEW_TAB) for the caller to use if
//     there's no history to go back to (a fresh tab, or the block screen was the first
//     navigation) — the engine can't know that itself, only background.js's
//     chrome.tabs.goBack() call reveals it at runtime.

(function (root, factory) {
  if (typeof exports === 'object' && typeof module === 'object') {
    module.exports = factory();
  } else {
    root.ExitBehaviorEngine = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {

  const BEHAVIOR_CLOSE_AND_NEW_TAB = 'CLOSE_AND_NEW_TAB';
  const BEHAVIOR_CUSTOM_URL = 'CUSTOM_URL';
  const BEHAVIOR_BACK_HISTORY = 'BACK_HISTORY';
  const DEFAULT_BEHAVIOR = BEHAVIOR_CLOSE_AND_NEW_TAB;

  const ACTION_CLOSE_AND_NEW_TAB = 'CLOSE_AND_NEW_TAB';
  const ACTION_NAVIGATE = 'NAVIGATE';
  const ACTION_BACK_HISTORY = 'BACK_HISTORY';

  /** "example.com" -> "https://example.com"; already-schemed URLs pass through; blank -> null. */
  function normalizeUrl(url) {
    if (typeof url !== 'string') return null;
    const trimmed = url.trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
  }

  /**
   * Resolve the saved settings into a concrete action for background.js to execute.
   * @param settings { exitBehavior: string, customUrl: string }
   * @returns
   *   { type: 'CLOSE_AND_NEW_TAB' } |
   *   { type: 'NAVIGATE', url: string } |
   *   { type: 'BACK_HISTORY', fallback: { type: 'CLOSE_AND_NEW_TAB' } }
   */
  function resolveExitAction(settings) {
    const behavior = (settings && settings.exitBehavior) || DEFAULT_BEHAVIOR;

    if (behavior === BEHAVIOR_CUSTOM_URL) {
      const url = normalizeUrl(settings && settings.customUrl);
      if (url) return { type: ACTION_NAVIGATE, url };
      return { type: ACTION_CLOSE_AND_NEW_TAB }; // not configured yet — never strand the user
    }

    if (behavior === BEHAVIOR_BACK_HISTORY) {
      return { type: ACTION_BACK_HISTORY, fallback: { type: ACTION_CLOSE_AND_NEW_TAB } };
    }

    return { type: ACTION_CLOSE_AND_NEW_TAB };
  }

  /** Is this a recognized, storable exit_behavior value? Used to validate a Settings write. */
  function isValidBehavior(behavior) {
    return behavior === BEHAVIOR_CLOSE_AND_NEW_TAB ||
      behavior === BEHAVIOR_CUSTOM_URL ||
      behavior === BEHAVIOR_BACK_HISTORY;
  }

  return {
    BEHAVIOR_CLOSE_AND_NEW_TAB, BEHAVIOR_CUSTOM_URL, BEHAVIOR_BACK_HISTORY, DEFAULT_BEHAVIOR,
    ACTION_CLOSE_AND_NEW_TAB, ACTION_NAVIGATE, ACTION_BACK_HISTORY,
    normalizeUrl, resolveExitAction, isValidBehavior,
  };
});
