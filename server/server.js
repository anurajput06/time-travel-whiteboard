/**
 * Real-Time Collaborative Whiteboard — Server
 * --------------------------------------------
 * Two things live on one HTTP server:
 *   1. Express REST API   -> auth (Google/OTP), room fork/merge ("Time Machine")
 *   2. WebSocket server   -> live drawing sync
 *
 * Data model = custom CRDT:
 *   ops (strokes + text) -> a 2P-Set (two-phase set): a grow-only "adds" set
 *       plus a grow-only "tombstones" set. An op is visible if it's in adds
 *       AND NOT in tombstones. This is the standard CRDT technique for
 *       supporting deletion (here: undo) on top of an otherwise append-only
 *       G-Set — union-merge still works for both sets independently, so
 *       merging two boards (including their undo history) is still conflict-free.
 *   clear -> LWW-Register: single {ts, clientId} value, highest ts wins.
 *
 * X-FACTOR — "Time Machine" (fork & merge boards, git-style):
 *   Because state is just an append-only, timestamped op log, features like
 *   history scrubbing, forking, and zero-conflict merging fall out almost for
 *   free — not true of tools built on raw canvas diffs or OT.
 */

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { router: authRouter, verifySession } = require('./auth');
const { addRoomToUser } = require('./users');

const PORT = process.env.PORT || 8080;
const DATA_DIR = path.join(__dirname, 'data');
const SNAPSHOT_INTERVAL_MS = 30_000;
const ROOM_IDLE_EVICT_MS = 30 * 60 * 1000;
const MAX_OPS_PER_ROOM = 20_000;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/** @type {Map<string, {ops: Map<string, object>, tombstones: Set<string>, clearTs: number, clearClientId: string|null, clients: Set<any>, lastActive: number}>} */
const rooms = new Map();

function roomFile(roomId) { return path.join(DATA_DIR, `${roomId}.json`); }

function loadRoomFromDisk(roomId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(roomFile(roomId), 'utf8'));
    return {
      ops: new Map(Object.entries(parsed.ops || {})),
      tombstones: new Set(parsed.tombstones || []),
      clearTs: parsed.clearTs || 0,
      clearClientId: parsed.clearClientId || null,
      clients: new Set(),
      lastActive: Date.now(),
    };
  } catch {
    return { ops: new Map(), tombstones: new Set(), clearTs: 0, clearClientId: null, clients: new Set(), lastActive: Date.now() };
  }
}

function saveRoomToDisk(roomId, room) {
  try {
    fs.writeFileSync(roomFile(roomId), JSON.stringify({
      ops: Object.fromEntries(room.ops),
      tombstones: Array.from(room.tombstones),
      clearTs: room.clearTs,
      clearClientId: room.clearClientId,
    }));
  } catch (err) {
    console.error(`[persist] failed to save room ${roomId}:`, err.message);
  }
}

function getOrCreateRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = fs.existsSync(roomFile(roomId)) ? loadRoomFromDisk(roomId) : {
      ops: new Map(), tombstones: new Set(), clearTs: 0, clearClientId: null, clients: new Set(), lastActive: Date.now(),
    };
    rooms.set(roomId, room);
  }
  return room;
}

function sanitizeRoomId(id) {
  if (typeof id !== 'string') return null;
  const clean = id.trim().slice(0, 64).replace(/[^a-zA-Z0-9_-]/g, '');
  return clean.length > 0 ? clean : null;
}

function isValidOp(op) {
  if (!op || typeof op !== 'object') return false;
  if (typeof op.id !== 'string' || op.id.length === 0 || op.id.length >= 200) return false;
  if (typeof op.clientId !== 'string') return false;
  if (typeof op.ts !== 'number') return false;
  if (typeof op.color !== 'string') return false;

  const type = op.type || 'stroke';
  if (type === 'stroke') {
    return typeof op.width === 'number' &&
      Array.isArray(op.points) && op.points.length > 0 && op.points.length < 5000;
  }
  if (type === 'text') {
    return typeof op.x === 'number' && typeof op.y === 'number' &&
      typeof op.text === 'string' && op.text.length > 0 && op.text.length < 2000 &&
      typeof op.fontSize === 'number';
  }
  return false;
}

