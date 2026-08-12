/**
 * Canonical strings for repair_tickets column G (status).
 * Keep aligned with WhatsApp tracking, status poller, and Sheets dropdown
 * (`npm run sheet:status-dropdown`).
 */

const DEFAULT_REPAIR_TICKET_STATUS =
  'Bag Yet To Be Received - Come on Its AI, But I Need You To Physically Bring The Bag To The Store.';

const REPAIR_TICKET_STATUSES = [
  DEFAULT_REPAIR_TICKET_STATUS,
  'Bag Received',
  'Inspection Done',
  'Repair In Progress',
  'Repair Complete',
  'Ready for Pickup',
  'Cannot Repair',
  'Picked Up',
];

/**
 * Normalise a status string for comparison: trim, collapse internal whitespace,
 * strip trailing periods, casefold. Staff edit these cells by hand (and the
 * dropdown text can drift by a period or a space), and an exact-string match
 * breaking on "Store" vs "Store." once leaked the raw sheet wording to a
 * customer instead of the polished message.
 */
function normalizeStatusKey(s) {
  return String(s ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\.+$/, '')
    .toLowerCase();
}

const _CANONICAL_BY_KEY = new Map(
  REPAIR_TICKET_STATUSES.map((s) => [normalizeStatusKey(s), s]),
);

/**
 * Map any staff-typed variant of a known status back to its canonical string.
 * Unknown/custom statuses are returned trimmed but otherwise as-is.
 */
function canonicalStatus(s) {
  return _CANONICAL_BY_KEY.get(normalizeStatusKey(s)) ?? String(s ?? '').trim();
}

/**
 * Statuses that END the proactive-update lifecycle for a ticket.
 *   'Ready for Pickup' → send ONE final "your bag is ready" message, then stop.
 *   'Picked Up'        → already collected; stop silently (a "ready" message
 *                        would be wrong/confusing at this point).
 *   'Cannot Repair'    → job cancelled; stop.
 * Maps to the stop_reason recorded on the ticket row.
 */
const TERMINAL_STOP_REASON = {
  'Ready for Pickup': 'completed',
  'Picked Up':        'completed',
  'Cannot Repair':    'cancelled',
};

/** @returns {'completed'|'cancelled'|null} */
function terminalStopReason(status) {
  const s = canonicalStatus(status);
  if (TERMINAL_STOP_REASON[s]) return TERMINAL_STOP_REASON[s];
  // Staff sometimes type a free-form cancellation instead of using the dropdown.
  if (/\bcancel/i.test(s)) return 'cancelled';
  return null;
}

module.exports = {
  REPAIR_TICKET_STATUSES,
  DEFAULT_REPAIR_TICKET_STATUS,
  normalizeStatusKey,
  canonicalStatus,
  terminalStopReason,
};
