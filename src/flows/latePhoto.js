const crypto = require('crypto');
const { sendTextMessage, downloadMedia } = require('../services/whatsapp');
const { uploadBuffer } = require('../services/cloudinary');
const { findRecentTicketAwaitingPhoto, attachBeforePhoto } = require('../services/sheets');
const M = require('../messages/index');

const _rp = (p) => (p && p.length > 4) ? '***' + p.slice(-4) : '***';

/** WhatsApp image as native image OR as an image/* document. */
function getInboundImageMediaId(message = {}) {
  if (message.image?.id) return message.image.id;
  const doc = message.document;
  if (doc?.mime_type?.toLowerCase().startsWith('image/') && doc.id) return doc.id;
  if (message.sticker?.id) return message.sticker.id;
  return null;
}

/**
 * Handle an image sent outside any flow.
 *
 * Since the booking now creates the ticket BEFORE asking for a photo, the
 * photo can legitimately arrive at any point afterwards. Rather than a flow
 * step the customer could get stuck in (or lose to a restart), any stray
 * image is matched to their most recent ticket that still has no photo.
 *
 * @returns {Promise<boolean>} true if the image was consumed (caller should
 *   stop routing), false to let normal intent routing continue.
 */
async function handleLatePhoto(phone, message, lang = 'english') {
  const mediaId = getInboundImageMediaId(message);
  if (!mediaId) return false;

  let ticket;
  try {
    ticket = await findRecentTicketAwaitingPhoto(phone);
  } catch (e) {
    console.error(`[LATE-PHOTO] Lookup failed for ${_rp(phone)}:`, e.message);
    return false; // let the message route normally rather than swallow it
  }

  if (!ticket) {
    // No open photo-less ticket. Tell them rather than silently ignoring an
    // image they clearly sent on purpose.
    await sendTextMessage(phone, M.get('photo_no_open_ticket', lang)).catch(() => {});
    console.log(`[LATE-PHOTO] ${_rp(phone)} sent an image with no ticket awaiting a photo`);
    return true;
  }

  try {
    const buf = await downloadMedia(mediaId);
    // Random token, never the phone number — Cloudinary URLs are public and
    // this one ends up in the sheet and in owner alerts.
    const filename = `before_${crypto.randomBytes(8).toString('hex')}_${Date.now()}`;
    const url = await uploadBuffer(buf, 'chanakya-repairs/before', filename);
    await attachBeforePhoto(ticket.rowIndex, url);
    console.log(`[LATE-PHOTO] Attached photo to ${ticket.ticketId} for ${_rp(phone)}`);
    await sendTextMessage(phone, M.fill(M.get('photo_attached', lang), { ticketId: ticket.ticketId }))
      .catch(() => {});
  } catch (e) {
    console.error(`[LATE-PHOTO] Failed for ${ticket.ticketId} / ${_rp(phone)}:`, e.message);
    await sendTextMessage(phone, M.get('photo_attach_failed', lang)).catch(() => {});
  }
  return true;
}

module.exports = { handleLatePhoto };
