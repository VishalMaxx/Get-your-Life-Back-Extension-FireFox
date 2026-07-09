// WellbeingRemindersEngine.js
// Enterprise-grade UMD module. Compatible with Node.js (node --test) and the MV3
// Chrome Service Worker via importScripts().
//
// WHAT THIS IS
// The pure decision core for "Wellbeing Tools" — two periodic body-health nudges (the
// 20-20-20 eye-rest rule, and a water/movement break) that live alongside the existing
// focus tools (Blocked Websites / Quick Focus / Work Profile). This module owns ONLY the
// timing math and the scoring-award math; background.js reads the result and does the
// actual chrome.alarms/chrome.notifications/chrome.tabs work, and the popup UI reads/writes
// the config object. No chrome APIs, no I/O — so it is exhaustively unit-testable.
//
// DATA MODEL (stored under chrome.storage.local key `wellbeing_tools`)
//   config = {
//     eyeRest:    { enabled: boolean, mode: 'NOTIFICATION'|'PAUSE_SCREEN', lastFiredAt: number|null, completedCount: number },
//     waterBreak: { enabled: boolean, mode: 'NOTIFICATION'|'PAUSE_SCREEN', intervalMinutes: number, lastFiredAt: number|null, completedCount: number },
//   }
//   `eyeRest.intervalMinutes` is NOT part of the model — it is always the fixed
//   EYE_REST_INTERVAL_MINUTES constant below. Only Water Break's cadence is user-chosen.
//
// TIER GATING (decided by the founder, enforced in background.js/popup.js, not here):
//   Water Break is available on the Free tier. Eye Rest (20-20-20) requires Extension Pro.
//   This engine has no concept of entitlement — it just computes timing/scoring given a
//   config that background.js has already gated.
//
// SCORING (founder-approved batching, 2026-07-09): rewards only, never a penalty for a
// missed/skipped reminder — the founder explicitly wanted this to feel encouraging, not
// punitive, unlike Work Profile/Quick Focus's stricter cheat-resistant model. Every 3rd
// completed reminder (of either type, counted independently) earns +1 Clarity and +1
// Compliance; every 5th completed reminder earns an additional +1 Sovereignty. Both can
// fire on the same completion (e.g. the 15th) — they are independent modulo checks, not
// mutually exclusive tiers.

