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
  getOwnerPhoneNumbers, // deprecated
};
