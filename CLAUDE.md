# Working notes for this repo

Short, hard-won conventions. Everything here exists because ignoring it has
already caused a real problem.

---

## ⚠️ Never edit source files with PowerShell text manipulation

**Rule: edit source files with a proper editor (the Edit tool, VS Code, etc.).
Never with PowerShell `Get-Content -Raw` + `Set-Content`, here-strings, or
`-replace` pipelines.**

### What happened

A one-line change was applied to five files with:

```powershell
# DO NOT DO THIS
(Get-Content $f -Raw) -replace 'old', 'new' | Set-Content -Encoding utf8 $f
```

It silently destroyed **every Hindi and Gujarati string in all five files**.

Two separate faults, both silent:

1. **`Get-Content -Raw` has no `-Encoding`**, so Windows PowerShell 5.1 reads
   the file using the system ANSI codepage, not UTF-8. Multi-byte UTF-8
   sequences are decoded as individual Latin-1 characters — `हिंदी` becomes
   `à¤¹à¤¿à¤‚à¤¦à¥€` — and that mangled text is what gets written back.
2. **`Set-Content -Encoding utf8`** in 5.1 writes UTF-8 **with a BOM**, which
   these files did not have.

Nothing errors. Syntax checks still pass, because the damage is inside string
literals. The bot boots fine. The only symptom is that Hindi and Gujarati
customers start receiving garbage — which is exactly the kind of thing that
reaches production because no test asserts on the bytes.

### Why this repo is unusually exposed

Roughly half the user-facing strings are Devanagari or Gujarati script, spread
across `src/messages/index.js`, `src/flows/*.js`, and the keyword sets in
`src/utils/intentDetect.js`. Almost any source file here can contain them.

### If you suspect corruption

```bash
node -e "const t=require('fs').readFileSync('src/flows/repair.js','utf8'); \
  console.log('mojibake:', /Ã|à¤|àª/.test(t), '| devanagari:', /[ऀ-ॿ]/.test(t))"
```

`mojibake: true` means the file is damaged. Recover with
`git checkout -- <file>` and redo the edit properly — do not try to repair the
text by hand, the original bytes are gone.

PowerShell is fine for *running* things (`node`, `git`, `npm`). The rule is
only about rewriting file contents.

---

## Other conventions worth knowing

- **`.env` is never committed.** `.gitignore` covers it; `.env.example`
  documents every variable with its default. If you add a config var, add it
  to `.env.example` in the same change — the audit checks these match.
- **Parse env vars with `utils/env.js` (`envInt` / `envBool`)**, not
  `Number(process.env.X) || default`. The `||` form silently ignores an
  explicit `0`, which has already caused a bug.
- **Phone numbers are redacted to last-4 in logs** (`***6663`). Follow the
  existing `_rp()` / `redactPhone()` pattern rather than logging raw numbers.
- **Customer text reaching a Sheets cell goes through `safeUserText()`**
  (formula-injection defence), and text reaching a WhatsApp **template
  variable** goes through `sanitizeTemplateParam()` (Meta rejects newlines,
  tabs, and 4+ consecutive spaces).
- **`populate_sheet.js` only initialises the ticket counter when it is empty.**
  Keep it that way — unconditionally writing `P1 = 0` on a live sheet resets
  ticket numbering and causes duplicate ticket IDs.
- **State that must survive a redeploy lives in `data/`** and is checked at
  boot by `utils/persistenceCheck.js`. Add new persistent files to the list in
  that module so the check covers them.
