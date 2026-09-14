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
 * Download an inbound WhatsApp image and store it on Cloudinary.
 * Random token in the public URL — never the phone number.
 * @returns {Promise<string|null>} HTTPS URL, or null when the message has no image
 */
async function uploadInboundRepairPhoto(message) {
  const mediaId = getInboundImageMediaId(message);
  if (!mediaId) return null;
  const buf = await downloadMedia(mediaId);
  const filename = `before_${crypto.randomBytes(8).toString('hex')}_${Date.now()}`;
  return uploadBuffer(buf, 'chanakya-repairs/before', filename);
}

/**
 * Handle an image sent outside any flow.
 *
 * The booking asks for a photo just before creating the ticket, with a skip
 * ("I'll upload later"). A stray image after that is matched to their most
 * recent ticket that still has no photo.
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
    const url = await uploadInboundRepairPhoto(message);
    if (!url) return false;
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

module.exports = { handleLatePhoto, uploadInboundRepairPhoto, getInboundImageMediaId };
