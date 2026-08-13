# Part 3 — WhatsApp Flow for repair intake (PROPOSAL — nothing built)

Status: **scope only, awaiting your go-ahead.** No code in this repo has been
changed for this. The existing `ask_name → ask_bag_type → ask_problem →
ask_photo → ask_store` flow is untouched and remains the only intake path.

---

## 1. Screen-by-screen mapping against the current 5 steps

The current flow is 5 round-trips (5 inbound + ~5 outbound messages). A Flow
collapses the four *data* steps into a single form the customer fills in one
sitting, then submits once.

| Current step | Flow equivalent | Component |
|---|---|---|
| `ask_name` | Screen 1, field 1 | `TextInput` (required, max 60) |
| `ask_bag_type` | Screen 1, field 2 | `Dropdown` — 7 static options |
| `ask_problem` | Screen 1, field 3 | `Dropdown` — 8 static options |
| `ask_store` | Screen 1, field 4 | `RadioButtonsGroup` — Alkapuri / Sursagar |
| `ask_photo` | **stays a normal message** — see §2 | (unchanged) |
| — | Screen 2 | `Footer` confirm + terms acknowledgement |

One screen is deliberate. Splitting name/bag/problem/store across four Flow
screens would recreate the round-trips the Flow is supposed to remove, while
adding a review cycle. A single scrollable form is the actual UX win.

**Completion handoff.** On submit, WhatsApp sends the webhook a message of
type `interactive` / `nfm_reply` carrying a `response_json` string with the
field values. `webhook/handler.js` already extracts `interactive` payloads, so
this needs one new branch that parses `response_json`, maps the four values
onto the same `collectedData` shape the current flow builds, and then hands
off to the **existing** ticket-creation code path — `generateTicketId()` →
`createRepairTicket()` → owner alerts → `askRepairUpdatesOptIn()`. None of
that logic changes.

---

## 2. Static Flow vs Data Exchange — and the photo

**Recommendation: Static Flow. Data Exchange is not needed and would be the
wrong call here.**

Data Exchange earns its complexity when screen content depends on live server
data, or when you must validate mid-flow. Neither applies:

- Bag types (7) and problems (8) are hardcoded constants in `flows/repair.js`.
- There are exactly 2 stores.
- Nothing needs validating server-side until submission.
- The ticket ID is generated *after* submit, not during.

A Data Exchange flow would add a public encrypted endpoint, key management, an
extra Meta review surface, and a new class of outage (endpoint down = intake
broken) for zero functional gain.

### The photo is the real design decision

`PhotoPicker` exists as a Flow component, but I am **not confident enough in
how it returns media** across Flow JSON versions to build against it blind —
whether the image arrives as a media handle to fetch, or inline, and whether
static flows can carry it at all given payload limits. Getting that wrong
means a rebuilt photo path and a second Meta review cycle.

**Proposed: keep the photo as a normal WhatsApp message after the Flow
completes.** Sequence becomes:

1. Customer taps "Repair My Bag" → Flow opens → fills the four fields → submits.
2. Bot receives `nfm_reply`, stores the four values in the session, and asks
   for the photo using the **existing, unchanged** `ask_photo` step.
3. Customer sends the photo → **existing** `downloadMedia()` → `uploadBuffer()`
   Cloudinary path runs untouched → ticket created.

This reuses the entire Cloudinary chain with zero changes, sidesteps the
PhotoPicker uncertainty, and still removes 4 of the 5 round-trips. If
PhotoPicker later proves clean, moving it into the Flow is a contained
follow-up rather than a prerequisite.

---

## 3. Shipping without risk to what already works

Gated additional entry point. The current flow stays the default and the
fallback:

```
REPAIR_FLOW_ENABLED=false     # master switch, default OFF
REPAIR_FLOW_ID=<id from Meta>
```

Routing, on `btn_repair`:

```
if (REPAIR_FLOW_ENABLED && REPAIR_FLOW_ID && flow-send succeeds)
      → Flow intake
else  → existing step-by-step (unchanged code path)
```

Properties that matter:

- **Default off.** Merging this changes nothing until you flip the flag.
- **Fail-open.** If the Flow send throws (unapproved, deprecated, wrong id,
  Meta outage), we log and fall through to the step-by-step flow in the same
  turn. The customer never sees a dead end.
