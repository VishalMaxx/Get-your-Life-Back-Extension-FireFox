// WorkProfileEngine.js
// Enterprise-grade UMD module. Compatible with Node.js (node --test) and the MV3
// Chrome Service Worker via importScripts().
//
// WHAT THIS IS
// The pure decision core for the extension's Work Profile — a recurring weekly plan
// (Sun–Sat) of time WINDOWS that shape what the browser blocks, for concentrated work.
// This module owns ONLY the scheduling math + the anti-cheat rules; background.js reads
// the result and applies the actual declarativeNetRequest rules, and the UI (built
// separately) reads/writes the profile object. No chrome APIs, no I/O — so it is
// exhaustively unit-testable, which is the whole point (a blocker the user can cheat is
// worthless, and cheat-resistance is logic that must be pinned by tests).
//
// DATA MODEL (stored under chrome.storage.local key `work_profile`)
//   profile = {
//     enabled: boolean,
//     week: { "0": DaySchedule, ... "6": DaySchedule },   // 0=Sunday … 6=Saturday
//     overrides: { "YYYY-MM-DD": DaySchedule }             // one-off, wins over week
//   }
//   DaySchedule = { windows: Window[] }
//   Window = {
//     id: string,                 // stable id the anti-cheat matches on
//     start: "HH:MM", end: "HH:MM", // local minutes-of-day; end exclusive; "24:00" = end of day
//     mode: "FOCUS" | "LIGHT",
//     sites: string[]             // FOCUS → ALLOWLIST (block all else); LIGHT → BLOCKLIST
//   }
//   Outside every window: only the user's normal base blocklist applies.
//
// DOCUMENTED EDGE-CASE DECISIONS (defaults chosen for the majority; flip in review if wanted)
//   • Overlapping windows in one day → MOST-RESTRICTIVE wins. Any live FOCUS dominates
//     LIGHT; multiple FOCUS → a site is allowed only if EVERY active focus allows it
//     (allowlist intersection); multiple LIGHT → blocklists union.
//   • A window may not cross midnight (start must be < end). The UI splits an overnight
//     block into two windows (…–24:00 and 00:00–…). `end: "24:00"` means 1440.
//   • Only FOCUS windows earn points (deep work). LIGHT windows are guardrails, worth 0
//     by default — see focusBonusPoints.

