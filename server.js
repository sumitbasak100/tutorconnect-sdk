"use strict";

/**
 * TutorConnect SDK — Server v4
 * Fixes applied:
 * - Page ID collision: crypto random IDs instead of sequential numbers
 * - Board payload size: pages sent separately via /api/rooms/:id/board, not in identity-confirmed
 * - Per-session command cap: max 50,000 total commands across all pages
 * - Draw command validation: type/coord whitelist before storage
 * - Rate limiting: draw events throttled per socket
 * - Session expiry warning: server emits 5-min warning before cleanup
 * - Keepalive endpoint for Railway free tier
 * - Proper logging with LOG_LEVEL env var
 * - endSession by userId supported
 * - CORS locked down via ALLOWED_ORIGINS env var
 */

const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");
const cors    = require("cors");
const crypto  = require("crypto");
const path    = require("path");

const app    = express();
const server = http.createServer(app);

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(s => s.trim())
  : "*";

const LOG_LEVEL = process.env.LOG_LEVEL || "info"; // "info" | "debug" | "none"
function log(...args)  { if (LOG_LEVEL !== "none") console.log("[TC]", ...args); }
function dbg(...args)  { if (LOG_LEVEL === "debug") console.log("[TC:debug]", ...args); }
function err(...args)  { console.error("[TC:error]", ...args); }

const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, methods: ["GET", "POST", "DELETE"] },
  pingTimeout:       30000,
  pingInterval:      10000,
  maxHttpBufferSize: 5e6,
  transports:        ["websocket", "polling"],
});

app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: "500kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────
const rooms = new Map(); // roomId → room
const peers = new Map(); // socketId → { userId, name, role, roomId }

// Per-socket draw rate limiting
const drawRateMap = new Map(); // socketId → { count, windowStart }
const DRAW_RATE_LIMIT = 200;   // max draw events per second per socket
const MAX_CMDS_PER_SESSION = 50000; // total across all pages

function ts() { return new Date().toISOString(); }

function newPageId() {
  return crypto.randomBytes(3).toString("hex"); // e.g. "a3f9c1" — no collision
}

function countAllCmds(room) {
  return Object.values(room.pages).reduce((acc, p) => acc + p.length, 0);
}

// Validate a draw command — reject anything suspicious
const VALID_TYPES = new Set(["stroke","line","rect","circ","arrow","text","clear"]);
function validateCmd(data) {
  if (!data || typeof data !== "object") return false;
  if (!VALID_TYPES.has(data.type)) return false;
  // All numeric fields must be finite numbers in valid range
  const numFields = ["nx0","ny0","nx1","ny1","ncx","ncy","nrx","nry","nx","ny","size"];
  for (const f of numFields) {
    if (f in data) {
      const v = data[f];
      if (typeof v !== "number" || !isFinite(v) || v < -10 || v > 10) return false;
    }
  }
  if ("size" in data && (data.size < 0.001 || data.size > 0.1)) return false;
  if ("color" in data && (typeof data.color !== "string" || data.color.length > 20)) return false;
  if ("text"  in data && (typeof data.text  !== "string" || data.text.length  > 500)) return false;
  if ("pageId" in data && (typeof data.pageId !== "string" || data.pageId.length > 20)) return false;
  return true;
}

// ─────────────────────────────────────────────
// Auto-cleanup + expiry warnings
// ─────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  const warnAt  = 4 * 60 * 60 * 1000 - 5 * 60 * 1000; // warn 5 min before expiry
  const cleanAt = 4 * 60 * 60 * 1000;

  for (const [id, room] of rooms) {
    const age = now - new Date(room.createdAt).getTime();

    // Send 5-minute warning
    if (age >= warnAt && !room.expiryWarnSent) {
      room.expiryWarnSent = true;
      io.to(id).emit("session-expiry-warning", { minutesLeft: 5 });
    }

    // Clean up
    if (age >= cleanAt && Object.keys(room.activePeers).length === 0) {
      rooms.delete(id);
      log(`Cleaned up idle room ${id}`);
    }
  }
}, 60 * 1000);

// Railway keepalive — prevents free-tier sleep
app.get("/ping", (_req, res) => res.json({ ok: true, t: Date.now() }));

// ─────────────────────────────────────────────
// Global safety net
// ─────────────────────────────────────────────
process.on("uncaughtException",  e => err("uncaughtException",  e.message));
process.on("unhandledRejection", r => err("unhandledRejection", r));

// ─────────────────────────────────────────────
// REST API
// ─────────────────────────────────────────────
function getBase(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host  = req.headers["x-forwarded-host"]  || req.get("host");
  return `${proto}://${host}`;
}