- **Nothing existing is edited**, only added to. Every current test-checklist
  item passes unchanged with the flag off, so a Meta rejection or stalled
  review costs nothing.
- **Reversible instantly** — flip the flag back, no redeploy of logic.

Suggested rollout: flag on for your own number first → a week of real
customers with both paths live → only then consider retiring the old path
(and I would keep it as the fallback indefinitely, since it costs nothing).

---

## 4. Draft Flow JSON

Provided as a **starting point, not submission-ready**. Meta's Flow JSON
schema is versioned and its validator is strict about component names and
required properties per version; I would want to check the current version's
reference before you submit rather than have you burn a review cycle on a
schema mismatch. The *structure and field mapping* below is the reviewed part.

```json
{
  "version": "7.0",
  "screens": [
    {
      "id": "REPAIR_DETAILS",
      "title": "Book a Repair",
      "terminal": true,
      "data": {},
      "layout": {
        "type": "SingleColumnLayout",
        "children": [
          {
            "type": "TextBody",
            "text": "Tell us about your bag and we'll get a ticket started."
          },
          {
            "type": "Form",
            "name": "repair_form",
            "children": [
              {
                "type": "TextInput",
                "name": "customer_name",
                "label": "Your name",
                "input-type": "text",
                "required": true
              },
              {
                "type": "Dropdown",
                "name": "bag_type",
                "label": "Type of bag",
                "required": true,
                "data-source": [
                  { "id": "0", "title": "Trolley / Luggage Bag" },
                  { "id": "1", "title": "Backpack" },
                  { "id": "2", "title": "School Bag" },
                  { "id": "3", "title": "Laptop Bag" },
                  { "id": "4", "title": "Handbag / Purse" },
                  { "id": "5", "title": "Duffel Bag" },
                  { "id": "6", "title": "Other" }
                ]
              },
              {
                "type": "Dropdown",
                "name": "problem",
                "label": "What's wrong?",
                "required": true,
                "data-source": [
                  { "id": "0", "title": "Zip / Chain Issue" },
                  { "id": "1", "title": "Wheel Issue" },
                  { "id": "2", "title": "Handle Issue" },
                  { "id": "3", "title": "Lock Issue" },
                  { "id": "4", "title": "Stitching / Tear" },
                  { "id": "5", "title": "Cleaning / Polishing" },
                  { "id": "6", "title": "Lining Issue" },
                  { "id": "7", "title": "Other" }
                ]
              },
              {
                "type": "RadioButtonsGroup",
                "name": "store",
                "label": "Which store will you bring it to?",
                "required": true,
                "data-source": [
                  { "id": "store_alkapuri", "title": "Alkapuri - Race Course Road" },
                  { "id": "store_sursagar", "title": "Sursagar - Opp. Pratap Talkies" }
                ]
              },
              {
                "type": "TextCaption",
                "text": "By submitting you accept our Terms. Repair begins only after you approve the quotation."
              },
              {
                "type": "Footer",
                "label": "Submit",
                "on-click-action": {
                  "name": "complete",
                  "payload": {
                    "customer_name": "${form.customer_name}",
                    "bag_type": "${form.bag_type}",
                    "problem": "${form.problem}",
                    "store": "${form.store}"
                  }
                }
              }
            ]
          }
        ]
      }
    }
  ]
}
```

**Note on the ids.** `bag_type` / `problem` ids are the numeric indices the
existing `resolveBagType()` / `resolveProblem()` resolvers already accept
(`bag_3`, `prob_1`), and `store` uses the existing `store_alkapuri` /
`store_sursagar` ids that `resolveStore()` already understands. That is
deliberate — the completion handler can feed these straight into the current
resolvers with no new mapping table to keep in sync.

**Localisation.** Flow JSON is per-Flow, so trilingual means either three
published Flows (one per language, selected by stored preference) or one
English Flow. Three Flows is the honest answer for a trilingual customer base,
and triples the review surface — worth deciding before submitting.

---

## Open questions for you

1. **Photo in-Flow or after?** I recommend after (§2). Changing this changes
   the build materially.
2. **One Flow or three (per language)?** Three matches the bot's existing
   trilingual promise; one is faster to get approved.
3. **Is the round-trip saving worth it** given intake already works? The
   honest case for Flows here is fewer drop-offs mid-flow, not capability.
