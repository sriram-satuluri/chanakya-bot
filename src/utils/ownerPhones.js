/**
 * Owner WhatsApp recipients (digits only, country code, no +).
 *
 * Two-tier model:
 *
 *   OWNER_PHONE_<NAME>       → GENERAL owner. Notified for every alert
 *                              (all repair tickets + all corporate leads).
 *                              Vedant, Vatsal live here.
 *
 *   BRANCH_OWNER_<SLUG>      → BRANCH-ONLY owner. Notified ONLY for repair
 *                              tickets whose store slug matches this key.
 *                              Nilesh lives at BRANCH_OWNER_SURSAGAR.
 *                              Value may be a single number or comma-separated.
 *
 * Rules:
 *   - Corporate leads → getRecipientsForCorporate() → general only.
 *   - Repair tickets  → getRecipientsForRepair(branchSlug) → general + that branch.
 *   - Store-location flow  → no notification (informational).
 */

function cleanPhone(raw) {
  return String(raw || '').trim().replace(/^\+/, '');
}
function isValidPhone(x) {
  return /^\d{6,15}$/.test(x);
}
function splitAndClean(rawCommaList) {
  return String(rawCommaList || '')
    .split(',')
    .map(cleanPhone)
    .filter(isValidPhone);
}

/**
 * General owners — notified for every alert regardless of branch.
 * @returns {string[]}
 */
function getGeneralOwnerPhones() {
  const seen = new Set();
  const out = [];
  for (const [key, raw] of Object.entries(process.env)) {
    if (!/^OWNER_PHONE_[A-Z0-9_]+$/.test(key)) continue;
    for (const cleaned of splitAndClean(raw)) {
      if (seen.has(cleaned)) continue;
      seen.add(cleaned);
      out.push(cleaned);
    }
  }
  return out;
}

/**
 * Extra recipients that get pinged ONLY for their own branch.
 * @param {string} branchSlug — e.g. 'alkapuri' or 'sursagar'
 * @returns {string[]}
 */
function getBranchOwnerPhones(branchSlug) {
  if (!branchSlug) return [];
  const key = `BRANCH_OWNER_${String(branchSlug).toUpperCase()}`;
  return splitAndClean(process.env[key]);
}

/**
 * Union of general + branch-specific owners for a repair-ticket alert.
 * Deduplicates. Order is stable: general first, then branch-only extras.
 * @param {string} branchSlug
 * @returns {string[]}
 */
function getRecipientsForRepair(branchSlug) {
  const seen = new Set();
  const out = [];
  for (const p of getGeneralOwnerPhones()) {
    if (!seen.has(p)) { seen.add(p); out.push(p); }
  }
  for (const p of getBranchOwnerPhones(branchSlug)) {
    if (!seen.has(p)) { seen.add(p); out.push(p); }
  }
  return out;
}

/**
 * Recipients for corporate / bulk-order lead alerts. Branch-only owners are
 * intentionally excluded — corporate enquiries aren't tied to a store.
 * @returns {string[]}
 */
function getRecipientsForCorporate() {
  return getGeneralOwnerPhones();
}

/**
 * Resolve any reference to a store into a branch slug.
 *
 * Callers hold a store in several shapes depending on where it came from:
 *   - a flow button id      'store_sursagar'
 *   - a sheet store name    'Sursagar (Opp. Pratap Talkies)'
 *   - a bare slug           'sursagar'
 * Substring matching handles all three, and also survives staff retyping the
 * store cell slightly differently by hand.
 *
 * @returns {'alkapuri'|'sursagar'|null} null when there is no store context
 */
function branchSlugFromStoreHint(hint) {
  const s = String(hint ?? '').toLowerCase();
  if (!s.trim()) return null;
  if (s.includes('sursagar')) return 'sursagar';
  if (s.includes('alkapuri')) return 'alkapuri';
  return null;
}

/**
 * THE shared "who should hear about this?" helper for anything tied to a store.
 *
 * General owners (Vedant, Vatsal) are always notified. A branch-only owner
 * (Nilesh on BRANCH_OWNER_SURSAGAR) is added ONLY when the store context
 * actually resolves to their branch.
 *
 * Unknown or absent store context deliberately falls back to general owners
 * only — we never guess a branch owner in. Being pinged about something that
 * turns out not to be your branch is a small annoyance; being pinged about
 * every general enquiry because the code guessed is how people start ignoring
 * the alerts entirely.
 *
 * @param {string|null|undefined} storeHint button id, sheet store name, or slug
 * @returns {string[]} deduped, general owners first
 */
function getRecipientsForStore(storeHint) {
  const slug = branchSlugFromStoreHint(storeHint);
  return slug ? getRecipientsForRepair(slug) : getGeneralOwnerPhones();
}

/**
 * @deprecated Superseded by getRecipientsForRepair(branchSlug) and
 * getRecipientsForCorporate(). Kept temporarily so any external caller doesn't
 * break — currently mirrors the general list (the safe default).
 */
function getOwnerPhoneNumbers() {
  return getGeneralOwnerPhones();
}

module.exports = {
  getGeneralOwnerPhones,
  getBranchOwnerPhones,
  getRecipientsForRepair,
  getRecipientsForCorporate,
  getRecipientsForStore,
  branchSlugFromStoreHint,
  getOwnerPhoneNumbers, // deprecated
};
