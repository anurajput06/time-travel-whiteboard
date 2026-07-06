# Real-Time Collaborative Whiteboard

A whiteboard where anyone, from anywhere, can open a link and draw together
in real time — no conflicts, ever — plus a feature no mainstream whiteboard
tool offers: **git-style time travel, forking, and merging of boards.**

>anyone who opens the *same* room link (`?room=xxxx`) collaborates live 
>automatically — that's the core real-time feature. 
>Fork and Merge are a separate, deliberate action for
> combining two otherwise-*independent* boards (different room codes) — they
> don't auto-sync with each other, because the whole point is that they stay
> independent until you choose to merge them.

## What's in the UI

- **Light-mode, floating toolbar** — a single card (colors, three brush types,
  Text, Eraser, stroke size, Undo/Redo, background, Clear) that scrolls
  internally if it's taller than the window, so it never overlaps other
  panels — all controls have visible labels, not just icons.
- **Undo / Redo** — this extends the G-Set CRDT into a **2P-Set** (two-phase
  set): a grow-only "adds" set plus a grow-only "tombstones" set. An op is
  visible if it's in adds and *not* in tombstones. Undo = add your last op's
  id to the tombstone set; redo = remove it. Both sets still merge as unions,
  so undo history stays conflict-free across forks/merges too.
- **Text tool** — a `text` op sits in the exact same append-only log as
  strokes (`{id, type:'text', x, y, text, color, fontSize, ts}`), so every
  Time Machine feature (scrub/fork/merge) already works on text for free —
  no special-casing needed.

- **Personal board background** — a purely local preference (saved in your
  browser only, via `localStorage`) — pick any color and it's yours alone;
  nobody else in the room sees it change. The eraser uses true canvas
  transparency (`globalCompositeOperation: 'destination-out'`), not a
  hardcoded paint color, so it looks correct no matter what background you
  or anyone else has chosen.
- **Collapsible activity log** — hit "Hide" to close the right-hand log panel
  and give the board the full width; a floating "Show log" button brings it
  back. Your choice is remembered (`localStorage`) across reloads.
- **Recognizable per-tool cursors** — an actual pencil-shaped cursor for Pen,
  a marker-shaped cursor for Marker, a chisel-tip shape for Highlighter, and
  an eraser shape for Eraser — all tinted with your current color — instead
  of a generic dot.
- **Save as image** — one click downloads the current board as a PNG
  (background + drawing composited together), ready to share on WhatsApp,
  email, or anywhere else.
- **Custom pen color** — beyond the 6 presets, a color-wheel swatch opens a
  native color picker for any pen color.

## The X-factor: Board Time Machine

Every stroke is stored as an independent, timestamped, append-only operation
(a **G-Set CRDT** — see Architecture below). That data model is normally just
"how you avoid merge conflicts" — but it also means three genuinely unique
features fall out almost for free, which is **not** true of tools built on
raw canvas diffs or operational transforms (Miro, FigJam, Excalidraw, tldraw
don't offer any of this):

1. **Scrub the board's history.** Drag the Time Machine slider and watch the
   board rebuild itself stroke-by-stroke from the first mark to now. No
   backend work — it's a client-side filter on timestamps over data you
   already have.
2. **Fork a board at any point in time.** Hit "Fork board at this point" and
   get a brand-new, fully independent room seeded with only the strokes drawn
   before that instant — perfect for letting a sub-team branch off and
   experiment without touching the main board.
3. **Merge two boards with zero conflicts — guaranteed.** Paste in another
   room's code and hit merge. Because both boards are G-Sets, merging is
   literally a set union: every stroke from the source that the target
   doesn't already have gets added. There is no such thing as a "merge
   conflict" here — it's mathematically impossible by construction, not just
   handled gracefully.

**Why this matters for interviews:** this isn't a bolted-on feature — it's
the direct payoff of choosing a conflict-free data model up front. That's a
strong, concrete answer to "tell me about a time your architecture decision
paid off later."

## Architecture

```
┌──────────────┐        WebSocket (drawing sync)      ┌────────────────────┐
│   Browser     │◀────────────────────────────────────▶│   Node.js server    │
│  client/      │        REST (auth, fork, merge)       │   server/            │
│  Canvas + JS  │──────────────────────────────────────▶│  Express + ws        │
└──────────────┘                                        │  rooms: Map          │
                                                         │  per-room op log      │
                                                         │  (G-Set + LWW clear)  │
                                                         │  + disk snapshot       │
                                                         └────────────────────┘
```

- **Ops (strokes + text) → 2P-Set** (two-phase set): a grow-only "adds" set
  plus a grow-only "tombstones" set. An op is visible if it's in adds and
  *not* in tombstones — this is what powers Undo/Redo, and merge is still
  just a union of both sets, so it stays conflict-free.
- **Clear → LWW-Register**: `{ts, clientId}`, highest timestamp wins.
- Text boxes are just another op type in the same log
  (`{id, type:'text', x, y, text, color, fontSize, ts}`) — Time Machine,
  fork, and merge all work on them automatically, no special-casing.
- On connect, a client gets the server's **full current room state** (state
  transfer, not delta) — the simplest correct sync strategy at whiteboard
  scale (thousands of ops, not millions).
