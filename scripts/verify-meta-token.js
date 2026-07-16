#!/usr/bin/env node
/**
 * Loads .env and checks META_ACCESS_TOKEN + META_PHONE_NUMBER_ID against Meta Graph.
 * Exit 0 = OK (can reach WhatsApp phone asset). Exit 1 = fix .env token or phone ID.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { verifyMetaWhatsAppCredentials, getMetaAccessToken } = require('../src/services/whatsapp');

async function main() {
  const len = getMetaAccessToken().length;
  console.log('[verify-meta-token] META_ACCESS_TOKEN length after cleanup:', len);
  const r = await verifyMetaWhatsAppCredentials();
  if (r.ok) {
    console.log('[verify-meta-token] OK — outbound WhatsApp API should work.');
    console.log('  Phone number ID:', r.phoneNumberId);
    console.log('  Display number :', r.displayPhoneNumber || '(n/a)');
    console.log('  Verified name :', r.verifiedName || '(n/a)');
    process.exit(0);
  }

  console.error('[verify-meta-token] FAILED:', JSON.stringify(r, null, 2));
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
