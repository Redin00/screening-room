# Screening Room

A private "watch together" web app:

- A **host** creates a room and uploads a video (video files only).
- Everyone else joins with the room code and watches **in sync** — play,
  pause, and seek follow the host live, over WebSockets.
- **No email signup.** People pick a profile from a Netflix-style "who's
  watching" screen. Profiles are created only by an admin, and only
  profiles with hosting permission can create rooms — this is what stops
  random visitors from spamming the server with uploads.
- Uploaded video files are **deleted automatically** a configurable number
  of minutes after a room ends, so the disk doesn't fill up.

## Stack

Plain Node.js — no build step, no framework lock-in:

- **Express** for the HTTP API and static file serving
- **Socket.IO** for realtime playback sync
- **`node:sqlite`** (Node's built-in SQLite module) for storage (profiles +
  rooms), a single file on disk — no native compilation, no C++ build step
- **express-session** for login sessions (in-memory store by default — see
  "Scaling notes" below)
- **multer** for uploads, restricted to video file extensions/MIME types
- Vanilla HTML/CSS/JS on the frontend (`public/`), no bundler required

> Requires **Node 22.5 or newer** (when `node:sqlite` was introduced). It's
> still marked experimental by Node itself — you'll see one warning line on
> startup, which is expected and harmless. Check your version with
> `node --version` before installing.

## Getting started

```bash
npm install
cp .env.example .env   # then edit values, especially SESSION_SECRET
npm start
```

On first run, since there are no profiles yet, the server creates a
bootstrap **admin** profile and prints its PIN once to the console:

```
============================================
 No profiles existed yet — created a bootstrap admin:
   Profile name: Admin
   PIN:          123456
============================================
```

Open `http://localhost:3000`, sign in as Admin with that PIN, go to
**Admin** in the top bar, and create real profiles for the people you're
sharing this with — deciding per-profile whether they can host rooms.
Consider disabling or deleting the bootstrap Admin profile once you've
created your own.

## How the pieces fit together

```
public/            → served as static files; index.html is the profile
                      picker, lobby.html lists/creates rooms, room.html is
                      the synced player, admin.html manages profiles
server/index.js    → wires up Express, sessions, Socket.IO, routes
server/db.js       → SQLite schema + first-run admin bootstrap
server/routes/     → profiles (login), admin (profile mgmt), rooms
server/sockets/    → the realtime sync protocol (see below)
server/cleanup/    → the file-deletion scheduler + periodic safety sweep
server/upload.js   → multer config: extension + MIME allowlist, size limit
```

### Accounts model

There's no username/password/email flow. `profiles` are rows an admin
creates, each with:
- a display name and color (shown as an avatar initial),
- an optional numeric PIN (4–8 digits) — profiles without one need just a
  tap to select, like a household's "Kids" profile,
- `can_host` — whether this profile is allowed to create rooms,
- `is_admin` — whether this profile can manage other profiles.

Selecting a profile (plus its PIN, if set) starts a normal server-side
session (`express-session`), which is what both the REST API and the
Socket.IO connection check on every request.

### Room lifecycle

1. A profile with `can_host` calls `POST /api/rooms` → gets back a short
   room code (e.g. `PAVTCS`).
2. The host uploads a video via `POST /api/rooms/:code/upload`. Only one
   active video per room; uploading a new one replaces (and immediately
   deletes) the old file.
3. Anyone signed in can join with the code. Video is streamed with proper
   HTTP range support (`GET /api/rooms/:code/media`), so scrubbing works.
4. Playback is **host-authoritative**: only the host's player controls are
   live; viewers' players are driven by `room:control` events over
   Socket.IO (play/pause/seek + a periodic heartbeat to correct drift).
   A late joiner triggers a `room:sync-request` so the host immediately
   reports its current position.
5. The host clicks **End screening** (`POST /api/rooms/:code/end`), which
   marks the room closed and schedules the video for deletion.

### Cleanup

`server/cleanup/scheduler.js` does two things:
- **Per-room timers**: when a room closes, a `setTimeout` deletes its video
  after `DELETE_DELAY_MINUTES` (default 10).
- **A periodic sweep** (`CLEANUP_SWEEP_MINUTES`) that (a) catches any
  deletion that was overdue because the process restarted and lost its
  in-memory timers, and (b) auto-closes "orphaned" rooms whose host has
  been gone for more than `ORPHAN_ROOM_MINUTES`, so an abandoned tab
  doesn't leave a video on disk indefinitely.

## Configuration (`.env`)

See `.env.example` for the full list — the ones worth knowing:

| Variable | Meaning |
|---|---|
| `SESSION_SECRET` | Change this before deploying anywhere public. |
| `DELETE_DELAY_MINUTES` | How long after a room ends before its file is deleted. |
| `ORPHAN_ROOM_MINUTES` | Auto-close a room if its host disappears for this long. |
| `MAX_UPLOAD_MB` | Upload size cap. |
| `ADMIN_BOOTSTRAP_PIN` | Set this to control the first admin's PIN instead of a random one. |

## Deploying to a VPS

This is a single Node process with a SQLite file and a local `uploads/`
folder — no external services required.

1. Copy the project, `npm install --omit=dev` (or just `npm install`),
   `cp .env.example .env` and edit it.
2. Run it behind a process manager (e.g. `pm2 start server/index.js`, or a
   systemd unit) so it restarts if it crashes.
3. Put a reverse proxy in front (nginx/Caddy) for TLS. If you do,
   remember to raise `client_max_body_size` (nginx) to at least
   `MAX_UPLOAD_MB`, and make sure the proxy doesn't buffer the whole
   upload/video stream — both need range-request passthrough for large
   files.
4. Because uploads and the SQLite file live on local disk, this app is
   designed to run as **one instance**. Don't load-balance it across
   multiple servers without moving storage to something shared first.

## Scaling notes / known simplifications

These are deliberate MVP choices, called out so they're easy to revisit:

- **Sessions are in-memory** (`express-session`'s default `MemoryStore`).
  Fine for one process; restarting the server logs everyone out. Swap in
  a persistent store (e.g. `connect-sqlite3`, `connect-redis`) if you need
  sessions to survive restarts or run multiple processes.
- **`node:sqlite` is experimental** in Node's own words — it's been stable
  enough for this app's needs, but if you'd rather depend on a longer-track
  library, swapping back to `better-sqlite3` only touches `server/db.js`
  (same `.prepare().get()/.run()/.all()` shape). That does bring back a
  native addon that needs compiling for your platform/Node version, which
  is exactly what `node:sqlite` avoids.
- **One video per room.** Uploading again replaces the current one. A
  queue/playlist per room would be a natural next step.
- **Host-authoritative sync only** — viewers can't take control. That's a
  deliberate simplicity trade-off for consistency; a "let anyone control
  playback" mode would need conflict resolution.
- **No chat.** Left out to keep scope focused; the Socket.IO room
  (`server/sockets/roomSocket.js`) is a natural place to add a `room:chat`
  event if you want one.