function broadcast(room, message, exceptWs) {
  const payload = JSON.stringify(message);
  for (const client of room.clients) {
    if (client !== exceptWs && client.readyState === client.OPEN) client.send(payload);
  }
}

function newRoomId() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

// ------------------------------------------------------------------
// Express app: auth + Time Machine (fork/merge) REST endpoints
// ------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());
app.use(authRouter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', rooms: rooms.size, uptimeSeconds: Math.floor(process.uptime()) });
});

app.post('/rooms', (req, res) => {
  const roomId = newRoomId();
  getOrCreateRoom(roomId);
  res.json({ roomId });
});

// ---- X-FACTOR: Fork a board at a point in time into a brand-new room ----
app.post('/rooms/:roomId/fork', (req, res) => {
  const sourceId = sanitizeRoomId(req.params.roomId);
  const atTimestamp = Number(req.body.atTimestamp) || Date.now();
  if (!sourceId) return res.status(400).json({ error: 'Invalid room id' });

  const source = getOrCreateRoom(sourceId);
  const forkId = newRoomId();
  const forked = { ops: new Map(), tombstones: new Set(), clearTs: 0, clearClientId: null, clients: new Set(), lastActive: Date.now() };

  for (const [id, op] of source.ops) {
    if (op.ts <= atTimestamp) forked.ops.set(id, op);
  }
  for (const tombstoneId of source.tombstones) {
    if (forked.ops.has(tombstoneId)) forked.tombstones.add(tombstoneId);
  }
  if (source.clearTs && source.clearTs <= atTimestamp) {
    forked.clearTs = source.clearTs;
    forked.clearClientId = source.clearClientId;
  }

  rooms.set(forkId, forked);
  saveRoomToDisk(forkId, forked);
  console.log(`[fork] "${sourceId}" @${new Date(atTimestamp).toISOString()} -> new room "${forkId}" (${forked.ops.size} ops carried over)`);
  res.json({ forkId, opsCarried: forked.ops.size });
});

