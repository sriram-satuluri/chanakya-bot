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

// Upload a Buffer to Cloudinary and return the secure URL
async function uploadBuffer(buffer, folder = 'chanakya-repairs/before', filename = null) {
  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!body.length) throw new Error('Cloudinary upload: empty buffer');

  const opts = {
    folder,
    public_id: sanitizePublicId(filename),
    resource_type: 'auto',
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

module.exports = { uploadBuffer };
