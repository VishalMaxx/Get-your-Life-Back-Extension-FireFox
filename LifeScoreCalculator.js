// LifeScoreCalculator.js
// Enterprise-grade UMD module. Compatible with Vitest/Node.js and MV3 Chrome Service Worker importScripts().
(function (root, factory) {
  if (typeof exports === 'object' && typeof module === 'object') {
    module.exports = factory();
  } else {
    root.LifeScoreCalculator = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  
  const DEFAULT_WEIGHTS = {
    sovereigntyStart: 100.0,
    complianceStart: 65.0,
    clarityBaseline: 50.0,

    inactivityGraceDays: 2,
    inactivityEarnedLossPerDay: 0.02,
    inactivityMinimumEarnedRetention: 0.25,

    complyComplianceGain: 2.0,
    weakComplyComplianceGain: 0.5,
    bypassComplianceLoss: 1.0,
    scheduledHeldComplianceGain: 2.0,

    clarityLifetimeScale: 15.0,
    clarityRecentScale: 3.0,
    clarityLifetimeBypassWeight: 1.0,
    claritySelfBlockUnitPer30Min: 1.0,

    sovComplyGain: 3.0,
    sovWeakComplyGain: 1.0,
    sovBypassLoss: 2.0,
    sovScheduledHeldGain: 3.0,
    sovProtocolDayGain: 10.0,
    sovProtocolCompleteGain: 50.0,
    sovEngagedDayGain: 2.0,
    blockCommitComplianceGainPerMin: 0.5,
    blockCommitSovereigntyGainPerMin: 0.25,

    streakMilestones: [3, 7, 14, 30, 60, 100],
    streakMilestoneBonus: 25.0,
    streakBonusScale: 9.6,

    skipShortSovereigntyLoss: 1.0,
    blockCommitMaxMinutes: 300,

    sovereigntyLevelThresholds: [
      100, 175, 275, 400, 550, 725, 925, 1150, 1400, 1675, 1975, 2300, 2650, 3025, 3425
    ]
  };

  const LifeScoreCalculator = {
    /**
     * Compute Sovereignty, Compliance, and Clarity scores from raw behavioral signals.
     * Implements identical logic to com.siriuscorp.corepil.domain.scoring.LifeScoreCalculator.
     * 
     * @param {Object} signals 
     * @param {Object} [customWeights] 
     * @returns {Object} LifeScores { sovereignty, compliance, clarity }
     */
    compute(signals, customWeights) {
      const weights = { ...DEFAULT_WEIGHTS, ...customWeights };

      const sanitize = (v) => Math.max(0, Number(v) || 0);

      const complyCount = sanitize(signals.complyCount);
      const bypassCount = sanitize(signals.bypassCount);
      const weakComplyCount = sanitize(signals.weakComplyCount);
      const completedProtocolDays = sanitize(signals.completedProtocolDays);
      const protocolsCompleted = sanitize(signals.protocolsCompleted);
      const currentStreakDays = sanitize(signals.currentStreakDays);
      const longestStreakDays = sanitize(signals.longestStreakDays);
      const scheduledHeldDays = sanitize(signals.scheduledHeldDays);
      const engagedDays = sanitize(signals.engagedDays);
      const selfBlockMinutes = sanitize(signals.selfBlockMinutes);
      const recentResist = sanitize(signals.recentResist);
      const recentRelapse = sanitize(signals.recentRelapse);
      const inactivityDays = sanitize(signals.inactivityDays);
      const skipShortPenaltyUnits = sanitize(signals.skipShortPenaltyUnits);

      // Split complies into strong vs weak (weak = complied then caved on the same app/domain)
      const weak = Math.max(0, Math.min(weakComplyCount, complyCount));
      const strong = complyCount - weak;

      // ── COMPLIANCE ──
      const rawCompliance = 
        weights.complianceStart +
        weights.complyComplianceGain * strong +
        weights.weakComplyComplianceGain * weak -
        weights.bypassComplianceLoss * bypassCount +
        weights.scheduledHeldComplianceGain * scheduledHeldDays +
        weights.blockCommitComplianceGainPerMin * selfBlockMinutes;
      const complianceBeforeDecay = Math.max(0.0, rawCompliance);

      // ── CLARITY ──
      const selfBlockUnits = (selfBlockMinutes / 30.0) * weights.claritySelfBlockUnitPer30Min;
      const lifetimeResistNet = Math.max(
        0.0,
        complyCount + scheduledHeldDays + selfBlockUnits - weights.clarityLifetimeBypassWeight * bypassCount
      );
      const clarity = Math.max(
        0.0,
        weights.clarityBaseline +
        weights.clarityLifetimeScale * Math.log(1.0 + lifetimeResistNet) +
        weights.clarityRecentScale * (recentResist - recentRelapse)
      );

      // ── SOVEREIGNTY ──
      const bankedEarned =
        weights.sovComplyGain * strong +
        weights.sovWeakComplyGain * weak -
        weights.sovBypassLoss * bypassCount +
        weights.sovScheduledHeldGain * scheduledHeldDays +
        weights.sovProtocolDayGain * completedProtocolDays +
        weights.sovProtocolCompleteGain * protocolsCompleted +
        weights.sovEngagedDayGain * engagedDays +
        weights.blockCommitSovereigntyGainPerMin * selfBlockMinutes -
        weights.skipShortSovereigntyLoss * skipShortPenaltyUnits;

      const milestonesReached = weights.streakMilestones.filter(m => m <= longestStreakDays).length;
      const milestoneBonus = weights.streakMilestoneBonus * milestonesReached;
      const liveStreakBonus = weights.streakBonusScale * Math.log(1.0 + currentStreakDays);

      const sovereigntyBeforeInactivity = Math.max(
        0.0,
        weights.sovereigntyStart + bankedEarned + milestoneBonus + liveStreakBonus
      );

      // ── INACTIVITY DECAY ──
      const decayDays = Math.max(0, inactivityDays - weights.inactivityGraceDays);
      const earnedRetention = Math.max(
        weights.inactivityMinimumEarnedRetention,
        1.0 - decayDays * weights.inactivityEarnedLossPerDay
      );

      function decayEarned(score, baseline) {
        if (score > baseline) {
          return baseline + (score - baseline) * earnedRetention;
        }
        return score;
      }

      const sovereigntyVal = decayEarned(sovereigntyBeforeInactivity, weights.sovereigntyStart);
      const complianceVal = decayEarned(complianceBeforeDecay, weights.complianceStart);

      return {
        sovereignty: Math.round(sovereigntyVal),
        compliance: Math.round(complianceVal),
        clarity: Math.round(clarity)
      };
    },

    /**
     * Compute Sovereignty Level metadata for UI feedback display.
     * 
     * @param {number} sovereignty 
     * @param {Object} [customWeights] 
     * @returns {Object} { level, levelFloor, nextThreshold, progressToNext }
     */
    levelFor(sovereignty, customWeights) {
      const weights = { ...DEFAULT_WEIGHTS, ...customWeights };
      const thresholds = weights.sovereigntyLevelThresholds;

      if (!thresholds || thresholds.length === 0) {
        return { level: 1, levelFloor: 0, nextThreshold: null, progressToNext: 1.0 };
      }

      const reached = thresholds.filter(t => t <= sovereignty).length;

      if (reached === 0) {
        const first = thresholds[0];
        return {
          level: 1,
          levelFloor: 0,
          nextThreshold: first,
          progressToNext: Math.min(1.0, Math.max(0.0, sovereignty / first))
        };
      }

      const levelFloor = thresholds[reached - 1];
      const nextThreshold = reached < thresholds.length ? thresholds[reached] : null;
      
      let progress = 1.0;
      if (nextThreshold !== null) {
        progress = Math.min(1.0, Math.max(0.0, (sovereignty - levelFloor) / (nextThreshold - levelFloor)));
      }

      return {
        level: reached,
        levelFloor,
        nextThreshold,
        progressToNext: progress
      };
    }
  };

  return LifeScoreCalculator;
});
