# Collab Whiteboard

Real-time collaborative whiteboard. Open a link, draw, anyone else with the
same link sees it live. Built with a custom CRDT instead of a library like
Yjs, so undo/redo, history scrubbing, and merging two boards together all
come from the same data model.

## How it works

- **Ops (strokes + text) are a 2P-Set**: an append-only "adds" set plus a
  "tombstones" set. An op is visible if it's added and not tombstoned.
  Undo = tombstone your last op. Redo = un-tombstone it. Merging two boards
  is just a union of both sets — no conflict resolution logic needed.
- **Clear** is a last-write-wins register (`{ts, clientId}`).
- On connect, a client gets the full current op log (not a diff) — simplest
  correct approach at this scale (thousands of ops, not millions).
- Board background is a local-only preference (`localStorage`), not synced —
  each person can pick their own without affecting anyone else.
- Eraser uses real canvas transparency (`destination-out`), not a hardcoded
  paint color, so it works under any background.
- Presence (who's in the room) and display names are per-connection, sent
  from the server on join/leave/rename.

**Rooms vs. Fork/Merge:** same room link = automatic live sync. Different
room codes are separate boards by design — Fork/Merge is a manual action to
combine two of them, not continuous syncing between two different rooms.

## Features

- Pen / Marker / Highlighter / Eraser / Text, custom colors, adjustable size
- Undo / Redo
- Time Machine: scrub board history, fork a moment into a new board, merge
  another board in
- Save board as PNG
- Editable display name (session-only for now, not saved to your account)
- Presence list — click the "N people here" pill to see who's connected
- Collapsible activity log and Time Machine panel, so the board can use the
  full window if you don't need them open
- Google Sign-In + email OTP, or just continue as a guest — auth is
  optional, never required to draw or collaborate

## Auth setup

**Google Sign-In**
1. [Google Cloud Console](https://console.cloud.google.com/) → new project
2. OAuth consent screen → External → fill basic info → save
3. Credentials → Create Credentials → OAuth client ID → Web application
4. Authorized JavaScript origins: add your frontend URL(s) — e.g.
   `http://localhost:5173` and your deployed Netlify URL
5. Copy the Client ID into `client/config.js` (`GOOGLE_CLIENT_ID`) **and**
   as a `GOOGLE_CLIENT_ID` env var on the server — both must match exactly,
   or you'll get "Invalid Google credential" (audience mismatch). If you've
   double-checked both values and it's still failing, check the server log
   line `[auth] GOOGLE_CLIENT_ID loaded: ...` against what's really in
   `config.js`, and confirm your deployed origin is in the list above.

**Email OTP**
Uses Brevo's HTTP API, not SMTP — Render (and most free PaaS hosts) block
outbound SMTP ports on free tiers, so SMTP-based email won't work there.
1. Free account at [brevo.com](https://www.brevo.com) (300 emails/day, no card)
2. Senders → add and verify a single sender email (just a confirmation link,
   no DNS)
3. Settings → SMTP & API → API Keys → generate one
4. Set `BREVO_API_KEY` and `BREVO_SENDER_EMAIL` env vars

No `BREVO_API_KEY` set → OTP is logged to the server console instead
(local dev only).

**`JWT_SECRET`**: any long random string, signs session tokens. Override the
default in production.

## Run locally

```bash
cd server
npm install
npm start                 # :8080

cd ../client
npx serve -l 5173         # or: python3 -m http.server 5173
```
`client/config.js` points at `localhost:8080` by default.

```bash
cd server
node test-client.js       # sanity check: two fake clients converge
```

## Deploy (free)

**Backend → Render**: push to GitHub, Render → New → Blueprint → point at
the repo (`render.yaml` is already set up). Add env vars:
`GOOGLE_CLIENT_ID`, `JWT_SECRET`, `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`.

Free tier notes: spins down after ~15 min idle (wakes in 30-60s on next
request, reconnect logic handles this); disk is wiped on redeploy, so room
snapshots don't survive a redeploy, only a restart.

**Frontend → Netlify**: update `client/config.js` with your Render URL
(`https://` / `wss://`), then drag the `client/` folder onto
[app.netlify.com/drop](https://app.netlify.com/drop). Add the Netlify URL to
the Google OAuth client's authorized origins too.

## Known limitations

- Single server instance — no Redis pub/sub, so this doesn't horizontally
  scale past one instance as-is
- JSON file snapshots instead of a real database
- No automated test suite beyond the one convergence script
- No rate limiting on the OTP endpoint
- Renamed display names aren't persisted for signed-in users past the
  current session

## Structure
```
server/
  server.js       # Express + WebSocket, rooms, CRDT merge, fork/merge, persistence
  auth.js         # Google verify + OTP + JWT sessions
  users.js        # file-backed user store
  emailService.js # Brevo API
  test-client.js
client/
  index.html, style.css, app.js, auth-client.js, config.js
render.yaml
docker-compose.yml
```
