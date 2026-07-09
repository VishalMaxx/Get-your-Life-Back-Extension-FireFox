// HeartbeatEngine.js
// Enterprise-grade UMD module. Compatible with Node.js (node --test) and the MV3
// Chrome Service Worker via importScripts().
//
// WHAT THIS IS
// The pure payload builder for the extension's presence heartbeat — a single doc at
// `users/{uid}/extensionPresence/heartbeat` the companion Android app reads to show
// "extension connected" vs. "get the extension" on its Extension Control screen.
//
// Deliberately a SEPARATE doc from `extensionSettings/settings`: that doc's `updatedAt`
// already drives Exit-Behavior last-write-wins sync, and a heartbeat written every
// sync_pull tick (5 min) would make the extension's own re-push always "win" a race
// against a phone-side Exit Behavior edit. See background.js's syncFirestoreLoop for
// where this is pushed.
//
// Multiple browsers signed into the same account share one heartbeat doc — last-write-
// wins is intentional; the phone only needs to know *some* extension is alive, not which
// specific browser.

(function (root, factory) {
  if (typeof exports === 'object' && typeof module === 'object') {
    module.exports = factory();
  } else {
    root.HeartbeatEngine = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {

  /**
   * Payload for `users/{uid}/extensionPresence/heartbeat`. Pure — no Date.now() inside,
   * caller supplies `nowMs` so this is deterministic and testable.
   *
   * A non-finite or non-positive `nowMs` clamps to 0 rather than passing through: the
   * firestore.rules generic sync rule requires `updatedAt is int` (a NaN would satisfy
   * "is int" checks inconsistently and could permanently wedge the strictly-increasing
   * `updatedAt > resource.data.updatedAt` update rule for every future push).
   */
  function buildHeartbeatPayload(nowMs) {
    const safeMs = typeof nowMs === 'number' && Number.isFinite(nowMs) && nowMs > 0 ? nowMs : 0;
    return { updatedAt: safeMs, deleted: false };
  }

  return { buildHeartbeatPayload };
});
