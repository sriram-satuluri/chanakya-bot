const { getLastTicketNumber, setLastTicketNumber } = require('../services/sheets');
const { currentISTYear } = require('./istTime');

/**
 * Branch letter in the ticket ID (staff asked for this so a row is obviously
 * Alkapuri vs Sursagar without opening column F).
 *   Alkapuri → R   CHA-R-2026-0020
 *   Sursagar → S   CHA-S-2026-0020
 *
 * Sequence still comes from the single P1 counter, so numbers are unique
 * across both shops (you will not get both R-0020 and S-0020 from this bot).
 */
const STORE_TICKET_LETTER = {
  store_alkapuri: 'R',
  store_sursagar: 'S',
  alkapuri: 'R',
  sursagar: 'S',
};

function ticketLetterFromStore(store) {
  const raw = String(store || '').trim().toLowerCase();
  if (STORE_TICKET_LETTER[raw]) return STORE_TICKET_LETTER[raw];
  if (raw.includes('alkapuri')) return 'R';
  if (raw.includes('sursagar')) return 'S';
  return null;
}

/**
 * Single-node mutex around counter increment. Prevents two simultaneous
 * repair-ticket submissions from generating the same ID.
 * NOTE: Only correct while the bot runs as a single process. If we horizontally
 * scale to multiple nodes, move the increment into a Sheets batchUpdate with
 * value_input_option: USER_ENTERED and a formula-side +1, or use Redis INCR.
 */
let _generationChain = Promise.resolve();

async function generateTicketId(store) {
  const letter = ticketLetterFromStore(store);
  if (!letter) {
    throw new Error(`Cannot mint a ticket ID without an Alkapuri/Sursagar store (got ${JSON.stringify(store)})`);
  }
  const run = _generationChain.then(async () => {
    // IST, not the server's own timezone/locale — a UTC-hosted bot must still
    // roll the ticket-ID year over at IST midnight (the business's local time).
    const year = currentISTYear();
    const lastNum = await getLastTicketNumber();
    const nextNum = (lastNum || 0) + 1;
    await setLastTicketNumber(nextNum);
    const padded = String(nextNum).padStart(4, '0');
    return `CHA-${letter}-${year}-${padded}`;
  });
  // Keep chain rolling but don't propagate rejection so future calls aren't stuck
  _generationChain = run.catch(() => {});
  return run;
}

module.exports = { generateTicketId, ticketLetterFromStore, STORE_TICKET_LETTER };
