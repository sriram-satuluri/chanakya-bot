# Repair sheet — staff card

The WhatsApp bot reads and writes the Google Sheet. Wrong cells look like a broken bot to the customer.

## You may edit

| Column | What | Rules |
|---|---|---|
| **G Current Status** | Where the bag is | Use the **dropdown only**. Do not type a variant. Each change can WhatsApp the customer. Ready for pickup and closing the ticket (Picked Up / Cannot Repair) always message them. |

That is the only column shop-floor staff can change. The tab is locked: ticket id (A), phone, photos, notes, the P1 counter, and reminder columns are bot + owner only. Run `npm run sheet:protect` if someone can still edit the rest.

Leave **A ticket id**, **C phone**, **P1 counter** alone.

Ticket IDs are `CHA-R-…` (Alkapuri) or `CHA-S-…` (Sursagar). Older rows may still be `CHA-2026-…` without a letter.

## Status meanings (column G)

1. **Bag Yet To Be Received…** — ticket booked, bag not at the store yet.
2. **Bag Received** — they dropped it off.
3. **Inspection Done** — you have looked at it (quote is in person, not on WhatsApp).
4. **Repair In Progress**
5. **Repair Complete**
6. **Ready for Pickup** — customer is **always** notified once, then we stop chasing progress.
7. **Cannot Repair** — customer is **always** told the ticket is closed.
8. **Picked Up** — customer is **always** told the ticket is closed; stop all further pings.

If a row sits on (1) for a week, they probably never came. Run `npm run sheet:orphans` or call them.

## Do not

- Type a new status wording. The dropdown is the contract with WhatsApp.
- Clear **P1**. That is the ticket counter. Resetting it reissues old IDs.
- Delete header row 1.
- Put a formula in a customer-name or notes cell that starts with `=`.
- Edit column A (ticket id). Only the bot and the sheet owner can.

## First-time setup

```bash
npm run sheet:status-dropdown
npm run sheet:protect
```

That puts the dropdown on column G and locks every other cell on this tab. Re-run if the dropdown or the lock vanishes.

Share this spreadsheet with staff as **Editors**, never as Owners. Google lets a file owner edit protected cells no matter what.

## Weekly

```bash
npm run funnel              # where people drop off while booking
npm run sheet:orphans       # booked, never arrived
```
