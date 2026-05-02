"use strict";

/**
 * TutorConnect SDK — Production Server v4
 *
 * Fixes in this version:
 * - maxHttpBufferSize raised to 5MB (was 100KB — was silently dropping WebRTC SDP/ICE)
 * - Board state stored server-side per page, replayed on join/refresh
 * - Multiple whiteboard pages per session
 * - Draw events use normalized 0-1 coordinates (position consistent across screen sizes)
 * - ICE restart support
 * - Clean URL: /session/:roomId/:userId
 *
 * Scalability: Video is peer-to-peer. Server handles signaling + whiteboard only.
 * 10k sessions ≈ 20k sockets ≈ ~150MB RAM (board state adds ~10KB per session).
 * Horizontal scaling: swap rooms Map for Redis + @socket.io/redis-adapter.
 */

const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");
const cors   = require("cors");
const crypto = require("crypto");
const path   = require("path");

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors:             { origin: "*", methods: ["GET", "POST", "DELETE"] },
  pingTimeout:      30000,
  pingInterval:     10000,
  maxHttpBufferSize: 5e6,          // 5MB — WebRTC SDP can be large
  transports:       ["websocket", "polling"],
});

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────
const rooms = new Map();

function ts() { return new Date().toISOString(); }

// Auto-cleanup idle rooms older than 4 hours
setInterval(() => {
  const cutoff = Date.now() - 4 * 60 * 60 * 1000;
  for (const [id, room] of rooms) {
    if (new Date(room.createdAt).getTime() < cutoff && Object.keys(room.connected).length === 0) {
      rooms.delete(id);
    }
  }
}, 30 * 60 * 1000);

function makeRoom(roomId, tutor, student, metadata) {
  return {
    roomId,
    createdAt:      ts(),
    status:         "waiting",
    metadata,
    drawPermission: false,
    participants: {
      [tutor.userId]: {
        userId: tutor.userId, name: tutor.name, role: "tutor",
        joinedAt: null, leftAt: null, socketId: null,
      },
      [student.userId]: {
        userId: student.userId, name: student.name, role: "student",
        joinedAt: null, leftAt: null, socketId: null,
      },
    },
    connected: {},       // socketId → userId
    // Whiteboard state — stored per page so latecomers/refreshers get full history
    // pages: { [pageId]: [ ...drawCommands ] }
    // drawCommand: { type, ...payload }  (see socket "draw-cmd" handler)
    pages: { "1": [] },
    activePage: "1",
  };
}

// ─────────────────────────────────────────────
// Global safety net
// ─────────────────────────────────────────────
process.on("uncaughtException",  err    => console.error("[uncaughtException]",  err.message));
process.on("unhandledRejection", reason => console.error("[unhandledRejection]", reason));

// ─────────────────────────────────────────────
// REST API
// ─────────────────────────────────────────────
function getBase(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host  = req.headers["x-forwarded-host"]  || req.get("host");
  return `${proto}://${host}`;
}

