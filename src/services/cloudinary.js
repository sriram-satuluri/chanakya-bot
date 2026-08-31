const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,          // always mint https URLs
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sanitizePublicId(base) {
  return String(base || '')
    .replace(/\W+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 96) || `img_${Date.now()}`;
}

/**
 * Identify an image by its actual leading bytes.
 *
 * The `mime_type` on an inbound WhatsApp message is set by the sender's
 * client, so it is a claim, not a fact — a document announcing itself as
 * image/png can carry anything at all. These four cover every format WhatsApp
 * will deliver as a photo.
 *
 * @returns {string|null} format name, or null if these bytes are not an image
 */
function detectImageFormat(buf) {
  if (!buf || buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'png';
  // GIF: "GIF87a" / "GIF89a"
  if (buf.slice(0, 6).toString('latin1') === 'GIF87a' || buf.slice(0, 6).toString('latin1') === 'GIF89a') return 'gif';
  // WebP: "RIFF" .... "WEBP"
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

// Upload a Buffer to Cloudinary and return the secure URL
async function uploadBuffer(buffer, folder = 'chanakya-repairs/before', filename = null) {
  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!body.length) throw new Error('Cloudinary upload: empty buffer');

  // Verify the bytes before spending an upload on them. The caller has already
  // checked the client's claimed mime_type; this checks what actually arrived.
  const format = detectImageFormat(body);
  if (!format) {
    throw new Error(
      'Cloudinary upload: payload is not a JPEG, PNG, WebP or GIF '
      + `(${body.length} bytes, leading 0x${body.slice(0, 4).toString('hex')})`,
    );
  }

  const opts = {
    folder,
    public_id: sanitizePublicId(filename),
    // 'image', not 'auto': 'auto' would let Cloudinary happily store a video or
    // a raw blob if anything ever slipped past the check above. Narrow on
    // purpose — this bucket only ever holds photos of bags.
    resource_type: 'image',
    overwrite: false,
    unique_filename: false,
    timeout: 60000, // don't let one stuck upload hold a customer's flow hostage
  };

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const url = await new Promise((resolve, reject) => {
        const upload = cloudinary.uploader.upload_stream(opts, (err, result) => {
          if (err) return reject(err);
          const u = result?.secure_url || result?.url;
          if (!u) return reject(new Error('Cloudinary response missing secure_url'));
          resolve(u.startsWith('http:') ? u.replace(/^http:/, 'https:') : u);
        });
        upload.on('error', reject);
        upload.end(body);
      });
      console.log('[CLOUDINARY] Uploaded', url.slice(0, 80), '…');
      return url;
    } catch (err) {
      lastErr = err;
      console.warn(`[CLOUDINARY] attempt ${attempt}/3 failed:`, err.message || String(err));
      if (attempt < 3) await sleep(450 * attempt);
    }
  }
  throw lastErr;
}

module.exports = { uploadBuffer, detectImageFormat };
