// QuickFocusSkipEngine.js
// Enterprise-grade UMD module. Compatible with Node.js (node --test) and the MV3
// Chrome Service Worker via importScripts().
//
// WHAT THIS IS
// The pure decision core for the Quick Focus "Skip Pass" escape valve — a live Quick
// Focus session (QuickFocusEngine.js) can be ended early, either by spending a Skip Pass
// (free monthly allowance + a purchasable top-up bucket) or, once passes are exhausted,
// by accepting an adaptive score penalty instead. This mirrors the Android app's Deep
// Lock Skip Pass (core-pil SkipPass.kt: 3 free/month, a never-resetting purchased
// bucket) for the SAME product reason — an absolute, zero-escape hard lock is worse UX
// than a rare, deliberately-costed escape hatch (see BACKEND_HANDOFF.md §7 Phase 2 for
// the founder decision this implements). It is a SEPARATE wallet from the Android Deep
// Lock Skip Pass — same shape, different economy (Quick Focus sessions vs. scheduled
// Deep Lock windows). No chrome APIs, no I/O — exhaustively unit-testable.
//
// SKIP PASS DATA MODEL (stored under chrome.storage.local key `quick_focus_skip_balance`)
//   balance = { monthKey: "YYYY-MM", usedThisMonth: number, purchasedBalance: number }
//   3 free passes auto-renew every calendar month (rollBalance resets usedThisMonth on a
//   month change); `purchasedBalance` never resets and is spent only after the free
//   allowance runs out. `creditPurchased` is the purchase seam — nothing calls it yet
//   (Phase 4: checkout format not decided, same as the Android purchased-pass bucket).
//
// ADAPTIVE PENALTY ALGORITHM (the founder's explicit spec)
// When no pass is available (or the user opts out of spending one), ending a session
// early is still ALWAYS allowed — but it logs an unpaid skip and computes a penalty in
// abstract "penalty units" (interpretation into an actual Sovereignty deduction is a
// Phase 3 concern — see guardrail #2 in BACKEND_HANDOFF.md: it needs a Kotlin-mirrored
// event type before it can touch the live score). The penalty has two independent knobs:
//   1. ESCALATION — an exponentially-decaying "heat" value (a leaky bucket, not a hard
//      cutoff window like the Android system's fixed 7-day trailing window): each unpaid
//      skip adds +1 heat, but existing heat decays with a 7-day half-life. Skips spaced
//      weeks apart barely compound (~3 half-lives at 3 weeks => heat ~= 12.5% of prior) —
//      "doesn't punish the user unnecessarily" per the founder's ask — while skips in
//      quick succession compound fast (heat 0->1->2->3... => multiplier 1x->2x->4x->8x,
//      capped at 16x, the SAME growth/cap constants as the Android system for a
//      consistent "feel").
//   2. USAGE SEVERITY — how long the user actually spent on a previously-blocked domain
//      in the hour after skipping (measured by background.js's coarse 1-minute poll, see
//      its `tickSkipUsageObservation`). A quick peek costs less than a 45-minute binge,
//      but bailing at all always costs at least USAGE_SEVERITY_FLOOR — you can't dodge
//      the deterrent just by minimizing the tab.

