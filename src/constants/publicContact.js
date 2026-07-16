/**
 * Default customer-facing contact shown in bot messages.
 */

const DEFAULT_CONTACT_NAME = 'Vatsal Joshi';
/** Human-readable dialing line (shown in Markdown messages) */
const DEFAULT_CONTACT_PHONE_DISPLAY = '+91 99740 17725';

const VEDANT_LINE = '*Vedant Joshi* — +91 99745 92477';

/** Branch “first line” phones (order: branch → Vatsal → Vedant). */
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

/** Phone block when no branch context (corporate / escalation / menus). */
function directoryPhonesOnly() {
  return [vatsalLine(), VEDANT_LINE].join('\n');
}

function directoryPhonesForBranch(slug) {
  const phone = STORE_BRANCH_PHONE[slug];
  if (!phone) return directoryPhonesOnly();
  const label = slug === 'alkapuri' ? '*Alkapuri*' : '*Sursagar*';
  return [label + ' — ' + phone, vatsalLine(), VEDANT_LINE].join('\n');
}

function directoryWithEmailForBranch(slug) {
  return `${directoryPhonesForBranch(slug)}\n\n✉️ chanakyathebagstudio@gmail.com`;
}

function directoryWithEmailAndWebForBranch(slug) {
  return `${directoryWithEmailForBranch(slug)}\n🌐 www.thebagsandgifts.shop`;
}

function directoryWithEmail() {
  return `${directoryPhonesOnly()}\n\n✉️ chanakyathebagstudio@gmail.com`;
}

function directoryWithEmailAndWeb() {
  return `${directoryWithEmail()}\n🌐 www.thebagsandgifts.shop`;
}

/** @param {'store_alkapuri'|'store_sursagar'} repairStoreId */
function branchSlugFromRepairStoreId(repairStoreId) {
  if (repairStoreId === 'store_alkapuri') return 'alkapuri';
  if (repairStoreId === 'store_sursagar') return 'sursagar';
  return null;
}

module.exports = {
  DEFAULT_CONTACT_NAME,
  DEFAULT_CONTACT_PHONE_DISPLAY,
  defaultCallLine,
  directoryPhonesOnly,
  directoryPhonesForBranch,
  directoryWithEmail,
  directoryWithEmailAndWeb,
  directoryWithEmailForBranch,
  directoryWithEmailAndWebForBranch,
  branchSlugFromRepairStoreId,
};
