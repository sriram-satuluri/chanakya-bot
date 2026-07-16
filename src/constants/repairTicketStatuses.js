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

module.exports = {
  REPAIR_TICKET_STATUSES,
  DEFAULT_REPAIR_TICKET_STATUS,
};
