#!/usr/bin/env node
/**
 * Create or update the repair-issue checkbox Flow and publish it.
 *
 * Writes REPAIR_ISSUES_FLOW_ID into .env on success. Needs a token that can
 * manage the WhatsApp Business account (whatsapp_business_management), not
 * only send messages.
 *
 *   npm run flow:issues
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getMetaAccessToken, phoneId } = require('../src/services/whatsapp');
const { FLOW_NAME, flowJson } = require('../src/flows/issueChecklist');

const BASE = 'https://graph.facebook.com/v22.0';

function authHeaders() {
  return { Authorization: `Bearer ${getMetaAccessToken()}` };
}

function metaMessage(err) {
  const meta = err.response?.data?.error;
  if (!meta) return err.message;
  return `${meta.message}${meta.code ? ` (code ${meta.code})` : ''}`;
}

async function main() {
  const token = getMetaAccessToken();
  const pid = phoneId();
  if (!token || !pid) {
    console.error('Set META_ACCESS_TOKEN and META_PHONE_NUMBER_ID in .env first.');
    process.exit(1);
  }

  const fromEnv = String(process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '').trim();
  let waba = fromEnv;
  if (!waba) {
    const phone = await axios.get(`${BASE}/${pid}`, {
      headers: authHeaders(),
      params: { fields: 'id' },
      timeout: 20000,
    });
    if (!phone.data?.id) {
      console.error('Could not read the WhatsApp phone number from META_PHONE_NUMBER_ID.');
      process.exit(1);
    }
    console.error(
      'The phone number is reachable, but this token cannot see the WhatsApp Business Account id.\n'
      + 'In WhatsApp Manager, open Account tools. The address bar has waba_id=...\n'
      + 'Add that id to .env as WHATSAPP_BUSINESS_ACCOUNT_ID=... and run npm run flow:issues again.',
    );
    process.exit(1);
  }

  const listed = await axios.get(`${BASE}/${waba}/flows`, {
    headers: authHeaders(),
    params: { fields: 'id,name,status', limit: 100 },
    timeout: 20000,
  });
  let flow = (listed.data?.data || []).find((f) => f.name === FLOW_NAME);
  if (!flow) {
    const created = await axios.post(`${BASE}/${waba}/flows`, {
      name: FLOW_NAME,
      categories: ['OTHER'],
    }, {
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      timeout: 20000,
    });
    flow = { id: created.data.id, status: 'DRAFT' };
    console.log('Created flow', flow.id);
  } else {
    console.log('Found flow', flow.id, flow.status);
  }

  const json = JSON.stringify(flowJson());
  const form = new FormData();
  form.append('file', new Blob([json], { type: 'application/json' }), 'flow.json');
  form.append('name', 'flow.json');
  form.append('asset_type', 'FLOW_JSON');
  const uploaded = await axios.post(`${BASE}/${flow.id}/assets`, form, {
    headers: authHeaders(),
    timeout: 20000,
  });
  const errors = uploaded.data?.validation_errors;
  if (errors?.length) {
    console.error('Flow JSON was rejected:');
    console.error(JSON.stringify(errors, null, 2));
    process.exit(1);
  }
  console.log('Uploaded checkbox screen');

  const published = await axios.post(`${BASE}/${flow.id}/publish`, {}, {
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    timeout: 20000,
  });
  if (published.data?.success !== true) {
    console.error('Publish did not succeed:', JSON.stringify(published.data));
    process.exit(1);
  }
  console.log('Published');

  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    let env = fs.readFileSync(envPath, 'utf8');
    const line = `REPAIR_ISSUES_FLOW_ID=${flow.id}`;
    if (/^REPAIR_ISSUES_FLOW_ID=/m.test(env)) {
      env = env.replace(/^REPAIR_ISSUES_FLOW_ID=.*$/m, line);
    } else {
      if (!env.endsWith('\n')) env += '\n';
      env += `\n# Checkbox screen for repair issues (npm run flow:issues)\n${line}\n`;
    }
    fs.writeFileSync(envPath, env);
    console.log('Saved REPAIR_ISSUES_FLOW_ID in .env');
  }
  console.log(`REPAIR_ISSUES_FLOW_ID=${flow.id}`);
}

main().catch((e) => {
  console.error(metaMessage(e));
  process.exit(1);
});