// POST /api/rooms
app.post("/api/rooms", (req, res) => {
  try {
    const { tutor, student, metadata = {} } = req.body || {};
    if (!tutor?.userId || !tutor?.name)
      return res.status(400).json({ error: "tutor.userId and tutor.name are required" });
    if (!student?.userId || !student?.name)
      return res.status(400).json({ error: "student.userId and student.name are required" });
    if (tutor.userId === student.userId)
      return res.status(400).json({ error: "tutor and student cannot share the same userId" });

    const roomId = crypto.randomBytes(8).toString("hex");
    const base   = getBase(req);
    rooms.set(roomId, makeRoom(roomId, tutor, student, metadata));

    const tutorJoinUrl   = `${base}/session/${roomId}/${encodeURIComponent(tutor.userId)}`;
    const studentJoinUrl = `${base}/session/${roomId}/${encodeURIComponent(student.userId)}`;

    res.status(201).json({
      success: true, roomId, tutorJoinUrl, studentJoinUrl,
      embedCode: `<iframe src="${tutorJoinUrl}" allow="camera;microphone" style="width:100%;height:620px;border:none;border-radius:12px;"></iframe>`,
    });
  } catch (err) {
    console.error("[POST /api/rooms]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/rooms",          (_req, res) => res.json({ success: true, count: rooms.size, rooms: Array.from(rooms.values()).map(r => ({ roomId: r.roomId, status: r.status, createdAt: r.createdAt, metadata: r.metadata })) }));
app.get("/api/rooms/:id",      (req, res)  => { const r = rooms.get(req.params.id); r ? res.json({ success: true, room: r }) : res.status(404).json({ error: "Room not found" }); });
app.get("/api/rooms/:id/summary", (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: "Room not found" });
  res.json({
    success: true, roomId: room.roomId, status: room.status,
    createdAt: room.createdAt, metadata: room.metadata,
    participants: Object.values(room.participants).map(p => ({
      name: p.name, role: p.role, userId: p.userId,
      joinedAt: p.joinedAt || "Did not join",
      leftAt:   p.leftAt   || (p.joinedAt ? "Still in session" : "—"),
    })),
  });
});
app.delete("/api/rooms/:id", (req, res) => {
  const room = rooms.get(req.params.id);
  if (room) room.status = "ended";
  io.to(req.params.id).emit("session-ended", { reason: "Session ended by host" });
  res.json({ success: true });
});

app.get("/session/:roomId/:userId", (_req, res) => res.sendFile(path.join(__dirname, "public", "session.html")));
app.get("/sdk.js",                  (_req, res) => res.sendFile(path.join(__dirname, "public", "sdk.js")));
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// ─────────────────────────────────────────────
// Socket.io
// ─────────────────────────────────────────────
io.on("connection", socket => {
  let currentRoom = null;
  let currentUser = null;

  // ── Join ──────────────────────────────────
  socket.on("join-room", ({ roomId, userId }) => {
    try {
      const room = rooms.get(roomId);
      if (!room)            return socket.emit("join-error", { message: "Session not found. It may have expired." });
      if (room.status === "ended") return socket.emit("join-error", { message: "This session has already ended." });
      const participant = room.participants[userId];
      if (!participant)     return socket.emit("join-error", { message: "You are not authorised to join this session." });

      currentRoom = roomId;
      currentUser = { userId, name: participant.name, role: participant.role };

      socket.join(roomId);

      participant.joinedAt = participant.joinedAt || ts();
      participant.leftAt   = null;
      participant.socketId = socket.id;
      room.connected[socket.id] = userId;

      if (Object.keys(room.connected).length >= 2) room.status = "active";

      // Tell others
      socket.to(roomId).emit("peer-joined", { userId, name: participant.name, role: participant.role });

      // Send full room state including ALL board pages (for replay on join/refresh)
      socket.emit("room-state", {
        participants:   room.participants,
        connectedUsers: Object.values(room.connected).map(uid => room.participants[uid]),
        drawPermission: room.drawPermission,
        role:           participant.role,
        name:           participant.name,
        pages:          room.pages,        // full board history
        activePage:     room.activePage,
      });

    } catch (err) {
      console.error("[join-room]", err);
      socket.emit("join-error", { message: "Failed to join. Please refresh and try again." });
    }
  });

  // ── WebRTC signaling ──────────────────────
  socket.on("offer",         ({ roomId, offer })     => socket.to(roomId).emit("offer",         { offer,     from: socket.id }));
  socket.on("answer",        ({ roomId, answer })    => socket.to(roomId).emit("answer",        { answer,    from: socket.id }));
  socket.on("ice-candidate", ({ roomId, candidate }) => socket.to(roomId).emit("ice-candidate", { candidate }));
  socket.on("ice-restart",   ({ roomId })            => socket.to(roomId).emit("ice-restart"));

  // ── Draw permission ───────────────────────
  socket.on("set-draw-permission", ({ roomId, allowed }) => {
    try {
      const room = rooms.get(roomId);
      if (!room || !currentUser || currentUser.role !== "tutor") return;
      room.drawPermission = !!allowed;
      io.to(roomId).emit("draw-permission-changed", { allowed: room.drawPermission });
    } catch (err) { console.error("[set-draw-permission]", err); }
  });

  // ── Whiteboard draw command ───────────────
  // cmd = { type: "stroke"|"shape"|"text"|"erase", pageId, ...normalized coords (0-1) }
  socket.on("draw-cmd", ({ roomId, cmd }) => {
    try {
      const room = rooms.get(roomId);
      if (!room || !currentUser) return;
      if (currentUser.role === "student" && !room.drawPermission) return;

      // Store in server-side board history for replay
      const page = cmd.pageId || room.activePage;
      if (!room.pages[page]) room.pages[page] = [];
      // Cap page history at 5000 commands to prevent memory bloat
      if (room.pages[page].length < 5000) {
        room.pages[page].push({ ...cmd, by: currentUser.name });
      }

      // Relay to others
      socket.to(roomId).emit("draw-cmd", { ...cmd, senderName: currentUser.name });
    } catch (err) { console.error("[draw-cmd]", err); }
  });

  socket.on("clear-page", ({ roomId, pageId }) => {
    try {
      const room = rooms.get(roomId);
      if (!room || !currentUser) return;
      if (currentUser.role === "student" && !room.drawPermission) return;
      const pid = pageId || room.activePage;
      room.pages[pid] = [];
      io.to(roomId).emit("clear-page", { pageId: pid });
    } catch (err) { console.error("[clear-page]", err); }
  });

  socket.on("add-page", ({ roomId }) => {
    try {
      const room = rooms.get(roomId);
      if (!room || !currentUser || currentUser.role !== "tutor") return;
      const newId = String(Object.keys(room.pages).length + 1);
      room.pages[newId] = [];
      room.activePage   = newId;
      io.to(roomId).emit("page-added", { pageId: newId, activePage: newId });
    } catch (err) { console.error("[add-page]", err); }
  });

  socket.on("switch-page", ({ roomId, pageId }) => {
    try {
      const room = rooms.get(roomId);
      if (!room || !currentUser || currentUser.role !== "tutor") return;
      if (!room.pages[pageId]) return;
      room.activePage = pageId;
      io.to(roomId).emit("switch-page", { pageId });
    } catch (err) { console.error("[switch-page]", err); }
  });

  // ── Disconnect ────────────────────────────
  socket.on("disconnect", () => {
    if (!currentRoom || !currentUser) return;
    try {
      const room = rooms.get(currentRoom);
      if (room) {
        const p = room.participants[currentUser.userId];
        if (p) p.leftAt = ts();
        delete room.connected[socket.id];
        if (Object.keys(room.connected).length === 0 && room.status === "active") {
          room.status = "waiting";
        }
      }
      socket.to(currentRoom).emit("peer-left", { name: currentUser.name });
    } catch (err) { console.error("[disconnect]", err); }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🚀 TutorConnect SDK  →  http://localhost:${PORT}`);
  console.log(`  POST   /api/rooms                 Create session`);
  console.log(`  GET    /api/rooms/:id/summary      Session summary`);
  console.log(`  DELETE /api/rooms/:id              End session`);
  console.log(`  Session URL: /session/:roomId/:userId\n`);
});