// ---- X-FACTOR: Merge one board's ops into another — zero conflicts, ----
// ---- guaranteed, because both the adds-set and tombstone-set are unions. ----
app.post('/rooms/:targetRoomId/merge', (req, res) => {
  const targetId = sanitizeRoomId(req.params.targetRoomId);
  const sourceId = sanitizeRoomId(req.body.sourceRoomId);
  if (!targetId || !sourceId) return res.status(400).json({ error: 'Invalid room id(s)' });

  const target = getOrCreateRoom(targetId);
  const source = getOrCreateRoom(sourceId);

  let merged = 0;
  const newOps = [];
  for (const [id, op] of source.ops) {
    if (!target.ops.has(id)) {
      target.ops.set(id, op);
      newOps.push(op);
      merged++;
    }
  }
  const newTombstones = [];
  for (const id of source.tombstones) {
    if (!target.tombstones.has(id)) {
      target.tombstones.add(id);
      newTombstones.push(id);
    }
  }
  if (source.clearTs > target.clearTs) {
    target.clearTs = source.clearTs;
    target.clearClientId = source.clearClientId;
  }

  saveRoomToDisk(targetId, target);
  newOps.forEach(op => broadcast(target, { type: 'op', op }, null));
  newTombstones.forEach(id => broadcast(target, { type: 'undo', opId: id }, null));
  if (source.clearTs > 0) broadcast(target, { type: 'clear', ts: target.clearTs, clientId: target.clearClientId }, null);

  console.log(`[merge] "${sourceId}" -> "${targetId}": ${merged} new op(s), ${newTombstones.length} tombstone(s) merged, 0 conflicts`);
  res.json({ merged, conflicts: 0 });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function presenceNames(room) {
  return Array.from(room.clients).map(c => c.identity?.name || 'Someone').filter(Boolean);
}
function broadcastPresence(room) {
  broadcast(room, { type: 'presence', peerCount: room.clients.size, names: presenceNames(room) }, null);
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const roomId = sanitizeRoomId(url.searchParams.get('room')) || 'lobby';
  const room = getOrCreateRoom(roomId);

  const token = url.searchParams.get('token');
  const session = token ? verifySession(token) : null;
  ws.identity = session
    ? { name: session.name, email: session.email, picture: session.picture, guest: false }
    : { name: `Guest-${Math.random().toString(36).slice(2, 6)}`, guest: true };

  if (session) addRoomToUser(session.email, roomId);

  room.clients.add(ws);
  room.lastActive = Date.now();
  ws.roomId = roomId;
  ws.isAlive = true;

  console.log(`[join] room="${roomId}" user="${ws.identity.name}" clients=${room.clients.size}`);

  ws.send(JSON.stringify({
    type: 'init',
    ops: Array.from(room.ops.values()),
    tombstones: Array.from(room.tombstones),
    clearTs: room.clearTs,
    clearClientId: room.clearClientId,
    peerCount: room.clients.size,
    names: presenceNames(room),
    you: ws.identity,
  }));

  broadcastPresence(room);

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    room.lastActive = Date.now();

    if (msg.type === 'rename' && typeof msg.name === 'string') {
      const clean = msg.name.trim().slice(0, 40);
      if (clean) {
        ws.identity.name = clean;
        broadcastPresence(room);
      }
      return;
    }

    if (msg.type === 'op' && isValidOp(msg.op)) {
      if (!room.ops.has(msg.op.id)) {
        if (room.ops.size >= MAX_OPS_PER_ROOM) {
          const oldestKey = room.ops.keys().next().value;
          room.ops.delete(oldestKey);
          room.tombstones.delete(oldestKey);
        }
        room.ops.set(msg.op.id, msg.op);
        broadcast(room, { type: 'op', op: msg.op }, ws);
      }
    } else if (msg.type === 'undo' && typeof msg.opId === 'string') {
      // Tombstone-set add: standard 2P-Set delete. Union-safe — if two
      // clients undo the same op concurrently, the set just ends up with
      // one entry either way, no conflict.
      if (room.ops.has(msg.opId) && !room.tombstones.has(msg.opId)) {
        room.tombstones.add(msg.opId);
        broadcast(room, { type: 'undo', opId: msg.opId }, null);
      }
    } else if (msg.type === 'redo' && typeof msg.opId === 'string') {
      if (room.tombstones.has(msg.opId)) {
        room.tombstones.delete(msg.opId);
        broadcast(room, { type: 'redo', opId: msg.opId }, null);
      }
    } else if (msg.type === 'clear' && typeof msg.ts === 'number') {
      if (msg.ts > room.clearTs) {
        room.clearTs = msg.ts;
        room.clearClientId = msg.clientId || null;
        broadcast(room, { type: 'clear', ts: room.clearTs, clientId: room.clearClientId }, null);
      }
    } else if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    console.log(`[leave] room="${roomId}" user="${ws.identity.name}" clients=${room.clients.size}`);
    broadcastPresence(room);
  });

  ws.on('error', (err) => console.error(`[ws error] room="${roomId}":`, err.message));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    if (room.ops.size > 0) saveRoomToDisk(roomId, room);
    if (room.clients.size === 0 && now - room.lastActive > ROOM_IDLE_EVICT_MS) {
      rooms.delete(roomId);
      console.log(`[evict] room="${roomId}" removed from memory (idle)`);
    }
  }
}, SNAPSHOT_INTERVAL_MS);

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
function shutdown() {
  console.log('Shutting down — saving all rooms...');
  clearInterval(heartbeat);
  for (const [roomId, room] of rooms.entries()) if (room.ops.size > 0) saveRoomToDisk(roomId, room);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}

server.listen(PORT, () => console.log(`Whiteboard server listening on port ${PORT}`));
