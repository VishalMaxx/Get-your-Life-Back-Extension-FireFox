// QuickFocusEngine.js
// Enterprise-grade UMD module. Compatible with Node.js (node --test) and the MV3
// Chrome Service Worker via importScripts().
//
// WHAT THIS IS
// The pure decision core for "Quick Focus" — a one-off, timed HARD-block session
// ("focus for N minutes") that is independent of the recurring Work Profile schedule.
// Unlike Work Profile's FOCUS windows (planned, weekly), a Quick Focus session is
// started on demand and cannot be shortened or cancelled once running — that's the
// "hard" in hard-block, and it's what makes completion worth bonus points. This module
// owns ONLY the session lifecycle + scope math; background.js applies the DNR rules and
// the (founder-built) popup UI starts/reads sessions via chrome.runtime messages. No
// chrome APIs, no I/O — exhaustively unit-testable.
//
// DATA MODEL (stored under chrome.storage.local key `quick_focus_session`)
//   session = {
//     active: boolean,
//     scope: "ALL" | "BLOCKLIST",   // ALL = block every site except `whitelist` below.
//                                    // BLOCKLIST = block the base blocklist only, but
//                                    // (like Work Profile FOCUS) IGNORE temporary bypass
//                                    // whitelists — you can't whitelist your way out.
//     whitelist: string[],          // ALL scope only. Normalized domains chosen BEFORE the
//                                    // session starts — the one pre-committed exception to
//                                    // "no exceptions". Always [] for BLOCKLIST scope. Fixed
//                                    // for the life of the session: there is no message to
//                                    // edit it once active, so it is exactly as tamper-proof
//                                    // as the rest of the hard-block (see ANTI-CHEAT below).
//     durationMinutes: number,
//     startedAt: number,            // epoch ms
//     endsAt: number,               // epoch ms
//     completed: boolean,
//     awardedPoints: number | null  // set once completeSession() has run
//   }
//
// DOCUMENTED EDGE-CASE DECISIONS (defaults chosen for the majority; flip in review if wanted)
//   • Early exit IS possible, but never free: `forfeitSession` ends a live session before
//     its natural `endsAt` and always pays out 0 bonus points. background.js gates calling
//     it behind the Skip Pass economy (QuickFocusSkipEngine.js) — spend a pass, or accept
//     an adaptive score penalty. This engine doesn't know about passes/penalties; it only
//     knows how to end a session early and report how many minutes were forfeited.
//   • ALL scope always outranks everything else (including a live Work Profile FOCUS
//     window) when merged for DNR purposes — see mergeWithBlockDecision. Its only
//     allowlist is the `whitelist` set at start time (see DATA MODEL above); once running
//     there is no message handler that can grow it, so it can only ever be a SUBSET of
//     what any other decision would allow.
//   • BLOCKLIST scope earns bonus points at half the ALL-scope rate (less restrictive).
//   • Points are only awarded on a completion that actually reached `endsAt` — calling
//     completeSession() early (e.g. a stale/duplicate alarm) never pays out.

