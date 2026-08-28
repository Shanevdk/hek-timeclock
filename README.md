# HEK Fencing Inc. — Time Clock

A simple employee time clock:

- **Employees** sign in with an **email + password** on their own phone and clock in/out with the **Clock In** button in the portal sidebar — no app to install, just open the web page. When clocking out they must enter **what they worked on** that day. If they forget to clock out, the same button asks **when they finished and why** before they can start again.
- **Admins** sign in with an **email + password** to see who's on the clock, view/total hours (including each day's work notes and missed-clock-out reasons), fix mistakes, add employees, and export to CSV for payroll.

## Screens

| URL | Who | What |
| --- | --- | --- |
| `/` | Everyone | Sign in with email + password → employee portal (clock in/out + hours), or (admin) the dashboard |
| `/admin` | Admin | Dashboard — reached automatically after an admin signs in on `/` |

> Everyone signs in on the main page (`/`). Employees land on a portal where they
> punch in and out and always see their own hours (plus any features the admin
> grants them); admins are redirected to the dashboard at `ADMIN_PATH`
> (default `/admin`).

## Admin dashboard

- **On the clock** — live list of who is currently clocked in.
- **Timesheets** — filter by employee and date range, see total hours, edit any entry, add a manual entry, **Export CSV**.
- **Employees** — add employees (name + login email + password), edit their profile, deactivate, or delete. An employee needs an email and password to sign in and clock in.
- **Quotes** — build a customer quote, print it as a PDF, and convert an accepted one into an invoice.
- **Invoices** — line items, tax, due dates, recorded payments and a running balance. Paid / overdue work themselves out. Send one to the customer through QuickBooks — see [Sending invoices through QuickBooks](#sending-invoices-through-quickbooks).
- **Inbox** — an AI agent reads the mailbox and drafts quotes from customer emails for you to review. See [AI inbox](#ai-inbox).
- **QuickBooks** — push each pay period's hours into QuickBooks so payroll runs there with the numbers already filled in. See [QuickBooks payroll sync](#quickbooks-payroll-sync).

---

## Database

All data lives in a **cloud MongoDB** database — nothing is stored on the app
server. Get a free cluster from [MongoDB Atlas](https://www.mongodb.com/atlas) and
copy its connection string (Atlas → **Connect → Drivers**), which looks like:

```
mongodb+srv://user:password@cluster.mongodb.net/?appName=yourapp
```

Put it in the `DATABASE_URL` environment variable. The collections
(`employees`, `punches`) are created automatically on first use.

## Run it locally

```bash
npm install
# copy .env.example to .env and fill in DATABASE_URL + ADMIN_EMAIL + ADMIN_PASSWORD
npm start
```

On Windows PowerShell (without a .env file):

```powershell
$env:DATABASE_URL="mongodb+srv://user:pass@cluster.mongodb.net/?appName=yourapp"
$env:ADMIN_PASSWORD="yourpassword"
npm start
```

Open http://localhost:3000 (sign in) — admins are taken to the dashboard.
The first thing to do after signing in is add your employees under the **Employees** tab.

## Deploy to Netlify

The repo is Netlify-ready (`netlify.toml`). The pages are served as static files
and the API runs as a serverless function.

1. Push this project to a GitHub repo.
2. In Netlify: **Add new site → Import an existing project**, pick the repo.
   Netlify reads `netlify.toml` (build command, publish dir, function) automatically.
3. In **Site settings → Environment variables**, add:
   - `DATABASE_URL` — your MongoDB connection string
   - `ADMIN_EMAIL` — admin sign-in email
   - `ADMIN_PASSWORD` — admin sign-in password
   - `SESSION_SECRET` — a long random string
   - `ADMIN_PATH` — the admin page path (default `/admin`; also sets the page filename)
   - `TIMEZONE` — e.g. `America/New_York`
4. Deploy. Netlify gives you a public `https://…netlify.app` URL — share `/` with
   the crew (they sign in there); admins are routed to the dashboard automatically.

> **Atlas network access:** In Atlas → **Network Access**, add `0.0.0.0/0` (allow
> from anywhere) so Netlify's servers can reach the cluster, otherwise the API
> will time out.

## Deploy to a Node host instead (Render, Railway, Fly.io…)

The app also runs as a normal long-running server (`npm start`). The repo
includes `render.yaml` for [Render](https://render.com): push to GitHub, then in
Render pick **New + → Blueprint** and set the same environment variables above.

## Configuration

| Env var | Purpose |
| --- | --- |
| `DATABASE_URL` | MongoDB connection string. **Required.** |
| `DB_NAME` | Database name inside the cluster (default `hektimeclock`). |
| `DB_STORAGE_LIMIT_MB` | Storage the plan allows, in MB — what "storage left" is measured against (default `512`, the Atlas free tier). Ignored on a server that reports a real disk. |
| `ADMIN_EMAIL` | Email admins sign in with (default `admin@hekfencing.com`). |
| `ADMIN_PASSWORD` | Password for the admin dashboard. **Set this.** |
| `SESSION_SECRET` | Random string signing the login cookie. |
| `ADMIN_PATH` | URL path for the admin dashboard (default `/admin`). |
| `TIMEZONE` | IANA timezone for the workday boundary (default `America/New_York`). |
| `PORT` | Port to listen on (host usually sets this). |
| `QBO_CLIENT_ID` | Intuit app client id. Optional — set it in the QuickBooks tab instead. |
| `QBO_CLIENT_SECRET` | Intuit app client secret. Optional, same. |
| `QBO_ENVIRONMENT` | `sandbox` (default) or `production`. Optional, same. |
| `QBO_REDIRECT_URI` | Must match a Redirect URI on the Intuit app exactly. Optional, same. |
| `CREDENTIAL_ENCRYPTION_KEY` | Optional. Keys the stored-credential encryption off its own secret instead of `SESSION_SECRET`. |
| `CRON_SECRET` | Lets the scheduled QuickBooks sync and inbox scan run on Vercel. Without it those endpoints stay closed. |
| `ANTHROPIC_API_KEY` | Lets the AI inbox agent read email. Optional — leave blank to switch it off. |
| `MAIL_ENCRYPTION_KEY` | Optional. Keys the mail-password encryption off its own secret instead of `SESSION_SECRET`. |

## Quotes and invoices

The **Quotes** tab builds a customer quote and prints it as a branded PDF. When
one is accepted, **Convert to invoice** copies the customer and every line item
across, marks the quote accepted, and opens the new invoice — nothing is retyped.

The **Invoices** tab is the money-owed side of that. An invoice carries a due
date and a list of payments received, and the header tiles show what's
outstanding, what's overdue, and what's been collected.

**Paid and overdue are never stored.** They are worked out from the payments and
the due date each time an invoice is read, so the badge next to an invoice can
never disagree with the numbers underneath it. You set *draft*, *sent* or
*void*; the rest follows.

An invoice with payments recorded against it cannot be deleted — void it
instead. Deleting would erase the record of money that actually came in.

Line prices come from the **rate book**, which now lives in the database rather
than in one browser. Rates saved on a device before that change are pushed up
automatically the first time the Pricing tab loads.

## Seeing the fence before it's built

On the public estimate page, once a customer has traced their fence on the
satellite map, **See it on your property in 3D** stands the fence up on aerial
imagery of their actual yard — in the exact spot they drew it, at the style and
height they pick. They can drag to look around and save the picture.

The ground is real satellite imagery, stitched from the same tiles the map uses
and served through this app rather than fetched straight from Esri. That isn't
incidental: a canvas that has drawn a cross-origin image can't be read back,
which would quietly break "Save picture".

Style comes from whatever fence they're pricing — a rate-book service says what a
fence costs, not what it looks like, so each one maps to the nearest thing we can
draw (privacy boards, picket, board rail, chain link, wire). Anything the office
invented falls back to privacy boards, and the customer can change it. It's a
picture, not a specification. The style and height they settled on are saved with
the request, so the estimator quotes the fence the customer actually pictured.

**This needs no API key and no account.** It works out of the box.

### From the road (optional)

With a Google Maps key, the preview also shows Google's photo of the property
from the street, with the fence drawn over it. Paste the key under
**Estimates → Page settings → Street View photo**; it's encrypted, kept on the
server, and the browser only ever asks this app for a picture.

The overlay is a real projection — Google's own camera position, the bearing and
distance to each corner, and a pinhole camera — not a sketch. But it assumes flat
ground and a camera about 2.5 m up, so on a sloped or angled frontage it will be
visibly off. It's labelled a rough preview and is off until the customer ticks
the box. **The satellite 3D is the one to rely on.**

Google gives **5,000 Street View requests a month free**, then roughly $0.007
each. (The old flat $200 monthly credit was retired in March 2025 and replaced
with a per-API free allowance.) 5,000 is a lot of customers looking at their own
street, so in practice this costs nothing.

Two things keep it that way. A location with no Street View coverage is detected
first through the **metadata endpoint, which is free** — so a rural property
never bills for a "sorry, no imagery" placeholder. And the photo is only fetched
when a customer opens the 3D preview, not on every page load.

## AI inbox

An agent reads the company mailbox, picks out the emails that are asking about
fencing, and drafts an estimate from your own rate book. Each one appears in the
**Inbox** tab as the original email beside the draft, with whatever it couldn't
work out listed as the questions to ask.

**It never replies to anyone, and it never creates a quote on its own.** It files
drafts; approving one is what creates the quote, and the draft is editable while
you review it — a correction you make there is what gets saved.

### What it costs

Reading an email is an API call, so this is not free — but it is cheap. At a few
dozen emails a day expect **a couple of dollars a month**, not a subscription.
Three things keep it that way:

- Newsletters, no-reply addresses and anything carrying an unsubscribe header are
  skipped before the model ever sees them.
- Long forwarded threads are trimmed before being sent.
- **Max emails per scan** is a hard ceiling. A bad mail filter can't run up a bill
  while you're not looking.

Every email it has read is recorded, so the same message is never paid for twice
no matter how often you scan.

### Setting it up

1. Get an API key at [platform.claude.com](https://platform.claude.com) and set it
   as `ANTHROPIC_API_KEY`.
2. Make sure `SESSION_SECRET` is a long random value — the mail password is
   encrypted with a key derived from it, and the app refuses to save one while
   that is still the placeholder.
3. **Create a Gmail app password.** In your Google account, turn on 2-step
   verification, then **Security → App passwords**, and generate one for "Mail".
   It's 16 characters. Your normal Google password will not work over IMAP.
4. In the dashboard, open **Inbox → Settings**, enter the mailbox address and the
   app password, click **Test connection**, then switch the agent on.

For a non-Google mailbox, change the IMAP server and port — everything else is
the same.

### Rules it follows

The prompt is deliberate about one thing: **it does not guess.** If an email
doesn't say how many feet, it puts a 0 on the line and adds "How many linear
feet?" to the questions, rather than inventing a number. A draft with a blank in
it is honest; a draft with a plausible-looking made-up number in it is how a job
gets underpriced.

It also won't invent a fence type, height, or material that was never written
down, and it leaves customer fields empty rather than filling them with guesses.

### The schedule

A scan runs every two hours, and **Scan now** runs one on demand.

- **Vercel** — `vercel.json` (`crons`), needs `CRON_SECRET`. Note that Hobby
  projects are limited to one cron run per day; the two-hour schedule needs Pro.
- **Netlify** — `netlify.toml` (`[functions."inbox-scan"]`), no secret needed.
- **A plain Node host** — point any cron at `POST /api/cron/inbox-scan` with an
  `Authorization: Bearer $CRON_SECRET` header.

Turning **Scan automatically** off in the dashboard leaves the button working and
stops the schedule.

## Sending invoices through QuickBooks

Invoices are built here but **sent by QuickBooks**, so the customer gets the
QuickBooks invoice — its branding, its payment link, and the payment recorded
against your books automatically. This app never emails an invoice itself.

On any saved invoice there is a **Send with QuickBooks** panel:

1. **Send to QuickBooks** creates the invoice over there, matching the customer
   by name and adding them if QuickBooks has never seen them.
2. **Email it to the customer** asks QuickBooks to send it.

Pushing a second time updates the same QuickBooks invoice rather than creating a
duplicate, so correcting a line and re-sending is safe.

### Setup

In **QuickBooks → Invoices**, pick which product/service invoice lines bill
against. QuickBooks requires one on every sales line; your own wording still
goes across as the line description. Nothing can be sent until this is chosen.

**Tax is left to QuickBooks.** Invoices here carry a flat percentage, while
QuickBooks works tax out from its tax code and the customer — and QuickBooks is
what files the return. Set the tax code in that same panel. If the two totals
end up disagreeing, you are told at the moment you push rather than finding out
from an accountant later.

## QuickBooks payroll sync

Every pay period, the hours in this app are pushed into QuickBooks as time
entries against each employee. Whoever runs payroll opens QuickBooks and finds
the hours already there — review, click **Run payroll**, direct deposit goes out.

**This never pays anybody.** Intuit has no public API for running a QuickBooks
Online payroll or moving money, so the final click stays with a person. That is
a limit of QuickBooks, not of this app, and it is arguably the right place for a
human to be: a bad punch shouldn't silently become a direct deposit.

### One-time setup

1. **Create an Intuit app** at [developer.intuit.com](https://developer.intuit.com)
   → **My Apps** → **Create an app** → *QuickBooks Online and Payments*. Scope:
   **Accounting**.
2. Sign in as admin and open the **QuickBooks** tab. In the **Intuit app** box,
   paste the Client ID and Client Secret from the app's **Keys & credentials**
   page and pick the matching environment — sandbox and production have separate
   keys. Save.
3. Add a **Redirect URI** on the Intuit app pointing at this deployment:
   `https://your-app.example.com/api/quickbooks/callback`. The dashboard shows
   the exact URL for your deployment and will fill it in for you. It has to match
   Intuit's copy exactly — scheme, host, path, no trailing slash.
4. Set `CRON_SECRET` to a long random string (Vercel only — it's what lets Vercel
   Cron call the scheduled endpoint).
5. Click **Connect QuickBooks**.

The keys live in the database, encrypted, so they can be entered and rotated
without a redeploy. The `QBO_*` environment variables still work and act as
defaults — anything set in the dashboard overrides them, field by field, and the
tab tells you which source each value is coming from.

Changing the Client ID or the environment drops any existing connection, because
tokens are issued by one Intuit app for one company and wouldn't authorise
anything afterwards. You'll be told when that happens; just reconnect.

> Production keys are gated: Intuit requires an app review before it will issue
> them. Sandbox keys are instant, and everything here works against a sandbox
> company first.

### In the dashboard

- **Pay schedule** — pick the first day of any one pay period; every other period
  is counted from it. Weekly or every two weeks.
- **Overtime** — off by default, deliberately. The threshold is a labour-law
  question (44 h/week in Ontario, 40 under US federal rules), so nothing is
  assumed on your behalf. A daily threshold can be set too; daily overtime is
  taken out first and doesn't also count toward the weekly one.
- **Payroll items** — optional. With a **regular** and an **overtime** payroll
  item id filled in, each day goes over as two entries tagged with those items.
  Left blank, each day is one entry for the day's total and the split is written
  into the entry's description.
- **Who is who** — match each person here to the employee QuickBooks already
  knows. **Match by name** fills in exact name matches; anything ambiguous is
  left for you. Unmatched people are skipped rather than guessed at.
- **Pay period** — shows exactly what would be pushed before anything is pushed,
  including warnings for open punches and unmatched employees. Step backward and
  forward through periods to fix an earlier one.

### What gets pushed

Only **hourly** staff. Salaried staff are paid the same however long the day
runs, so their punches are not payroll input and are left out. A shift that is
still open (nobody clocked out) is left out too, and flagged — close it and sync
again.

Re-running a period is safe and is the normal way to fix a timesheet: every
entry pushed is remembered with its QuickBooks id, so a second run **updates**
what changed, **removes** what no longer has hours behind it, and leaves the rest
alone. It never creates a second copy.

### The scheduled push

A daily job looks for a pay period that has just closed and pushes it once. It
skips a period it has already pushed, so a retry costs nothing, and it ignores
anything that closed more than a few days ago so a first deploy doesn't backfill
the company's whole history.

- **Vercel** — configured in `vercel.json` (`crons`), needs `CRON_SECRET`.
- **Netlify** — configured in `netlify.toml` (`[functions."qbo-sync"]`), no
  secret needed since Netlify's scheduler calls the function directly.
- **A plain Node host** — no scheduler is built in. Point any cron at
  `POST /api/cron/quickbooks-sync` with an `Authorization: Bearer $CRON_SECRET`
  header, or just use the **Push to QuickBooks** button.

Turning the switch off in the dashboard leaves the button working and stops the
scheduled push.

## Notes

- Times are stored in UTC and displayed in each viewer's local timezone.
- Clocking in asks the browser for the device location (best effort). If the employee allows it, the spot is saved with the punch and shown on the admin **Map**; if they decline, clocking in still works.
