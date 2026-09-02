/**
 * Owner WhatsApp recipients (digits only, country code, no +).
 *
 * Three-tier model:
 *
 *   OWNER_PHONE_<NAME>       → GENERAL owner. Notified for every repair ticket,
 *                              and for corporate leads unless the override
 *                              below is set. Vedant, Vatsal live here.
 *
 *   BRANCH_OWNER_<SLUG>      → BRANCH-ONLY owner. Notified ONLY for repair
 *                              tickets whose store slug matches this key.
 *                              Nilesh lives at BRANCH_OWNER_SURSAGAR.
 *                              Value may be a single number or comma-separated.
 *
 *   CORPORATE_OWNER_PHONES   → BULK-ONLY list. When set it REPLACES the general
 *                              list for corporate/bulk-order leads — it does not
 *                              add to it. A general owner left out of this var
 *                              stops receiving bulk alerts but keeps receiving
 *                              repair alerts. Comma-separated.
 *
 * Rules:
 *   - Corporate leads → getRecipientsForCorporate() → CORPORATE_OWNER_PHONES
 *                       if set, otherwise general only.
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
 *
 * CORPORATE_OWNER_PHONES overrides the general list entirely when set, so bulk
 * enquiries can go to the two people who actually quote them without also
 * having to leave those numbers on every repair ticket. Unset falls back to
 * the general owners, which is the historical behaviour.
 * @returns {string[]}
 */
function getRecipientsForCorporate() {
  const explicit = splitAndClean(process.env.CORPORATE_OWNER_PHONES);
  if (!explicit.length) return getGeneralOwnerPhones();

  const seen = new Set();
  const out = [];
  for (const p of explicit) {
    if (!seen.has(p)) { seen.add(p); out.push(p); }
  }
  return out;
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

module.exports = {
  getGeneralOwnerPhones,
  getBranchOwnerPhones,
  getRecipientsForRepair,
  getRecipientsForCorporate,
  getRecipientsForStore,
  branchSlugFromStoreHint,
};