(function (root, factory) {
  if (typeof exports === 'object' && typeof module === 'object') {
    module.exports = factory();
  } else {
    root.QuickFocusEngine = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {

  const SCOPE_ALL = 'ALL';
  const SCOPE_BLOCKLIST = 'BLOCKLIST';

  const MODE_ALL = 'ALL';
  const MODE_BLOCKLIST = 'BLOCKLIST';
  const MODE_NONE = 'NONE';

  const MIN_DURATION_MINUTES = 1;
  const MAX_DURATION_MINUTES = 180; // 3h cap — guards against an accidental near-forever lock.
  const DURATION_PRESETS_MINUTES = [25, 50, 90]; // Pomodoro + deep-work multiples — suggestions for the popup UI only.
  const DEFAULT_POINTS_PER_HOUR = 10; // parity with WorkProfileEngine.focusBonusPoints default.
  const BLOCKLIST_SCOPE_RATE_MULTIPLIER = 0.5;
  const MAX_WHITELIST_DOMAINS = 25; // same "bound user input" philosophy as MAX_DURATION_MINUTES.

  /** Duration must be a finite number of minutes within [MIN, MAX]. */
  function isValidDuration(minutes) {
    return typeof minutes === 'number' && Number.isFinite(minutes) &&
      minutes >= MIN_DURATION_MINUTES && minutes <= MAX_DURATION_MINUTES;
  }

  /** Strips scheme/www/path down to a bare domain. Self-contained (no cross-engine import)
   *  so this module stays a standalone, dependency-free UMD — same normalization rule as
   *  WorkProfileEngine.normalizeDomain. */
  function normalizeDomain(d) {
    if (typeof d !== 'string') return '';
    return d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }

  /** De-duplicated, normalized, order-preserving, capped at MAX_WHITELIST_DOMAINS. */
  function normalizeWhitelist(list) {
    const seen = new Set();
    const out = [];
    (Array.isArray(list) ? list : []).forEach((d) => {
      const n = normalizeDomain(d);
      if (n && !seen.has(n)) { seen.add(n); out.push(n); }
    });
    return out.slice(0, MAX_WHITELIST_DOMAINS);
  }

  /** True while `session` is currently running (not yet reached its end, not yet completed). */
  function isActive(session, now) {
    return !!session && session.active === true && session.completed !== true &&
      now.getTime() < session.endsAt;
  }

  /** Milliseconds left in the session, clamped to 0. */
  function remainingMs(session, now) {
    if (!session) return 0;
    return Math.max(0, session.endsAt - now.getTime());
  }

  /**
   * Start a new session. Rejects if one is already running (no stacking/overwriting a live
   * hard-block) or if scope/duration are invalid.
   * @returns { ok: boolean, session: Session|null, reason: string|null }
   */
  function startSession(current, request, now) {
    if (isActive(current, now)) {
      return { ok: false, session: current, reason: 'A Quick Focus session is already running.' };
    }
    const scope = request && request.scope;
    if (scope !== SCOPE_ALL && scope !== SCOPE_BLOCKLIST) {
      return { ok: false, session: current || null, reason: 'Invalid Quick Focus scope.' };
    }
    const durationMinutes = request && request.durationMinutes;
    if (!isValidDuration(durationMinutes)) {
      return {
        ok: false,
        session: current || null,
        reason: `Duration must be between ${MIN_DURATION_MINUTES} and ${MAX_DURATION_MINUTES} minutes.`
      };
    }
    // Whitelist is the one pre-commit exception, and only means anything for ALL scope —
    // BLOCKLIST scope deliberately has no allowlist concept of its own (see DATA MODEL).
    const whitelist = scope === SCOPE_ALL ? normalizeWhitelist(request && request.whitelist) : [];

    const startedAt = now.getTime();
    const endsAt = startedAt + durationMinutes * 60000;
    return {
      ok: true,
      session: { active: true, scope, whitelist, durationMinutes, startedAt, endsAt, completed: false, awardedPoints: null },
      reason: null
    };
  }

  /** The block decision from Quick Focus alone (background.js merges this with Work Profile). */
  function effectiveBlock(session, now) {
    if (!isActive(session, now)) return { active: false, mode: MODE_NONE, allow: [] };
    return {
      active: true,
      mode: session.scope === SCOPE_ALL ? MODE_ALL : MODE_BLOCKLIST,
      allow: session.scope === SCOPE_ALL ? (session.whitelist || []) : [],
    };
  }

  /** Bonus Sovereignty for completing a session, scaled by duration and scope. */
  function pointsForSession(session, perHour) {
    if (!session || !isValidDuration(session.durationMinutes)) return 0;
    const rate = typeof perHour === 'number' ? perHour : DEFAULT_POINTS_PER_HOUR;
    const scopedRate = session.scope === SCOPE_BLOCKLIST ? rate * BLOCKLIST_SCOPE_RATE_MULTIPLIER : rate;
    return Math.round((session.durationMinutes / 60) * scopedRate);
  }

  /**
   * End a session (called when the `quick_focus_end` alarm fires, or defensively at
   * startup if the worker missed the alarm). Only awards points if `now` has actually
   * reached `endsAt` — an early/duplicate call just closes the session with 0 points.
   * @returns { session: Session, awardedPoints: number }
   */
  function completeSession(session, now) {
    if (!session || session.completed) return { session, awardedPoints: 0 };
    const reachedEnd = now.getTime() >= session.endsAt;
    const awardedPoints = reachedEnd ? pointsForSession(session) : 0;
    return {
      session: Object.assign({}, session, { active: false, completed: true, awardedPoints }),
      awardedPoints
    };
  }

  /**
   * End a session BEFORE its natural `endsAt` (the Skip Pass escape valve — see
   * QuickFocusSkipEngine.js). Always pays 0 bonus points; forfeiting is never rewarded,
   * only the cost is negotiable (a pass or a penalty, decided by the caller). Reports how
   * many minutes were abandoned so the caller can factor that into a penalty if it charges one.
   * @returns { session: Session, minutesRemaining: number }
   */
  function forfeitSession(session, now) {
    if (!session || session.completed) return { session, minutesRemaining: 0 };
    const minutesRemaining = Math.max(0, (session.endsAt - now.getTime()) / 60000);
    return {
      session: Object.assign({}, session, { active: false, completed: true, awardedPoints: 0, forfeited: true }),
      minutesRemaining
    };
  }

  /**
   * Merge Quick Focus with the Work Profile's `effectiveBlock` result for DNR rule
   * building. Most-restrictive-wins, same philosophy as WorkProfileEngine's own overlap
   * resolution:
   *   • Quick Focus ALL always wins, carrying its own pre-committed `whitelist` (if any)
   *     as `allow` — still only ever a subset of what any other decision would allow.
   *   • Otherwise a live Work Profile FOCUS window wins (it has its own allowlist).
   *   • Otherwise Quick Focus BLOCKLIST elevates the Work Profile block set to ignore
   *     temporary bypass whitelists (the hard-block property) without changing which
   *     domains are blocked.
   *   • Otherwise pass the Work Profile decision through unchanged (bypass honored).
   * @returns { mode: string, allow: string[], block: string[], ignoreBypass: boolean }
   */
  function mergeWithBlockDecision(qfEffective, wpEffective) {
    const qf = qfEffective || { active: false, mode: MODE_NONE, allow: [] };
    const wp = wpEffective || { mode: MODE_NONE, allow: [], block: [] };

    if (qf.mode === MODE_ALL) {
      return { mode: MODE_ALL, allow: qf.allow || [], block: [], ignoreBypass: true };
    }
    if (wp.mode === 'FOCUS') {
      return { mode: 'FOCUS', allow: wp.allow || [], block: [], ignoreBypass: true };
    }
    if (qf.mode === MODE_BLOCKLIST) {
      return { mode: 'HARD_BLOCKLIST', allow: [], block: wp.block || [], ignoreBypass: true };
    }
    return { mode: wp.mode || MODE_NONE, allow: [], block: wp.block || [], ignoreBypass: false };
  }

  return {
    SCOPE_ALL, SCOPE_BLOCKLIST,
    MODE_ALL, MODE_BLOCKLIST, MODE_NONE,
    MIN_DURATION_MINUTES, MAX_DURATION_MINUTES, DURATION_PRESETS_MINUTES, DEFAULT_POINTS_PER_HOUR,
    MAX_WHITELIST_DOMAINS,
    isValidDuration, normalizeDomain, normalizeWhitelist, isActive, remainingMs, startSession,
    effectiveBlock, pointsForSession, completeSession, forfeitSession, mergeWithBlockDecision,
  };
});
