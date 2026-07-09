// EngagementSignalCalculator.js
// Enterprise-grade UMD module. Compatible with Vitest/Node.js and MV3 Chrome Service Worker importScripts().
(function (root, factory) {
  if (typeof exports === 'object' && typeof module === 'object') {
    module.exports = factory();
  } else {
    root.EngagementSignalCalculator = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {

  const DEFAULT_GRACE_DAYS = 1;

  function parseDate(token) {
    const parts = token.split('-');
    if (parts.length !== 3) return null;
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1; // 0-indexed
    const day = parseInt(parts[2], 10);
    const date = new Date(Date.UTC(year, month, day));
    if (isNaN(date.getTime())) return null;
    return date;
  }

  function getDaysBetween(date1, date2) {
    const diffMs = date2.getTime() - date1.getTime();
    return Math.round(diffMs / (24 * 60 * 60 * 1000));
  }

  const EngagementSignalCalculator = {
    /**
     * Parse string tokens and calculate inactivity days.
     */
    inactivityDays(dayTokens, cutoffDateStr) {
      const cutoffDate = parseDate(cutoffDateStr);
      if (!cutoffDate) return 0;

      const tokensArray = Array.from(dayTokens);
      let latest = null;

      for (const t of tokensArray) {
        const d = parseDate(t);
        if (d && d <= cutoffDate) {
          if (!latest || d > latest) {
            latest = d;
          }
        }
      }

      if (!latest) return 0;
      return Math.max(0, getDaysBetween(latest, cutoffDate));
    },

    /**
     * Compute engagedDays, currentStreakDays, and longestStreakDays.
     * 
     * @param {Array|Set} dayTokens Set of string tokens "YYYY-MM-DD".
     * @param {string} cutoffDateStr Local ISO date string "YYYY-MM-DD" of cutoff.
     * @param {number} [graceDays] Missed days tolerance (default 1).
     */
    compute(dayTokens, cutoffDateStr, graceDays = DEFAULT_GRACE_DAYS) {
      const cutoffDate = parseDate(cutoffDateStr);
      if (!cutoffDate) {
        return { engagedDays: 0, currentStreakDays: 0, longestStreakDays: 0 };
      }

      const tokensArray = Array.from(dayTokens);
      const parsedDates = [];

      for (const t of tokensArray) {
        const d = parseDate(t);
        if (d && d <= cutoffDate) {
          parsedDates.push(d);
        }
      }

      if (parsedDates.length === 0) {
        return { engagedDays: 0, currentStreakDays: 0, longestStreakDays: 0 };
      }

      // Deduplicate by formatting back to string and keeping unique dates
      const uniqueMap = {};
      parsedDates.forEach(d => {
        const key = d.toISOString().split('T')[0];
        uniqueMap[key] = d;
      });

      const dates = Object.values(uniqueMap).sort((a, b) => a - b);
      if (dates.length === 0) {
        return { engagedDays: 0, currentStreakDays: 0, longestStreakDays: 0 };
      }

      const engagedDays = dates.length;
      const maxGap = graceDays + 1;

      // ── Longest run ever ────────────────────────────────────────────────────
      let longest = 1;
      let run = 1;
      for (let i = 1; i < dates.length; i++) {
        const gap = getDaysBetween(dates[i - 1], dates[i]);
        run = (gap >= 1 && gap <= maxGap) ? run + 1 : 1;
        if (run > longest) {
          longest = run;
        }
      }

      // ── Current run ─────────────────────────────────────────────────────────
      const gapToCutoff = getDaysBetween(dates[dates.length - 1], cutoffDate);
      let current = 0;
      if (gapToCutoff <= graceDays) {
        current = 1;
        for (let i = dates.length - 1; i >= 1; i--) {
          const gap = getDaysBetween(dates[i - 1], dates[i]);
          if (gap >= 1 && gap <= maxGap) {
            current++;
          } else {
            break;
          }
        }
      }

      return {
        engagedDays,
        currentStreakDays: current,
        longestStreakDays: longest
      };
    }
  };

  return EngagementSignalCalculator;
});
