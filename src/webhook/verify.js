const crypto = require('crypto');

/** Constant-time string equality (length leak is unavoidable; contents are not). */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Verifies the Meta webhook handshake (GET request from Meta)
function verifyWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = String(req.query['hub.verify_token'] ?? '').trim();
  const challenge = req.query['hub.challenge'];

  const expected = process.env.WEBHOOK_VERIFY_TOKEN?.trim();
  if (mode === 'subscribe' && expected && safeEqual(token, expected)) {
    console.log('[WEBHOOK] Verification successful');
    return res.status(200).send(challenge);
  }
  console.warn('[WEBHOOK] Verification failed — token mismatch');
  return res.sendStatus(403);
}

module.exports = { verifyWebhook };
