# Budget

A complete personal budgeting app: accounts, transactions, transfers, monthly
budgets, savings goals and recurring bills — plus two ways to connect with other
people (**username** or **QR code**) so you can share an account with whoever you
split money with.

Sign up with an email and password, or **create an account with Google** in one tap.

---

## Features

**Money**
- Multiple accounts (everyday, savings, cash, credit card, investment) with live balances
- Income and expense transactions with categories, notes, and full-text search
- Transfers between accounts, stored as two linked legs so balances always agree
- Monthly budgets per category, with progress bars, over-budget warnings, and one-click copy from last month
- Savings goals with contributions and progress
- Recurring items (rent, salary, subscriptions) that post themselves — including catching up if you have been away
- Dashboard: net worth, month-on-month income/spend, category donut, six-month trend

**People**
- **Connect by username** — search for someone, send a request, they accept
- **Connect by QR code** — show a short-lived code, they scan it with their camera and you are connected instantly
- Share any account with a connection as **view only** or **can add and edit**
- Shared transactions show who entered them
- Opt out of username search at any time; QR still works

**Accounts and sign-in**
- Email + password, or Google sign-in
- Google sign-in creates the account on first use, and links to an existing account with the same email
- Add a password to a Google account, or unlink Google once you have one (never leaving you locked out)
- Session cookies are `httpOnly`, `SameSite=Lax`, and `Secure` in production

---

## Getting started

```bash
npm install
cp .env.example .env      # then fill in JWT_SECRET (see below)
npm start                 # http://localhost:3000
```

Generate a signing key for `JWT_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Want data to look at first?

```bash
npm run seed              # creates demo@example.com / demo1234 with 3 months of history
```

Run the tests:

```bash
npm test
```

## Setting up Google sign-in

Google sign-in is optional — the app runs fine without it and simply hides the
button. To turn it on:

1. Go to the [Google Cloud console → Credentials](https://console.cloud.google.com/apis/credentials).
2. **Create credentials → OAuth client ID → Web application.**
3. Add an **authorised JavaScript origin**: `http://localhost:3000` (and your real
   domain in production).
4. Add an **authorised redirect URI**: `http://localhost:3000/api/auth/google/callback`.
5. Put the values in `.env`:

   ```
   GOOGLE_CLIENT_ID=1234567890-abcdef.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   ```

6. Restart the server. The **Continue with Google** button appears on the sign-in screen.

The client ID alone is enough for the button (it uses Google Identity Services and
sends an ID token the server verifies). Adding the secret also enables a
server-side redirect flow, used automatically as a fallback when the Google
script cannot load.

## Connecting two people

Both routes end with the same thing: an accepted connection you can share accounts with.

| | How it works | Confirmation |
|---|---|---|
| **Username** | People → *By username* → search → **Connect** | The other person accepts the request |
| **QR code** | People → *My QR code*, other person opens *Scan* | Scanning is the confirmation — you are connected right away |

QR codes expire after 15 minutes (`CONNECT_TOKEN_TTL_SECONDS`) and are single use.
Each code is a link to `/connect/<token>`, so it also works when sent as a plain
link — useful when someone is not in the room. Scanning uses the browser's built-in
`BarcodeDetector`; where that is unavailable the screen falls back to pasting the link.

Once connected, go to **Accounts → share icon** to give someone access to an account.

## Configuration

Everything is read from the environment (see `.env.example`).

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `APP_URL` | `http://localhost:PORT` | Public URL, used for QR links and the OAuth redirect |
| `JWT_SECRET` | dev fallback | Signs session cookies. **Required in production** |
| `JWT_TTL_SECONDS` | `604800` | Session lifetime (one week) |
| `DATABASE_FILE` | `./data/budget.sqlite` | SQLite file location |
| `GOOGLE_CLIENT_ID` | — | Enables the Google button |
| `GOOGLE_CLIENT_SECRET` | — | Also enables the redirect fallback |
| `CONNECT_TOKEN_TTL_SECONDS` | `900` | How long a QR/invite code lasts |
| `DEFAULT_CURRENCY` | `USD` | Currency for new accounts |

## How it is built

No build step, no bundler — a plain Express server and ES modules in the browser.

```
src/
  app.js            Express wiring and error handling
  server.js         Entry point
  config.js         Environment configuration
  db.js             SQLite connection and schema
  lib/
    auth.js         Session cookies and the auth guard
    users.js        User creation, username suggestions, starter data
    google.js       Google ID-token verification and OAuth redirect flow
    access.js       Who can see or edit which account
    connections.js  Connection state between two users
    validate.js     Zod schemas (money is stored as integer cents)
    dates.js        Period maths for budgets and recurring items
  routes/           One router per resource
public/
  index.html        App shell
  styles.css        Design tokens, light and dark
  js/
    app.js          Bootstrap, routes, navigation shell
    store.js        Shared client state
    router.js       History-API router
    ui.js           DOM helpers, modals, toasts, icons, formatting
    api.js          Fetch wrapper
    views/          One module per screen
test/               API tests (node:test)
```

**Money** is stored as integer cents everywhere and only converted at the edges,
so nothing drifts through floating point. **Expenses are negative, income
positive**, which makes a balance a plain `SUM`.

**Access control** lives in `src/lib/access.js`: every account read goes through
`visibleAccounts`, and every write through `requireAccount(..., { write: true })`,
so a shared viewer cannot write and a stranger gets a 404 rather than a hint that
the account exists.

## API sketch

All endpoints are under `/api` and use the session cookie.

```
POST   /api/auth/register            email + password sign-up
POST   /api/auth/login               sign in with email or username
POST   /api/auth/google              sign in / sign up with a Google ID token
GET    /api/auth/google/start        redirect flow (fallback)
POST   /api/auth/google/link         link Google to the signed-in account
POST   /api/auth/password            set or change a password
GET    /api/users/me                 profile (also posts anything recurring that is due)

GET    /api/connections              connected, incoming, outgoing
GET    /api/connections/search?q=    find people by username
POST   /api/connections/requests     request by username
POST   /api/connections/:id/accept   accept a request
POST   /api/connections/qr           create a QR/invite code
GET    /api/connections/qr/:token    preview whose code it is
POST   /api/connections/qr/:token/accept   connect by QR

GET    /api/accounts                 accounts you own or that are shared with you
POST   /api/accounts/:id/shares      share with a connection (viewer | editor)
GET    /api/transactions             filter by account, category, type, date, text
POST   /api/transactions/transfer    move money between accounts
GET    /api/budgets?period=YYYY-MM   budgets with what has been spent
PUT    /api/budgets                  set (or clear with 0) a category budget
GET    /api/goals, /api/recurring    plans
GET    /api/reports/summary          everything the dashboard needs
```

## Notes for deploying

- Set `NODE_ENV=production`, a real `JWT_SECRET`, and an `APP_URL` on HTTPS —
  cookies become `Secure` and QR links point at the right host.
- The SQLite file in `DATABASE_FILE` is the whole database; back it up.
- Run behind a TLS-terminating proxy. Camera access for QR scanning requires
  HTTPS in every browser except on `localhost`.