- The server **dedups by op id**, so resending ops after a reconnect is
  always safe (idempotent) — this is what makes offline/reconnect handling
  trivial, and what makes merge conflict-free.
- Rooms snapshot to disk every 30s (swap for Postgres/S3 in production — see
  "Scaling up").
- **Board background is local-only** — a per-browser `localStorage`
  preference, never sent to the server. Nobody else in the room sees your
  background change, by design.
- **Eraser uses true transparency**
  (`ctx.globalCompositeOperation = 'destination-out'`), not a hardcoded paint
  color — so it looks correct under any background, including ones you
  change after the fact.

## Auth: Google Sign-In + Email OTP (passwordless)

**Auth is additive, never a gate.** Anyone can open a room link and draw
immediately as a guest — "anyone from anywhere can collaborate in real time"
always holds. Signing in just attaches your real name/avatar to your strokes
and (if you extend it) unlocks a "My Boards" history via `users.js`.

### Setting up Google Sign-In (free)
1. Go to the [Google Cloud Console](https://console.cloud.google.com/) →
   create a project (or use an existing one).
2. **APIs & Services → OAuth consent screen** → set it up as "External," add
   your app name/email (you can leave it in "Testing" mode for personal use —
   no review needed for a handful of test users).
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID** →
   Application type: **Web application**.
   - Authorized JavaScript origins: add your frontend URL (e.g.
     `http://localhost:5173` for local dev, and your Netlify URL once deployed).
   - No redirect URI needed — Google Identity Services (the button-based flow
     this project uses) doesn't require one.
4. Copy the **Client ID** it gives you into `client/config.js` →
   `GOOGLE_CLIENT_ID`.
5. Set the same value as the `GOOGLE_CLIENT_ID` environment variable on your
   **server** deployment (Render) — the server independently verifies every
   Google credential against this ID; it never trusts the client blindly.

### Setting up Email OTP (free)
The server needs to send a 6-digit code to the user's inbox. Two ways to do
this without paying anything:

**Option A — Gmail SMTP (uses your own Gmail account to send)**
1. Turn on 2-Step Verification on the Gmail account you'll send from.
2. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
   and generate an **App Password** (16 characters, no spaces) — this is
   *not* your normal Gmail password.
3. Set these env vars on your server deployment:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_USER=youraccount@gmail.com
   SMTP_PASS=<the 16-char app password>
   ```
Gmail's free sending limit is generous for a student project (~500/day),
which is far more than a demo needs.

**Option B — A free transactional email provider** (Resend, Brevo, etc.) —
sign up, grab their SMTP credentials, and set the same four env vars pointed
at their host/port/user/pass instead.

**No SMTP configured?** The server automatically falls back to logging the
OTP to its own console — useful for local development, but you must set real
SMTP credentials before sharing the deployed link with anyone else, or
they'll have no way to see their code.

**If sending fails**, the server now returns a specific, actionable reason
instead of a generic error — e.g. it will tell you if the login was rejected
(wrong App Password) versus if it couldn't reach the SMTP host at all (wrong
host/port, or a network/firewall block). Check the server terminal for the
full underlying error if you need more detail.

### JWT session secret
Set a `JWT_SECRET` env var on the server to any long random string — this
signs the session tokens. The code ships with a dev fallback, but **you must
override it in production** or anyone could forge a session.

## Run it locally

```bash
cd server
npm install
npm start                 # ws + REST API on :8080

# in a second terminal
cd ../client
npx serve -l 5173         # or: python3 -m http.server 5173
```
Open `http://localhost:5173`. `client/config.js` already points at
`http://localhost:8080` / `ws://localhost:8080` by default.

**Or with Docker Compose:** `docker compose up --build` (server on `:8080`,
client on `:5173`).

### Sanity-check the server without a browser
```bash
cd server
node test-client.js   # spins up two fake clients, proves they converge
```

## Free deployment

### 1. Backend → Render.com free tier
1. Push to GitHub, then on [render.com](https://render.com) → **New →
   Blueprint** → point at your repo (`render.yaml` already configures it —
   root dir `server`, free plan, health check on `/health`).
2. Add environment variables in the Render dashboard:
   `GOOGLE_CLIENT_ID`, `JWT_SECRET`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
   `SMTP_PASS` (see Auth setup above).
3. Your WebSocket/API URL will be
   `https://whiteboard-server-xxxx.onrender.com` (use `wss://` for the socket).

   **Free-tier caveats:**
   - Spins down after ~15 min idle; wakes in ~30-60s on the next request —
     the client's reconnect-with-backoff handles this transparently.
   - **Disk is ephemeral** — the JSON room snapshots do NOT survive a
     redeploy (only a same-instance restart). Fine for a demo; use Postgres
     for boards that must survive redeploys (see "Scaling up").

### 2. Frontend → Netlify
1. Edit `client/config.js`:
   ```js
   window.WHITEBOARD_CONFIG = {
     SERVER_HTTP_URL: "https://whiteboard-server-xxxx.onrender.com",
     SERVER_WS_URL: "wss://whiteboard-server-xxxx.onrender.com",
     GOOGLE_CLIENT_ID: "your-real-client-id.apps.googleusercontent.com"
   };
   ```
2. Drag-and-drop `client/` onto [app.netlify.com/drop](https://app.netlify.com/drop),
   or connect the repo with **Base directory: `client`** (no build command,
   it's static files).
3. Add your Netlify URL to the Google Cloud OAuth client's "Authorized
   JavaScript origins" (step 3 of Auth setup above), or Google Sign-In will
   reject requests from it.

Share `https://your-site.netlify.app/?room=anything` — anyone who opens that
link joins the same board instantly, signed in or not.

## Scaling up

- **Redis pub/sub** once you run 2+ server instances — each instance
  broadcasts ops locally, so cross-instance clients need Redis to relay them.
- **Postgres instead of JSON snapshots** — needed the moment you're on a
  platform with ephemeral disk and want boards to survive redeploys.
- **Sticky sessions / consistent hashing by roomId** — reduces cross-instance
  broadcast traffic once you scale horizontally.
- **Rate limiting on `/auth/otp/request`** — currently unthrottled per email;
  add an IP-based limiter before this is public-facing at scale.

## Project structure
```
whiteboard-project/
├── server/
│   ├── server.js        # Express + WebSocket: rooms, CRDT merge, fork/merge, persistence
│   ├── auth.js            # Google verify + Email OTP + JWT session routes
│   ├── users.js           # file-backed user store (upsert by email)
│   ├── emailService.js    # SMTP sender with console-log dev fallback
│   ├── test-client.js     # convergence sanity check (2 simulated clients)
│   ├── package.json
│   └── Dockerfile
├── client/
│   ├── index.html
│   ├── style.css
│   ├── config.js          # <- server URLs + Google Client ID go here
│   ├── auth-client.js      # Google Identity Services + OTP flow + session storage
│   └── app.js               # canvas drawing + WebSocket client + Time Machine UI
├── docker-compose.yml
├── render.yaml             # Render.com one-click blueprint
└── README.md
```
