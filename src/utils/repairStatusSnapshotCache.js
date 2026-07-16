/**
 * Persists last seen repair_tickets status per ticket ID so poll detects
 * Sheet edits even when updated_at isn't touched.
 */

const fs = require('fs');
const path = require('path');

function resolvePath() {
  const explicit = process.env.REPAIR_STATUS_CACHE_PATH?.trim();
  if (explicit) return explicit;
  return path.join(process.cwd(), 'data', 'repair_status_snapshot.json');
}

function ensureDir(fp) {
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** @returns {Record<string,string>} ticketId → trimmed status string */
function loadRepairStatusSnapshot() {
  const fp = resolvePath();
  try {
    const j = fs.readFileSync(fp, 'utf8');
    const o = JSON.parse(j);
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

/** @param {Record<string,string>} snapshot */
function saveRepairStatusSnapshot(snapshot) {
  const fp = resolvePath();
  ensureDir(fp);
  fs.writeFileSync(fp, JSON.stringify(snapshot), 'utf8');
}

function normalizeStatusCell(s) {
  return String(s ?? '').trim();
}

module.exports = {
  loadRepairStatusSnapshot,
  saveRepairStatusSnapshot,
  normalizeStatusCell,
};