(function (root, factory) {
  if (typeof exports === 'object' && typeof module === 'object') {
    module.exports = factory();
  } else {
    root.QuickFocusSkipEngine = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {

  const MONTHLY_FREE_PASSES = 3;

  const HEAT_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // echoes the Android 7-day escalation window
  const HEAT_GROWTH = 2.0;      // same growth constant as Android's escalationMultiplier
  const MAX_MULTIPLIER = 16.0;  // same cap as Android's escalationMultiplier
  const BASE_PENALTY_UNITS = 1.0;
  const USAGE_CAP_MINUTES = 60;
  const USAGE_SEVERITY_FLOOR = 0.5;

  const EMERGENCY_ONLY_NOTICE =
    "Skip passes are for genuine emergencies -- please don't use one just because a session " +
    "is inconvenient right now. It ends your lockdown early, and once your free passes run " +
    "out for the month, skipping still costs you score.";

  // -- skip pass balance --------------------------------------------------------

  /** Local calendar key "YYYY-MM" -- passes renew on a calendar-month boundary. */
  function monthKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  /** Reset the free monthly allowance on a month rollover; the purchased bucket persists. */
  function rollBalance(balance, date) {
    const key = monthKey(date);
    if (!balance || balance.monthKey !== key) {
      return { monthKey: key, usedThisMonth: 0, purchasedBalance: (balance && balance.purchasedBalance) || 0 };
    }
    return balance;
  }

  /** Free passes left this month (never negative). */
  function freeRemaining(balance) {
    if (!balance) return MONTHLY_FREE_PASSES;
    return Math.max(0, MONTHLY_FREE_PASSES - (balance.usedThisMonth || 0));
  }

  /** Total passes available right now: free remainder + purchased top-up. */
  function passesAvailable(balance) {
    if (!balance) return MONTHLY_FREE_PASSES;
    return freeRemaining(balance) + (balance.purchasedBalance || 0);
  }

  /**
   * Spend one pass -- the free monthly allowance first, then the purchased bucket.
   * Caller must roll the balance for `date` first (rollBalance) so a month boundary
   * doesn't silently deny an available free pass.
   * @returns { ok: boolean, balance: Balance, reason: string|null }
   */
  function spendPass(balance, date) {
    const rolled = rollBalance(balance, date);
    if (passesAvailable(rolled) <= 0) {
      return { ok: false, balance: rolled, reason: 'No Skip Passes available.' };
    }
    if (freeRemaining(rolled) > 0) {
      return { ok: true, balance: Object.assign({}, rolled, { usedThisMonth: (rolled.usedThisMonth || 0) + 1 }), reason: null };
    }
    return { ok: true, balance: Object.assign({}, rolled, { purchasedBalance: rolled.purchasedBalance - 1 }), reason: null };
  }

  /** THE PURCHASE SEAM. Nothing calls this in v1 -- Phase 4 checkout lands here. */
  function creditPurchased(balance, count) {
    const base = balance || { monthKey: null, usedThisMonth: 0, purchasedBalance: 0 };
    return Object.assign({}, base, { purchasedBalance: (base.purchasedBalance || 0) + Math.max(0, count || 0) });
  }

  // -- adaptive penalty algorithm ------------------------------------------------

  /** Exponential half-life decay of prior "heat" over `elapsedMs`. */
  function decayedHeat(priorHeat, elapsedMs) {
    if (!Number.isFinite(priorHeat) || priorHeat <= 0) return 0;
    if (!Number.isFinite(elapsedMs) || elapsedMs === Infinity) return 0;
    if (elapsedMs <= 0) return priorHeat;
    return priorHeat * Math.pow(0.5, elapsedMs / HEAT_HALF_LIFE_MS);
  }

  /** Heat after this new unpaid skip (decay the old heat, then add this occurrence). */
  function nextHeat(priorHeat, elapsedMs) {
    return decayedHeat(priorHeat, elapsedMs) + 1;
  }

  /** growth^heat, capped -- mirrors Android's escalationMultiplier shape exactly. */
  function escalationMultiplier(heat) {
    return Math.min(Math.pow(HEAT_GROWTH, heat), MAX_MULTIPLIER);
  }

  /** 0.5..1.0 scaling factor from minutes spent on a blocked domain after the skip. */
  function usageSeverity(minutesUsedAfterSkip) {
    const clamped = Math.min(Math.max(minutesUsedAfterSkip || 0, 0), USAGE_CAP_MINUTES);
    const scale = clamped / USAGE_CAP_MINUTES;
    return USAGE_SEVERITY_FLOOR + (1 - USAGE_SEVERITY_FLOOR) * scale;
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  /**
   * The penalty for a single unpaid skip, given the heat carried in from prior skips and
   * how long the user spent on a blocked domain afterward (null/undefined => not yet
   * observed, treated as 0 for now -- background.js finalizes this once its 1-hour
   * observation window closes and can recompute).
   * @returns { heat, multiplier, penaltyUnits }
   */
  function penaltyForSkip(priorHeat, elapsedMsSincePrior, minutesUsedAfterSkip) {
    const heat = nextHeat(priorHeat, elapsedMsSincePrior);
    const multiplier = escalationMultiplier(heat);
    const severity = usageSeverity(minutesUsedAfterSkip);
    return { heat, multiplier, penaltyUnits: round2(BASE_PENALTY_UNITS * multiplier * severity) };
  }

  /**
   * Replay a history of unpaid skips (any order) and return the per-skip breakdown plus
   * the total penalty units. This is what a future Phase-3 scoring signal would fold in
   * (analogous to Android's `skipShortPenaltyUnits`) -- NOT wired into the live score yet.
   * @param history [{ timestamp: number, minutesUsedAfterSkip: number|null }]
   * @returns { perSkip: [...], totalPenaltyUnits: number, currentHeat: number }
   */
  function aggregatePenalties(history) {
    const sorted = (history || []).slice().sort((a, b) => a.timestamp - b.timestamp);
    let heat = 0;
    let lastTimestamp = null;
    let totalPenaltyUnits = 0;
    const perSkip = sorted.map((rec) => {
      const elapsed = lastTimestamp === null ? Infinity : rec.timestamp - lastTimestamp;
      const result = penaltyForSkip(heat, elapsed, rec.minutesUsedAfterSkip);
      heat = result.heat;
      lastTimestamp = rec.timestamp;
      totalPenaltyUnits += result.penaltyUnits;
      return Object.assign({ timestamp: rec.timestamp }, result);
    });
    return { perSkip, totalPenaltyUnits: round2(totalPenaltyUnits), currentHeat: heat };
  }

  return {
    MONTHLY_FREE_PASSES, HEAT_HALF_LIFE_MS, HEAT_GROWTH, MAX_MULTIPLIER,
    BASE_PENALTY_UNITS, USAGE_CAP_MINUTES, USAGE_SEVERITY_FLOOR, EMERGENCY_ONLY_NOTICE,
    monthKey, rollBalance, freeRemaining, passesAvailable, spendPass, creditPurchased,
    decayedHeat, nextHeat, escalationMultiplier, usageSeverity, penaltyForSkip, aggregatePenalties,
  };
});
