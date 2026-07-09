// WebEntitlementEngine.js
// Enterprise-grade UMD module. Compatible with Node.js (node --test) and the MV3
// Chrome Service Worker via importScripts().
//
// WHAT THIS IS
// The pure decision core for Phase 4 (checkout + entitlement). It does NOT make network
// calls or touch chrome.* APIs — background.js owns the fetch/chrome.tabs glue and calls
// into this module for every decision that can be reasoned about in isolation, so those
// decisions are exhaustively unit-testable.
//
// ARCHITECTURE (mirrors the Android app's existing web-entitlement bridge exactly, per
// EXTENSION_ARCHITECTURE_PLAN.md §4.6 and app/.../billing/WebEntitlementApi.kt +
// data/sync/SyncOrchestrator.kt — same backend, second client):
//   - `POST {WEB_ENTITLEMENT_BASE_URL}/api/entitlement/link`, `Authorization: Bearer
//     <firebase-id-token>`, no body. Returns `{active, plan, expiresAt, subscriptionId}`.
//     Requires a verified email server-side (403 otherwise). This is what tells us if a
//     signed-in user's Dodo purchase is currently active.
//   - `POST {WEB_ENTITLEMENT_BASE_URL}/api/checkout`, no auth header, body
//     `{email, productId}`. Returns `{url}` — a one-time Dodo-hosted checkout session URL
//     minted server-side (the website does the same thing in CheckoutForm.astro). There is
//     NO raw "https://checkout.dodopayments.com/buy/<id>" URL format anywhere in the
//     codebase to mirror — this endpoint is the actual, working mechanism.
//   - Same trigger cadence as Android's SyncOrchestrator: an entitlement re-check fires on
//     sign-in, on "foreground" (extension-equivalent: service worker startup + the existing
//     5-minute sync_pull alarm), after a checkout tab closes, and on manual refresh. A
//     60-second debounce (FOREGROUND_DEBOUNCE_MS, same constant Android uses) prevents the
//     periodic/foreground trigger from hammering the endpoint; explicit triggers (sign-in,
//     manual, checkout-return) always bypass the debounce.
//
// PRODUCT ID MAPPING — the "Extension Pro" tier only (Full Suite ships after the Android
// app, per BACKEND_HANDOFF.md §2 — its pricing UI is dormant, not wired here).