(function (root, factory) {
  if (typeof exports === 'object' && typeof module === 'object') {
    module.exports = factory();
  } else {
    root.WellbeingRemindersEngine = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {

  const TYPE_EYE_REST = 'EYE_REST';
  const TYPE_WATER_BREAK = 'WATER_BREAK';

  const MODE_NOTIFICATION = 'NOTIFICATION';
  const MODE_PAUSE_SCREEN = 'PAUSE_SCREEN';

  const EYE_REST_INTERVAL_MINUTES = 20; // fixed by the 20-20-20 rule itself; never user-editable
  const DEFAULT_WATER_INTERVAL_MINUTES = 30;
  const MIN_WATER_INTERVAL_MINUTES = 5;
  const MAX_WATER_INTERVAL_MINUTES = 180;

  const CLARITY_COMPLIANCE_EVERY = 3;
  const SOVEREIGNTY_EVERY = 5;

  /** The config shape written on first install / whenever storage has no `wellbeing_tools` key yet. */
  function defaultConfig() {
    return {
      eyeRest: { enabled: false, mode: MODE_PAUSE_SCREEN, lastFiredAt: null, completedCount: 0 },
      waterBreak: {
        enabled: false, mode: MODE_PAUSE_SCREEN,
        intervalMinutes: DEFAULT_WATER_INTERVAL_MINUTES,
        lastFiredAt: null, completedCount: 0,
      },
    };
  }

  /** Is `mins` a sane, user-settable Water Break interval? */
  function isValidWaterInterval(mins) {
    return Number.isFinite(mins) && Number.isInteger(mins)
      && mins >= MIN_WATER_INTERVAL_MINUTES && mins <= MAX_WATER_INTERVAL_MINUTES;
  }

  /** Clamp/repair an untrusted interval value (e.g. from a message payload) to a safe default. */
  function clampWaterInterval(mins) {
    if (!Number.isFinite(mins)) return DEFAULT_WATER_INTERVAL_MINUTES;
    const rounded = Math.round(mins);
    if (rounded < MIN_WATER_INTERVAL_MINUTES) return MIN_WATER_INTERVAL_MINUTES;
    if (rounded > MAX_WATER_INTERVAL_MINUTES) return MAX_WATER_INTERVAL_MINUTES;
    return rounded;
  }

  /** The fixed/effective interval for a reminder type — Eye Rest ignores any stored value. */
  function intervalMinutesFor(type, reminder) {
    if (type === TYPE_EYE_REST) return EYE_REST_INTERVAL_MINUTES;
    return isValidWaterInterval(reminder && reminder.intervalMinutes)
      ? reminder.intervalMinutes
      : DEFAULT_WATER_INTERVAL_MINUTES;
  }

  /**
   * Should this reminder fire right now? Pure function of its own state + the clock — the
   * 1-minute `wellbeing_tick` alarm calls this for both types every tick rather than trying
   * to manage per-type dynamic-period alarms, so changing Water Break's interval takes
   * effect immediately without re-registering an alarm (same robustness rationale as the
   * existing `wp_tick`/Work Profile design).
   *
   * @param type TYPE_EYE_REST | TYPE_WATER_BREAK
   * @param reminder { enabled, intervalMinutes?, lastFiredAt }
   * @param now ms epoch
   */
  function shouldFire(type, reminder, now) {
    if (!reminder || !reminder.enabled) return false;
    const intervalMs = intervalMinutesFor(type, reminder) * 60000;
    const last = typeof reminder.lastFiredAt === 'number' ? reminder.lastFiredAt : null;
    if (last === null) return true; // never fired since being enabled — fire on the first eligible tick
    return (now - last) >= intervalMs;
  }

  /**
   * Award math for one completed reminder occurrence (user actually complied — clicked the
   * notification's action button, or finished the pause-screen flow). Independent modulo
   * checks: a milestone completion (e.g. the 15th) can pay out both the Clarity/Compliance
   * bonus AND the Sovereignty bonus in the same call.
   *
   * @param previousCompletedCount the reminder's `completedCount` before this occurrence
   * @returns { newCount, clarityDelta, complianceDelta, sovereigntyDelta }
   */
  function computeCompletionAward(previousCompletedCount) {
    const base = Number.isFinite(previousCompletedCount) && previousCompletedCount > 0
      ? Math.floor(previousCompletedCount) : 0;
    const newCount = base + 1;
    const hitClarityCompliance = newCount % CLARITY_COMPLIANCE_EVERY === 0;
    const hitSovereignty = newCount % SOVEREIGNTY_EVERY === 0;
    return {
      newCount,
      clarityDelta: hitClarityCompliance ? 1 : 0,
      complianceDelta: hitClarityCompliance ? 1 : 0,
      sovereigntyDelta: hitSovereignty ? 1 : 0,
    };
  }

  /** Copy shown on the pause-screen tab / notification for each reminder type. */
  function contentFor(type) {
    if (type === TYPE_EYE_REST) {
      return {
        title: 'Rest your eyes',
        message: 'Look at something 20 feet away for 20 seconds.',
        notificationButtonTitle: "Done ✓",
        pauseScreenHoldSeconds: 20, // mandatory — this IS the 20-20-20 rule, not optional
      };
    }
    return {
      title: 'Time for a water break',
      message: 'Take a sip of water, or stand up and stretch for a moment.',
      notificationButtonTitle: 'Done ✓',
      pauseScreenHoldSeconds: 0, // no forced wait — the point is the nudge, not a timer
    };
  }

  /** Query string for the pause-screen tab, e.g. "type=eye_rest". */
  function pauseScreenQuery(type) {
    return `type=${type === TYPE_EYE_REST ? 'eye_rest' : 'water_break'}`;
  }

  return {
    TYPE_EYE_REST, TYPE_WATER_BREAK,
    MODE_NOTIFICATION, MODE_PAUSE_SCREEN,
    EYE_REST_INTERVAL_MINUTES, DEFAULT_WATER_INTERVAL_MINUTES,
    MIN_WATER_INTERVAL_MINUTES, MAX_WATER_INTERVAL_MINUTES,
    defaultConfig, isValidWaterInterval, clampWaterInterval, intervalMinutesFor,
    shouldFire, computeCompletionAward, contentFor, pauseScreenQuery,
  };
});
