/**
 * Checkbox screen for repair issues.
 *
 * WhatsApp lists and reply buttons are single-select. A Flow CheckboxGroup is
 * the multi-select control: the customer ticks 1–5 issues and taps Continue.
 * The published flow is a shell; the option labels are filled per language
 * when the message is sent.
 *
 * No data endpoint — the screen completes on the phone and the webhook
 * receives the ticked ids.
 */

const M = require('../messages/index');

const FLOW_NAME = 'chanakya_repair_issues';
const FLOW_TOKEN = 'repair_issues';
const SCREEN_ID = 'ISSUES';

/** Shell Flow JSON. Option text is supplied at send time via ${data.issues}. */
function flowJson() {
  return {
    version: '7.0',
    screens: [
      {
        id: SCREEN_ID,
        title: 'Issues',
        terminal: true,
        success: true,
        data: {
          label: { type: 'string', __example__: "What's wrong?" },
          hint: { type: 'string', __example__: 'Up to 5' },
          continue_label: { type: 'string', __example__: 'Continue' },
          issues: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
              },
            },
            __example__: [
              { id: '0', title: 'Zip / Chain Issue' },
              { id: '1', title: 'Wheel Issue' },
            ],
          },
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            {
              type: 'Form',
              name: 'issues_form',
              children: [
                {
                  type: 'CheckboxGroup',
                  name: 'selected',
                  label: '${data.label}',
                  description: '${data.hint}',
                  required: true,
                  'min-selected-items': 1,
                  'max-selected-items': 5,
                  'data-source': '${data.issues}',
                },
              ],
            },
            {
              type: 'Footer',
              label: '${data.continue_label}',
              'on-click-action': {
                name: 'complete',
                payload: { selected: '${form.selected}' },
              },
            },
          ],
        },
      },
    ],
  };
}

function checklistData(lang, problems) {
  return {
    label: M.get('issue_check_label', lang).slice(0, 30),
    hint: M.get('issue_check_hint', lang).slice(0, 80),
    continue_label: M.get('issue_check_continue', lang).slice(0, 30),
    issues: problems.map((title, i) => ({
      id: String(i),
      title: String(title).slice(0, 30),
    })),
  };
}

function checklistCta(lang) {
  return M.get('issue_check_cta', lang).slice(0, 20);
}

/**
 * Turn a completed Flow payload into the text the repair step already
 * understands: "issues:0,2". Ids are 0-based indexes into PROBLEMS.
 */
function selectionTextFromResponse(responseJson) {
  let parsed;
  try {
    parsed = typeof responseJson === 'string' ? JSON.parse(responseJson) : responseJson;
  } catch {
    return '';
  }
  if (!parsed || typeof parsed !== 'object') return '';
  const selected = parsed.selected ?? parsed.issues;
  if (!Array.isArray(selected)) return '';
  const ids = [];
  for (const item of selected) {
    const raw = item && typeof item === 'object' ? item.id : item;
    const m = String(raw ?? '').trim().match(/^(\d+)$/);
    if (!m) continue;
    const idx = parseInt(m[1], 10);
    if (!ids.includes(idx)) ids.push(idx);
  }
  if (!ids.length) return '';
  return `issues:${ids.join(',')}`;
}

/** @returns {{ idxs: number[] } | null} */
function parseIssueReply(text) {
  const m = String(text || '').trim().match(/^issues:(\d+(?:,\d+)*)$/i);
  if (!m) return null;
  const idxs = [];
  for (const part of m[1].split(',')) {
    const idx = parseInt(part, 10);
    if (!idxs.includes(idx)) idxs.push(idx);
  }
  return { idxs };
}

module.exports = {
  FLOW_NAME,
  FLOW_TOKEN,
  SCREEN_ID,
  flowJson,
  checklistData,
  checklistCta,
  selectionTextFromResponse,
  parseIssueReply,
};