(function (root, factory) {
  if (typeof exports === 'object' && typeof module === 'object') {
    module.exports = factory();
  } else {
    root.WebEntitlementEngine = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {

  const WEB_ENTITLEMENT_BASE_URL = 'https://getyourlifeback.app';
  const LINK_PATH = '/api/entitlement/link';
  const CHECKOUT_PATH = '/api/checkout';

  const FOREGROUND_DEBOUNCE_MS = 60 * 1000; // same constant Android's SyncOrchestrator uses

  const PRODUCT_ID_MONTHLY = 'pdt_0NiRkVTroXu4L4t010Pqw';
  const PRODUCT_ID_YEARLY = 'pdt_0NiRkVAplRMb838k4PBlm';

  const REASON_SIGN_IN = 'sign-in';
  const REASON_FOREGROUND = 'foreground';
  const REASON_MANUAL = 'manual';
  const REASON_CHECKOUT_RETURN = 'checkout-return';

  const TIER_FREE = 'free';
  const TIER_EXTENSION_PRO = 'extension_pro';

  // Always-bypass-debounce reasons — explicit user/lifecycle actions where a stale answer
  // would be actively wrong (e.g. showing "free" for two seconds right after paying).
  const ALWAYS_CHECK_REASONS = [REASON_SIGN_IN, REASON_MANUAL, REASON_CHECKOUT_RETURN];

  /** Map a popup pricing-option's data-price-id to the real Dodo product id. */
  function productIdForPriceId(priceId) {
    if (priceId === 'ext_yearly') return PRODUCT_ID_YEARLY;
    return PRODUCT_ID_MONTHLY; // 'ext_monthly' and any unrecognized value default to monthly
  }

  /**
   * Should an entitlement re-check happen right now?
   * @returns boolean
   */
  function shouldCheck(reason, lastCheckedAtMs, nowMs, debounceMs) {
    if (ALWAYS_CHECK_REASONS.indexOf(reason) !== -1) return true;
    const debounce = typeof debounceMs === 'number' ? debounceMs : FOREGROUND_DEBOUNCE_MS;
    if (!lastCheckedAtMs) return true;
    return (nowMs - lastCheckedAtMs) >= debounce;
  }

  /**
   * Map the /api/entitlement/link response onto local storage fields. `active: false`
   * always resolves to the free tier — Full Suite isn't sold by the extension, so there is
   * no higher tier a web purchase could grant here.
   * @param response { active, plan, expiresAt, subscriptionId } | null
   * @returns { subscriptionTier, expiresAt, subscriptionId, plan }
   */
  function applyEntitlementResponse(response) {
    if (!response || response.active !== true) {
      return { subscriptionTier: TIER_FREE, expiresAt: null, subscriptionId: null, plan: null };
    }
    return {
      subscriptionTier: TIER_EXTENSION_PRO,
      expiresAt: response.expiresAt || null,
      subscriptionId: response.subscriptionId || null,
      plan: response.plan || null
    };
  }

  /**
   * Maps the canonical `users/{uid}/private/entitlement` Firestore doc (written server-side
   * by the Adapty and Dodo webhooks, and by the founder's manual-grant script — see
   * gylb-astro's resolveEntitlement.ts) onto the same local storage shape
   * applyEntitlementResponse used to produce. This is the actual gating source going forward;
   * `/api/entitlement/link` stays in the loop only to trigger the Worker's Dodo reconciliation.
   *
   * Both "pro" and "max" doc tiers map to TIER_EXTENSION_PRO — the extension doesn't sell or
   * gate on a Max-specific tier yet.
   *
   * MANUAL-GRANT EXPIRY (mirrors the Android app's FirestoreEntitlementRepository): an expired
   * manual grant resolves to free rather than falling through to the doc's own tier/active
   * fields — those are part of the same now-expired write and would make the expiry check a
   * no-op until the Worker's next reconciliation pass rewrites the doc.
   * @param data the doc's field map, or null if the doc doesn't exist
   * @param nowMs defaults to Date.now()
   * @returns { subscriptionTier, expiresAt, subscriptionId, plan }
   */
  function applyEntitlementDoc(data, nowMs) {
    const now = typeof nowMs === 'number' ? nowMs : Date.now();
    const FREE_RESULT = { subscriptionTier: TIER_FREE, expiresAt: null, subscriptionId: null, plan: null };
    if (!data) return FREE_RESULT;

    if (data.source === 'manual') {
      const grant = data.manualGrant || null;
      const manualExpiresAtMs = grant && grant.expiresAt ? Date.parse(grant.expiresAt) : NaN;
      const manualLive = !grant || !grant.expiresAt || isNaN(manualExpiresAtMs) || manualExpiresAtMs > now;
      if (!manualLive) return FREE_RESULT; // expired — do not trust this doc's own tier/active fields
      const grantedTier = grant ? grant.grantedTier : null;
      if (grantedTier !== 'pro' && grantedTier !== 'max') return FREE_RESULT;
      return {
        subscriptionTier: TIER_EXTENSION_PRO,
        expiresAt: grant.expiresAt || null,
        subscriptionId: null,
        plan: data.plan || null,
      };
    }

    if (data.active !== true) return FREE_RESULT;
    return {
      subscriptionTier: TIER_EXTENSION_PRO,
      expiresAt: data.expiresAt || null,
      subscriptionId: data.subscriptionId || null,
      plan: data.plan || null,
    };
  }

  /** Build the /api/entitlement/link request — a bare POST, auth carries all the state. */
  function linkRequestUrl() {
    return `${WEB_ENTITLEMENT_BASE_URL}${LINK_PATH}`;
  }

  /** Build the /api/checkout request — no auth header; email + product id in the body. */
  function checkoutRequestUrl() {
    return `${WEB_ENTITLEMENT_BASE_URL}${CHECKOUT_PATH}`;
  }

  function checkoutRequestBody(email, productId) {
    return { email: (email || '').trim(), productId };
  }

  /** Is this response from /api/checkout usable (has a URL to open)? */
  function isValidCheckoutResponse(response) {
    return !!(response && typeof response.url === 'string' && response.url.length > 0);
  }

  return {
    WEB_ENTITLEMENT_BASE_URL, LINK_PATH, CHECKOUT_PATH, FOREGROUND_DEBOUNCE_MS,
    PRODUCT_ID_MONTHLY, PRODUCT_ID_YEARLY,
    REASON_SIGN_IN, REASON_FOREGROUND, REASON_MANUAL, REASON_CHECKOUT_RETURN,
    TIER_FREE, TIER_EXTENSION_PRO,
    productIdForPriceId, shouldCheck, applyEntitlementResponse, applyEntitlementDoc,
    linkRequestUrl, checkoutRequestUrl, checkoutRequestBody, isValidCheckoutResponse,
  };
});
