/**
 * Default customer-facing contact shown in bot messages.
 */

const DEFAULT_CONTACT_NAME = 'Vatsal Joshi';
/** Human-readable dialing line (shown in Markdown messages) */
const DEFAULT_CONTACT_PHONE_DISPLAY = '+91 99740 17725';

const VEDANT_LINE = '*Vedant Joshi* — +91 99745 92477';

/**
 * Nilesh Joshi — customer-facing number for the SURSAGAR branch only.
 *
 * Deliberately NOT sourced from BRANCH_OWNER_SURSAGAR: that is an internal
 * alert destination, and the published contact is a separate decision. If this
 * is ever blanked, his line is omitted entirely rather than rendering a
 * dangling name.
 */
const NILESH_PHONE_DISPLAY = '+91 99740 17727';

/**
 * Branch landline / shop line. Shown AFTER the named people, because Vatsal
 * always leads the directory.
 */
const STORE_BRANCH_PHONE = {
  alkapuri: '+91 99740 17723',
  sursagar: '+91 99740 17731',
};

function defaultCallLine() {
  return `📞 *${DEFAULT_CONTACT_NAME}:* ${DEFAULT_CONTACT_PHONE_DISPLAY}`;
}

function vatsalLine() {
  return `*${DEFAULT_CONTACT_NAME}* — ${DEFAULT_CONTACT_PHONE_DISPLAY}`;
}

function nileshLine() {
  const phone = String(NILESH_PHONE_DISPLAY || '').trim();
  return phone ? `*Nilesh Joshi* — ${phone}` : null;
}

/**
 * The people to list for a branch, in fixed order — Vatsal always first.
 *   alkapuri → Vatsal, Vedant
 *   sursagar → Vatsal, Vedant, Nilesh
 *   no branch context → Vatsal, Vedant
 * @param {'alkapuri'|'sursagar'|null} [slug]
 */
function peopleForBranch(slug) {
  const people = [vatsalLine(), VEDANT_LINE];
  if (slug === 'sursagar') {
    const nilesh = nileshLine();
    if (nilesh) people.push(nilesh);
  }
  return people;
}

/** Phone block when no branch context (corporate / escalation / menus). */
function directoryPhonesOnly() {
  return peopleForBranch(null).join('\n');
}

function directoryPhonesForBranch(slug) {
  const phone = STORE_BRANCH_PHONE[slug];
  if (!phone) return directoryPhonesOnly();
  const label = slug === 'alkapuri' ? '*Alkapuri*' : '*Sursagar*';
  // People first (Vatsal leads), then the shop's own line.
  return [...peopleForBranch(slug), label + ' — ' + phone].join('\n');
}

function directoryWithEmailForBranch(slug) {
  return `${directoryPhonesForBranch(slug)}\n\n✉️ chanakyathebagstudio@gmail.com`;
}

function directoryWithEmailAndWebForBranch(slug) {
  return `${directoryWithEmailForBranch(slug)}\n🌐 front.chanakyacorporate.com`;
}

function directoryWithEmail() {
  return `${directoryPhonesOnly()}\n\n✉️ chanakyathebagstudio@gmail.com`;
}

/** @param {'store_alkapuri'|'store_sursagar'} repairStoreId */
function branchSlugFromRepairStoreId(repairStoreId) {
  if (repairStoreId === 'store_alkapuri') return 'alkapuri';
  if (repairStoreId === 'store_sursagar') return 'sursagar';
  return null;
}

// Only what other modules actually consume. DEFAULT_CONTACT_NAME,
// DEFAULT_CONTACT_PHONE_DISPLAY, directoryPhonesOnly and
// directoryPhonesForBranch are still used INSIDE this file to build the blocks
// below — they just have no external callers, so they stay private.
module.exports = {
  defaultCallLine,
  directoryWithEmail,
  directoryWithEmailForBranch,
  directoryWithEmailAndWebForBranch,
  branchSlugFromRepairStoreId,
};