// POST /api/rooms — create session
app.post("/api/rooms", (req, res) => {
  try {
    const { tutor, student, metadata = {} } = req.body || {};
    if (!tutor?.userId  || !tutor?.name)    return res.status(400).json({ error: "tutor.userId and tutor.name required" });
    if (!student?.userId || !student?.name) return res.status(400).json({ error: "student.userId and student.name required" });
    if (tutor.userId === student.userId)    return res.status(400).json({ error: "tutor and student cannot share the same userId" });

    const roomId       = crypto.randomBytes(8).toString("hex");
    const firstPageId  = newPageId();
    const base         = getBase(req);

    rooms.set(roomId, {
      roomId,
      createdAt:       ts(),
      status:          "waiting",
      metadata,
      drawPermission:  false,
      expiryWarnSent:  false,
      participants: {
        [tutor.userId]: {
          userId: tutor.userId, name: tutor.name, role: "tutor",
          joined: false, joinedAt: null, leftAt: null, socketId: null,
        },
        [student.userId]: {
          userId: student.userId, name: student.name, role: "student",
          joined: false, joinedAt: null, leftAt: null, socketId: null,
        },
      },
      activePeers:  {},                          // socketId → userId
      pages:        { [firstPageId]: [] },        // pageId → [cmds]
      activePage:   firstPageId,
      pageOrder:    [firstPageId],               // ordered list of page IDs
    });

    const tutorJoinUrl   = `${base}/session/${roomId}/${encodeURIComponent(tutor.userId)}`;
    const studentJoinUrl = `${base}/session/${roomId}/${encodeURIComponent(student.userId)}`;

    res.status(201).json({
      success: true,
      roomId,
      tutorJoinUrl,
      studentJoinUrl,
      embedCode: `<iframe src="${tutorJoinUrl}" allow="camera;microphone" style="width:100%;height:620px;border:none;border-radius:12px;"></iframe>`,
    });

    log(`Room created: ${roomId}`);
  } catch (e) {
    err("POST /api/rooms", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/rooms", (_req, res) => {
  // Don't expose session count
  res.json({ success: true });
});

app.get("/api/rooms/:roomId", (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });
  // Return room info without full board data (board fetched separately)
  const { pages: _p, ...safe } = room;
  res.json({ success: true, room: safe });
});

// Separate endpoint for board data — avoids overloading identity-confirmed socket msg
app.get("/api/rooms/:roomId/board", (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });
  res.json({ success: true, pages: room.pages, activePage: room.activePage, pageOrder: room.pageOrder });
});

app.get("/api/rooms/:roomId/summary", (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });
  res.json({
    success: true,
    roomId:  room.roomId,
    status:  room.status,
    createdAt: room.createdAt,
    metadata: room.metadata,
    participants: Object.values(room.participants).map(p => ({
      name: p.name, role: p.role, userId: p.userId,
      joinedAt: p.joinedAt || "Did not join",
      leftAt:   p.leftAt   || (p.joinedAt ? "Still in session" : "—"),
    })),
  });
});

app.delete("/api/rooms/:roomId", (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (room) room.status = "ended";
  io.to(req.params.roomId).emit("session-ended", { reason: "Session ended by host" });
  log(`Room ended: ${req.params.roomId}`);
  res.json({ success: true });
});

// Session page
app.get("/session/:roomId/:userId", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "session.html"));
});

// Lobby page
app.get("/lobby/:roomId/:userId", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "lobby.html"));
});

app.get("/sdk.js", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "sdk.js"));
});

