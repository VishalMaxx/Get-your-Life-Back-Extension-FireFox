// InterventionSignalAggregator.js
// Enterprise-grade UMD module. Compatible with Vitest/Node.js and MV3 Chrome Service Worker importScripts().
(function (root, factory) {
  if (typeof exports === 'object' && typeof module === 'object') {
    module.exports = factory();
  } else {
    root.InterventionSignalAggregator = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {

  const DEFAULT_WEAK_COMPLY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
  const DEFAULT_COMPLY_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

  const DEFAULT_CLARITY_WEIGHTING = {
    halfLifeDays: 14.0,
    complyWeight: 1.0,
    scheduledComplyWeight: 1.0,
    selfBlockUnitPer30Min: 1.0,
    selfBlockUnitCap: 3.0,
    bypassWeight: 4.0,
    bypassUnitPer10Min: 1.0,
    bypassUnitFloor: 0.5,
    bypassUnitCap: 3.0
  };

  const DEFAULT_SKIP_WEIGHTING = {
    shortSkipMaxMinutes: 30,
    escalationWindowMs: 7 * 24 * 60 * 60 * 1000, // 7 days
    growth: 2.0,
    maxMultiplier: 16.0,
    clarityUnitPerShortSkip: 0.5
  };

  /**
   * Helper to format millisecond timestamp to local date string (YYYY-MM-DD) for a specific timezone
   */
  function getLocalDateString(timestampMs, timeZone) {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timeZone || 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      const parts = formatter.formatToParts(new Date(timestampMs));
      const year = parts.find(p => p.type === 'year').value;
      const month = parts.find(p => p.type === 'month').value;
      const day = parts.find(p => p.type === 'day').value;
      return `${year}-${month}-${day}`;
    } catch (e) {
      // Fallback to UTC date string if timezone formatting fails
      const date = new Date(timestampMs);
      const yyyy = date.getUTCFullYear();
      const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(date.getUTCDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    }
  }

  // `origin` is the Android BlockOrigin enum NAME (a plain string: "PER_APP",
  // "SELF_BLOCK", "SCHEDULED_BYPASSABLE", "SCHEDULED_STRICT") — that's the actual shape
  // synced from Firestore. A legacy object shape ({isScheduledWindow: bool}) is also
  // tolerated defensively, in case any already-recorded local events predate the fix that
  // made background.js write the string form.
  function isScheduledWindowOrigin(origin) {
    if (!origin) return false;
    if (typeof origin === 'string') return origin === 'SCHEDULED_BYPASSABLE' || origin === 'SCHEDULED_STRICT';
    if (typeof origin === 'object') return !!origin.isScheduledWindow;
    return false;
  }

  const InterventionSignalAggregator = {
    /**
     * Compute exponential skip multiplier based on prior short skips count.
     */
    escalationMultiplier(priorShortSkipsInWindow, customSkipWeights) {
      const skip = { ...DEFAULT_SKIP_WEIGHTING, ...customSkipWeights };
      const prior = Math.max(0, priorShortSkipsInWindow);
      return Math.min(skip.maxMultiplier, Math.pow(skip.growth, prior));
    },

    /**
     * Aggregate list of raw events into structured scoring signals.
     * 
     * @param {Array} events Ascending-ordered array of InterventionEvent objects.
     * @param {number} untilMs Exclusive upper bound millisecond timestamp.
     * @param {string} [timeZone] Target timezone for calendar bucketing (defaults to UTC).
     * @param {Object} [options] Custom configurations.
     * @returns {Object} Aggregates signals list.
     */
    aggregate(events, untilMs, timeZone = 'UTC', options = {}) {
      const weakComplyWindowMs = options.weakComplyWindowMs || DEFAULT_WEAK_COMPLY_WINDOW_MS;
      const complyRateLimitWindowMs = options.complyRateLimitWindowMs || DEFAULT_COMPLY_RATE_LIMIT_WINDOW_MS;
      
      const clarity = { ...DEFAULT_CLARITY_WEIGHTING, ...options.clarity };
      const skip = { ...DEFAULT_SKIP_WEIGHTING, ...options.skip };

      const halfLifeMs = clarity.halfLifeDays * 24 * 60 * 60 * 1000.0;

      // Recency factor function
      function recency(t) {
        return Math.pow(0.5, (untilMs - t) / halfLifeMs);
      }

      // Filter events to exclude anything after untilMs, and keep only engagement-related types
      const isEngagementType = (type) => type === 'COMPLY' || type === 'BYPASS' || type === 'SELF_BLOCK';
      const windowEvents = events.filter(e => e.timestamp < untilMs && isEngagementType(e.type));

      // Anti-comply rate limiting array
      const counted = new Array(windowEvents.length).fill(false);
      const lastCountedComplyAtByPkg = {};

      let complyCount = 0;
      let bypassCount = 0;
      let selfBlockMinutes = 0;
      let recentResist = 0.0;
      let recentRelapse = 0.0;

      // First pass: Process Comply, Bypass, and Self-Block events
      for (let i = 0; i < windowEvents.length; i++) {
        const e = windowEvents[i];
        if (e.type === 'COMPLY') {
          // Exclude pre-scheduled windows from direct comply points
          if (!isScheduledWindowOrigin(e.origin)) {
            const last = lastCountedComplyAtByPkg[e.packageName];
            if (last === undefined || (e.timestamp - last) >= complyRateLimitWindowMs) {
              counted[i] = true;
              lastCountedComplyAtByPkg[e.packageName] = e.timestamp;
              complyCount++;
              recentResist += recency(e.timestamp) * clarity.complyWeight;
            }
          }
        } else if (e.type === 'BYPASS') {
          bypassCount++;
          const dialedMinutes = e.magnitude;
          let severity = clarity.bypassWeight;
          if (dialedMinutes !== undefined && dialedMinutes !== null && dialedMinutes > 0) {
            severity = Math.min(
              clarity.bypassUnitCap,
              Math.max(clarity.bypassUnitFloor, (dialedMinutes / 10.0) * clarity.bypassUnitPer10Min)
            );
          }
          recentRelapse += recency(e.timestamp) * severity;
        } else if (e.type === 'SELF_BLOCK') {
          const minutes = e.magnitude || 0;
          const completesAt = e.timestamp + minutes * 60 * 1000;
          if (completesAt <= untilMs) {
            selfBlockMinutes += minutes;
            const units = Math.min(clarity.selfBlockUnitCap, (minutes / 30.0) * clarity.selfBlockUnitPer30Min);
            recentResist += recency(completesAt) * units;
          }
        }
      }

      // Group events by calendar date to calculate cleanDays
      const dayGroups = {};
      windowEvents.forEach(e => {
        const dateStr = getLocalDateString(e.timestamp, timeZone);
        if (!dayGroups[dateStr]) {
          dayGroups[dateStr] = [];
        }
        dayGroups[dateStr].push(e);
      });

      let cleanDays = 0;
      Object.keys(dayGroups).forEach(day => {
        const dayEvents = dayGroups[day];
        const hasBypass = dayEvents.some(e => e.type === 'BYPASS');
        if (!hasBypass) {
          cleanDays++;
        }
      });

      // Weak complies analysis
      let weakComplyCount = 0;
      for (let i = 0; i < windowEvents.length; i++) {
        if (!counted[i]) continue;
        const e = windowEvents[i]; // always COMPLY
        let j = i + 1;
        while (j < windowEvents.length && (windowEvents[j].timestamp - e.timestamp) <= weakComplyWindowMs) {
          const later = windowEvents[j];
          if (later.type === 'BYPASS' && later.packageName === e.packageName) {
            weakComplyCount++;
            break;
          }
          j++;
        }
      }

      // Scheduled-held days analysis
      const heldDays = new Set();
      Object.keys(dayGroups).forEach(day => {
        const dayEvents = dayGroups[day];
        const faced = dayEvents.some(e => e.type === 'COMPLY' && isScheduledWindowOrigin(e.origin));
        const caved = dayEvents.some(e => e.type === 'BYPASS' && isScheduledWindowOrigin(e.origin));
        if (faced && !caved) {
          heldDays.add(day);
        }
      });
      const scheduledHeldDays = heldDays.size;

      // Add scheduled complies on held days to recentResist
      windowEvents.forEach(e => {
        if (e.type === 'COMPLY' && isScheduledWindowOrigin(e.origin)) {
          const day = getLocalDateString(e.timestamp, timeZone);
          if (heldDays.has(day)) {
            recentResist += recency(e.timestamp) * clarity.scheduledComplyWeight;
          }
        }
      });

      // Short-skip escalation multiplier sum
      let skipShortPenaltyUnits = 0.0;
      const shortSkipTimes = [];
      events.forEach(e => {
        if (e.timestamp >= untilMs || e.type !== 'SKIP') return;
        const minutes = e.magnitude;
        if (minutes === undefined || minutes === null || minutes < 1 || minutes > skip.shortSkipMaxMinutes) return;
        
        const prior = shortSkipTimes.filter(t => (e.timestamp - t) <= skip.escalationWindowMs).length;
        const multiplier = InterventionSignalAggregator.escalationMultiplier(prior, skip);
        
        skipShortPenaltyUnits += multiplier;
        recentRelapse += recency(e.timestamp) * skip.clarityUnitPerShortSkip * multiplier;
        shortSkipTimes.push(e.timestamp);
      });

      return {
        complyCount,
        bypassCount,
        cleanDays,
        weakComplyCount,
        selfBlockMinutes,
        scheduledHeldDays,
        recentResist,
        recentRelapse,
        skipShortPenaltyUnits
      };
    }
  };

  return InterventionSignalAggregator;
});
