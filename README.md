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
| `ADMIN_EMAIL` | Email admins sign in with (default `admin@hekfencing.com`). |
| `ADMIN_PASSWORD` | Password for the admin dashboard. **Set this.** |
| `SESSION_SECRET` | Random string signing the login cookie. |
| `ADMIN_PATH` | URL path for the admin dashboard (default `/admin`). |
| `TIMEZONE` | IANA timezone for the workday boundary (default `America/New_York`). |
| `PORT` | Port to listen on (host usually sets this). |

## Notes

- Times are stored in UTC and displayed in each viewer's local timezone.
- Clocking in asks the browser for the device location (best effort). If the employee allows it, the spot is saved with the punch and shown on the admin **Map**; if they decline, clocking in still works.