app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// ─────────────────────────────────────────────
// Socket.io
// ─────────────────────────────────────────────
io.on("connection", socket => {

  // ── Join ──────────────────────────────────
  socket.on("join-room", ({ roomId, userId }) => {
    try {
      const room = rooms.get(roomId);
      if (!room)                   return socket.emit("join-error", { message: "Session not found. It may have expired." });
      if (room.status === "ended") return socket.emit("join-error", { message: "This session has already ended." });
      const participant = room.participants[userId];
      if (!participant)            return socket.emit("join-error", { message: "You are not authorised to join this session." });

      const { name, role } = participant;

      peers.set(socket.id, { userId, name, role, roomId });
      room.activePeers[socket.id] = userId;

      participant.joined   = true;
      participant.joinedAt = participant.joinedAt || ts();
      participant.leftAt   = null;
      participant.socketId = socket.id;

      socket.join(roomId);

      if (Object.keys(room.activePeers).length >= 2) room.status = "active";

      socket.to(roomId).emit("peer-joined", { peerId: socket.id, userId, name, role });

      // identity-confirmed does NOT include board data (fetched via HTTP separately)
      socket.emit("identity-confirmed", {
        userId,
        name,
        role,
        participants:   room.participants,
        drawPermission: room.drawPermission,
        activePage:     room.activePage,
        pageOrder:      room.pageOrder,
        connectedPeers: Object.values(room.activePeers)
          .map(uid => room.participants[uid])
          .filter(p => p && p.userId !== userId),
      });

      log(`JOIN: ${name} (${role}) → ${roomId}`);
    } catch (e) {
      err("join-room", e);
      socket.emit("join-error", { message: "Failed to join. Please refresh and try again." });
    }
  });

  // ── WebRTC — perfect negotiation pattern ──
  // polite = student (yields on collision); impolite = tutor (wins on collision)
  socket.on("offer", ({ roomId, offer, polite }) => {
    socket.to(roomId).emit("offer", { offer, from: socket.id, polite });
  });
  socket.on("answer",        ({ roomId, answer })    => socket.to(roomId).emit("answer",        { answer }));
  socket.on("ice-candidate", ({ roomId, candidate }) => socket.to(roomId).emit("ice-candidate", { candidate }));
  socket.on("renegotiate",   ({ roomId })            => socket.to(roomId).emit("renegotiate"));

  // ── Draw permission ───────────────────────
  socket.on("set-draw-permission", ({ roomId, allowed }) => {
    try {
      const peer = peers.get(socket.id);
      const room = rooms.get(roomId);
      if (!room || !peer || peer.role !== "tutor") return;
      room.drawPermission = !!allowed;
      io.to(roomId).emit("draw-permission-changed", { allowed: room.drawPermission });
    } catch (e) { err("set-draw-permission", e); }
  });

  // ── Whiteboard draw ───────────────────────
  socket.on("draw", ({ roomId, data }) => {
    try {
      const peer = peers.get(socket.id);
      const room = rooms.get(roomId);
      if (!room || !peer) return;
      if (peer.role === "student" && !room.drawPermission) return;

      // Rate limiting: max DRAW_RATE_LIMIT events per second per socket
      const now = Date.now();
      let rl = drawRateMap.get(socket.id) || { count: 0, windowStart: now };
      if (now - rl.windowStart > 1000) { rl = { count: 0, windowStart: now }; }
      rl.count++;
      drawRateMap.set(socket.id, rl);
      if (rl.count > DRAW_RATE_LIMIT) return;

      // Validate command
      if (!validateCmd(data)) { dbg("Invalid draw cmd from", socket.id); return; }

      // Session-wide command cap
      if (countAllCmds(room) >= MAX_CMDS_PER_SESSION) return;

      const pageId = data.pageId || room.activePage;
      if (!room.pages[pageId]) return; // page must exist

      room.pages[pageId].push({ ...data, by: peer.name });
      socket.to(roomId).emit("draw", { ...data, senderName: peer.name });
    } catch (e) { err("draw", e); }
  });

  socket.on("clear-page", ({ roomId, pageId }) => {
    try {
      const peer = peers.get(socket.id);
      const room = rooms.get(roomId);
      if (!room || !peer) return;
      if (peer.role === "student" && !room.drawPermission) return;
      const pid = pageId || room.activePage;
      if (!room.pages[pid]) return;
      room.pages[pid] = [];
      io.to(roomId).emit("clear-page", { pageId: pid });
    } catch (e) { err("clear-page", e); }
  });

  socket.on("add-page", ({ roomId }) => {
    try {
      const peer = peers.get(socket.id);
      const room = rooms.get(roomId);
      if (!room || !peer || peer.role !== "tutor") return;
      if (room.pageOrder.length >= 20) return; // max 20 pages
      const newId = newPageId();
      room.pages[newId]   = [];
      room.activePage     = newId;
      room.pageOrder.push(newId);
      io.to(roomId).emit("page-state", { activePage: newId, pageOrder: room.pageOrder });
    } catch (e) { err("add-page", e); }
  });

  socket.on("switch-page", ({ roomId, pageId }) => {
    try {
      const peer = peers.get(socket.id);
      const room = rooms.get(roomId);
      if (!room || !peer || peer.role !== "tutor") return;
      if (!room.pages[pageId]) return;
      room.activePage = pageId;
      io.to(roomId).emit("page-state", { activePage: pageId, pageOrder: room.pageOrder });
    } catch (e) { err("switch-page", e); }
  });

  // ── Disconnect ────────────────────────────
  socket.on("disconnect", () => {
    try {
      const peer = peers.get(socket.id);
      if (!peer) return;
      const { userId, name, role, roomId } = peer;
      const room = rooms.get(roomId);
      if (room) {
        delete room.activePeers[socket.id];
        const p = room.participants[userId];
        if (p) { p.joined = false; p.leftAt = ts(); }
        if (Object.keys(room.activePeers).length === 0 && room.status === "active") {
          room.status = "waiting";
        }
        socket.to(roomId).emit("peer-left", { peerId: socket.id, userId, name });
      }
      peers.delete(socket.id);
      drawRateMap.delete(socket.id);
      log(`LEFT: ${name} (${role}) ← ${roomId}`);
    } catch (e) { err("disconnect", e); }
  });
});

// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  log(`\nTutorConnect SDK → http://localhost:${PORT}`);
  log(`  POST   /api/rooms                Create session`);
  log(`  GET    /api/rooms/:id/board       Board data (for replay)`);
  log(`  GET    /api/rooms/:id/summary     Summary`);
  log(`  DELETE /api/rooms/:id             End session`);
  log(`  GET    /ping                      Keepalive\n`);
});