(function (root, factory) {
  if (typeof exports === 'object' && typeof module === 'object') {
    module.exports = factory();
  } else {
    root.WorkProfileEngine = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {

  const MODE_FOCUS = 'FOCUS';
  const MODE_LIGHT = 'LIGHT';
  const MODE_NONE = 'NONE';

  // ── small pure helpers ──────────────────────────────────────────────────────

  /** Normalize a domain the same way the blocker does: lowercase, strip scheme/www/path. */
  function normalizeDomain(d) {
    if (typeof d !== 'string') return '';
    return d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }

  /** Local calendar key "YYYY-MM-DD" for override lookup. */
  function dateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  /** Local day-of-week key "0"(Sun)…"6"(Sat). */
  function dayKey(date) {
    return String(date.getDay());
  }

  /** Local minutes-of-day 0..1439. */
  function minutesOfDay(date) {
    return date.getHours() * 60 + date.getMinutes();
  }

  /** "HH:MM" (or "24:00") → minutes; NaN if malformed. */
  function parseHM(s) {
    if (typeof s !== 'string') return NaN;
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return NaN;
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h === 24 && min === 0) return 1440;
    if (h < 0 || h > 23 || min < 0 || min > 59) return NaN;
    return h * 60 + min;
  }

  function uniqueDomains(list) {
    const seen = new Set();
    const out = [];
    (list || []).forEach((d) => {
      const n = normalizeDomain(d);
      if (n && !seen.has(n)) { seen.add(n); out.push(n); }
    });
    return out;
  }

  function intersectDomains(lists) {
    if (lists.length === 0) return [];
    let acc = new Set(uniqueDomains(lists[0]));
    for (let i = 1; i < lists.length; i++) {
      const next = new Set(uniqueDomains(lists[i]));
      acc = new Set([...acc].filter((d) => next.has(d)));
    }
    return [...acc];
  }

  /** Is [start,end) a well-formed same-day window? */
  function isValidWindow(w) {
    if (!w || (w.mode !== MODE_FOCUS && w.mode !== MODE_LIGHT)) return false;
    const s = parseHM(w.start);
    const e = parseHM(w.end);
    return Number.isFinite(s) && Number.isFinite(e) && s < e;
  }

  // ── schedule resolution ─────────────────────────────────────────────────────

  /** The DaySchedule that applies on `date`: a one-off override wins over the weekly template. */
  function scheduleForDate(profile, date) {
    if (!profile || !profile.enabled) return { windows: [] };
    const overrides = profile.overrides || {};
    const override = overrides[dateKey(date)];
    if (override && Array.isArray(override.windows)) return override;
    const week = profile.week || {};
    const day = week[dayKey(date)];
    return day && Array.isArray(day.windows) ? day : { windows: [] };
  }

  /** Every valid window active at `date`'s local time (start ≤ now < end). */
  function activeWindows(profile, date) {
    const now = minutesOfDay(date);
    return scheduleForDate(profile, date).windows
      .filter(isValidWindow)
      .filter((w) => {
        const s = parseHM(w.start);
        const e = parseHM(w.end);
        return now >= s && now < e;
      });
  }

  /**
   * The effective block decision RIGHT NOW, resolving overlaps most-restrictive-first.
   * Returns { mode, allow, block }:
   *   FOCUS → allow only `allow` (block everything else) — the deep-work lockdown.
   *   LIGHT → block `block` (allow everything else) — the base blocklist plus the window's.
   *   NONE  → block `block` (just the base blocklist).
   */
  function effectiveBlock(profile, baseBlocklist, date) {
    const base = uniqueDomains(baseBlocklist);
    const active = activeWindows(profile, date);

    const focus = active.filter((w) => w.mode === MODE_FOCUS);
    if (focus.length > 0) {
      // Most restrictive: a site is allowed only if EVERY active focus window allows it.
      return { mode: MODE_FOCUS, allow: intersectDomains(focus.map((w) => w.sites)), block: [] };
    }

    const light = active.filter((w) => w.mode === MODE_LIGHT);
    if (light.length > 0) {
      const merged = base.slice();
      light.forEach((w) => uniqueDomains(w.sites).forEach((d) => merged.push(d)));
      return { mode: MODE_LIGHT, allow: [], block: uniqueDomains(merged) };
    }

    return { mode: MODE_NONE, allow: [], block: base };
  }

  /** True while a FOCUS window is live — the plan is locked (edits can only tighten it). */
  function isLocked(profile, date) {
    return activeWindows(profile, date).some((w) => w.mode === MODE_FOCUS);
  }

  // ── anti-cheat: only stricter edits are allowed during a live FOCUS window ───

  /**
   * Gate an edit while a FOCUS window is live. The user may make the plan STRICTER at any
   * time, never LOOSER mid-lockdown — otherwise "block until 10am" is one tap from defeat.
   *
   * Rejects, during a live focus window, any proposal that:
   *   • disables the profile,
   *   • drops / shortens (earlier end) / un-focuses the live window (matched by id),
   *   • widens its allowlist (adds a site that wasn't allowed before).
   * Shrinking the allowlist or extending the end is fine (stricter/longer). Non-active
   * windows and future days are unrestricted.
   *
   * @returns { allowed: boolean, reason: string|null }
   */
  function validateEdit(current, proposed, date) {
    if (!isLocked(current, date)) return { allowed: true, reason: null };
    if (!proposed || proposed.enabled === false) {
      return { allowed: false, reason: 'Work Profile is locked while a focus window is active.' };
    }

    const liveFocus = activeWindows(current, date).filter((w) => w.mode === MODE_FOCUS);
    const proposedActive = activeWindows(proposed, date);
    const proposedById = {};
    proposedActive.forEach((w) => { proposedById[w.id] = w; });
    // Also index ALL proposed windows for the day so a "moved out of the active slot" edit
    // (start pushed later so it's no longer active) is still caught as loosening.
    const proposedDay = {};
    scheduleForDate(proposed, date).windows.forEach((w) => { if (w.id != null) proposedDay[w.id] = w; });

    for (const live of liveFocus) {
      const p = proposedById[live.id] || proposedDay[live.id];
      if (!p) {
        return { allowed: false, reason: 'You can’t remove a focus window while it’s running.' };
      }
      if (p.mode !== MODE_FOCUS) {
        return { allowed: false, reason: 'You can’t switch a running focus window to Light mode.' };
      }
      if (parseHM(p.end) < parseHM(live.end)) {
        return { allowed: false, reason: 'You can’t end a running focus window early.' };
      }
      if (parseHM(p.start) > minutesOfDay(date)) {
        return { allowed: false, reason: 'You can’t push a running focus window into the future.' };
      }
      // Widening the allowlist (adding an allowed site) is loosening — reject any new site.
      const before = new Set(uniqueDomains(live.sites));
      const added = uniqueDomains(p.sites).filter((d) => !before.has(d));
      if (added.length > 0) {
        return { allowed: false, reason: 'You can’t allow more sites while the focus window is running.' };
      }
    }
    return { allowed: true, reason: null };
  }

  // ── points ──────────────────────────────────────────────────────────────────

  /**
   * Bonus Sovereignty for COMPLETING a focus window (awarded by background.js when the
   * window ends compliant). Scales with duration so a 2-hour lockdown is worth more than a
   * 20-minute one; LIGHT windows earn nothing by default (guardrails, not deep work).
   */
  function focusBonusPoints(w, perHour) {
    if (!isValidWindow(w) || w.mode !== MODE_FOCUS) return 0;
    const minutes = parseHM(w.end) - parseHM(w.start);
    const rate = typeof perHour === 'number' ? perHour : 10; // +10 Sovereignty / hour, default
    return Math.round((minutes / 60) * rate);
  }

  // ── completion detection (Phase 3b) ──────────────────────────────────────────

  /**
   * Detect FOCUS windows that just finished, by diffing the set of active FOCUS windows
   * against a snapshot taken on the previous tick. Work Profile has no discrete session
   * lifecycle (unlike Quick Focus) — it's continuously re-evaluated every minute — so this
   * is how background.js's wp_tick alarm notices "a window that was live is no longer live"
   * and credits `focusBonusPoints` exactly once per real occurrence.
   *
   * Anti-cheat already forbids disabling/removing/un-focusing a LIVE window (validateEdit),
   * so the only way a snapshotted FOCUS window can disappear from the active set is reaching
   * its own `end` — there's no other legitimate path, which is what makes "it dropped out of
   * the active set" a safe proxy for "it completed compliantly" without re-checking the
   * clock here. Keying by `${dateKey}:${id}` (not just `id`) distinguishes today's
   * occurrence of a recurring window from tomorrow's — the same window fires again every
   * day it's scheduled, and each day's run should be its own completion.
   *
   * @param previousSnapshot [{ id, dateKey, window }] — from the prior tick's nextSnapshot
   * @param currentActiveFocusWindows Window[] — activeWindows(profile, now).filter(FOCUS)
   * @param now Date
   * @returns { completed: [{ id, dateKey, window }], nextSnapshot: [{ id, dateKey, window }] }
   */
  function detectCompletedFocusWindows(previousSnapshot, currentActiveFocusWindows, now) {
    const todayKey = dateKey(now);
    const currentKeys = new Set(currentActiveFocusWindows.map((w) => `${todayKey}:${w.id}`));
    const completed = (previousSnapshot || []).filter((prev) => !currentKeys.has(`${prev.dateKey}:${prev.id}`));
    const nextSnapshot = currentActiveFocusWindows.map((w) => ({ id: w.id, dateKey: todayKey, window: w }));
    return { completed, nextSnapshot };
  }

  // ── sync ──────────────────────────────────────────────────────────────────

  /**
   * Merge a REMOTE work profile (pulled from Firestore) into the LOCAL one. Plain
   * last-write-wins by `updatedAt`, with ONE anti-cheat override: a remote write may not
   * LOOSEN a focus window that is live on THIS device right now — otherwise a second
   * signed-in device becomes a way to unlock a lockdown. A loosening remote update is
   * simply deferred; once the window ends `validateEdit` passes and the newer remote
   * applies on the next sync (self-healing, no data lost).
   *
   * @returns { profile, changed }
   */
  function mergeRemote(local, remote, date) {
    const localAt = (local && local.updatedAt) || 0;
    const remoteAt = (remote && remote.updatedAt) || 0;
    if (!remote || remoteAt <= localAt) return { profile: local, changed: false };
    if (!validateEdit(local, remote, date).allowed) return { profile: local, changed: false };
    return { profile: remote, changed: true };
  }

  return {
    MODE_FOCUS, MODE_LIGHT, MODE_NONE,
    normalizeDomain, dateKey, dayKey, minutesOfDay, parseHM, isValidWindow,
    scheduleForDate, activeWindows, effectiveBlock, isLocked, validateEdit, focusBonusPoints,
    detectCompletedFocusWindows, mergeRemote,
  };
});
