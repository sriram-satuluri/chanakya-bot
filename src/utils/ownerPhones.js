/**
 * Owner WhatsApp recipients (digits only, country code, no +).
 *
 * New repair ticket:
 *   Alkapuri  → Vatsal + Vedant
 *   Sursagar  → Vatsal + Nilesh
 * Corporate / bulk lead:
 *   Vatsal + Vedant + Nilesh
 *
 *   OWNER_PHONE_VATSAL       → every repair ticket, and corporate leads
 *   OWNER_PHONE_VEDANT       → Alkapuri repairs + every corporate lead.
 *                              Not Sursagar repairs.
 *   OWNER_PHONE_NILESH       → Sursagar repairs + corporate leads.
 *                              Not Alkapuri repairs.
 *   BRANCH_OWNER_SURSAGAR    → Nilesh, when OWNER_PHONE_NILESH is unset.
 *                              Sursagar repairs only. Added to corporate
 *                              leads when CORPORATE_OWNER_PHONES is unset.
 *   BRANCH_OWNER_ALKAPURI    → extra Alkapuri-only recipients.
 *   CORPORATE_OWNER_PHONES   → when set, this is the corporate list, and
 *                              Vedant (OWNER_PHONE_VEDANT) is still added
 *                              if he is not already on it.
 *
 * Any other OWNER_PHONE_<NAME> is treated like Vatsal (every repair +
 * corporate, unless the corporate override is set).
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

function ownerEnvName(envKey) {
  const m = /^OWNER_PHONE_([A-Z0-9_]+)$/.exec(envKey);
  return m ? m[1] : null;
}

/** Vedant hears Alkapuri repairs and corporate leads, not Sursagar repairs. */
function isVedantOwner(name) {
  return name === 'VEDANT' || name.startsWith('VEDANT_');
}

/** Nilesh hears Sursagar repairs and corporate leads, not Alkapuri repairs. */
function isNileshOwner(name) {
  return name === 'NILESH' || name.startsWith('NILESH_');
}

function addPhones(out, seen, phones) {
  for (const p of phones) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
}

/**
 * Who hears about a new repair ticket.
 *   alkapuri → Vatsal + Vedant (+ BRANCH_OWNER_ALKAPURI)
 *   sursagar → Vatsal + Nilesh (BRANCH_OWNER_SURSAGAR / OWNER_PHONE_NILESH)
 * @param {string} branchSlug
 * @returns {string[]}
 */
function getRecipientsForRepair(branchSlug) {
  const seen = new Set();
  const out = [];
  for (const [key, raw] of Object.entries(process.env)) {
    const name = ownerEnvName(key);
    if (!name) continue;
    if (branchSlug === 'sursagar' && isVedantOwner(name)) continue;
    if (branchSlug !== 'sursagar' && isNileshOwner(name)) continue;
    addPhones(out, seen, splitAndClean(raw));
  }
  addPhones(out, seen, getBranchOwnerPhones(branchSlug));
  return out;
}

/**
 * Corporate and bulk-order leads: Vatsal, Vedant, and Nilesh.
 *
 * CORPORATE_OWNER_PHONES, when set, is the base list (so the numbers already
 * chosen for quoting stay). Vedant is still added from OWNER_PHONE_VEDANT
 * when that list left him out. Unset falls back to every general owner plus
 * the Sursagar branch line (Nilesh).
 * @returns {string[]}
 */
function getRecipientsForCorporate() {
  const seen = new Set();
  const out = [];
  const explicit = splitAndClean(process.env.CORPORATE_OWNER_PHONES);
  if (explicit.length) {
    addPhones(out, seen, explicit);
  } else {
    addPhones(out, seen, getGeneralOwnerPhones());
    addPhones(out, seen, getBranchOwnerPhones('sursagar'));
  }
  for (const [key, raw] of Object.entries(process.env)) {
    const name = ownerEnvName(key);
    if (!name || !isVedantOwner(name)) continue;
    addPhones(out, seen, splitAndClean(raw));
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
 * Vatsal is always notified. Vedant is added except for a Sursagar repair.
 * Nilesh (BRANCH_OWNER_SURSAGAR) is added only when the store is Sursagar.
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
