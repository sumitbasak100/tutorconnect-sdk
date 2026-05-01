"use strict";

const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");
const cors    = require("cors");
const crypto  = require("crypto");
const path    = require("path");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST", "DELETE"] },
  pingTimeout:       30000,
  pingInterval:      10000,
  maxHttpBufferSize: 5e6,   // 5MB — critical: WebRTC SDP can be large
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────
const rooms = new Map(); // roomId → room
const peers = new Map(); // socketId → { userId, name, role, roomId }

function ts() { return new Date().toISOString(); }

// Auto-cleanup idle rooms older than 4h
setInterval(() => {
  const cutoff = Date.now() - 4 * 60 * 60 * 1000;
  for (const [id, room] of rooms) {
    if (new Date(room.createdAt).getTime() < cutoff && Object.keys(room.activePeers).length === 0) {
      rooms.delete(id);
    }
  }
}, 30 * 60 * 1000);

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

    rooms.set(roomId, {
      roomId,
      createdAt:      ts(),
      status:         "waiting",
      metadata,
      drawPermission: false,
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
      activePeers: {},   // socketId → userId
      // Whiteboard: stored as draw commands per page, replayed on join
      // coords are normalized 0–1 so they work on any screen size
      pages:       { "1": [] },
      activePage:  "1",
    });

    // URL format: /session/:roomId/:userId
    const tutorJoinUrl   = `${base}/session/${roomId}/${encodeURIComponent(tutor.userId)}`;
    const studentJoinUrl = `${base}/session/${roomId}/${encodeURIComponent(student.userId)}`;

    res.status(201).json({
      success: true,
      roomId,
      tutorJoinUrl,
      studentJoinUrl,
      embedCode: `<iframe src="${tutorJoinUrl}" allow="camera;microphone" style="width:100%;height:620px;border:none;border-radius:12px;"></iframe>`,
    });
  } catch (err) {
    console.error("[POST /api/rooms]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/rooms", (_req, res) => {
  res.json({ success: true, count: rooms.size });
});

app.get("/api/rooms/:roomId", (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });
  res.json({ success: true, room });
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
  res.json({ success: true });
});

// Session page — /session/:roomId/:userId
app.get("/session/:roomId/:userId", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "session.html"));
});

app.get("/sdk.js", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "sdk.js"));
});

app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// ─────────────────────────────────────────────
// Socket.io
// ─────────────────────────────────────────────
io.on("connection", (socket) => {

  // ── Join ──────────────────────────────────
  socket.on("join-room", ({ roomId, userId }) => {
    try {
      const room = rooms.get(roomId);
      if (!room)                  return socket.emit("join-error", { message: "Session not found." });
      if (room.status === "ended") return socket.emit("join-error", { message: "This session has ended." });

      const participant = room.participants[userId];
      if (!participant)           return socket.emit("join-error", { message: "Not authorised to join this session." });

      const { name, role } = participant;

      // Register
      peers.set(socket.id, { userId, name, role, roomId });
      room.activePeers[socket.id] = userId;

      participant.joined   = true;
      participant.joinedAt = participant.joinedAt || ts();
      participant.leftAt   = null;
      participant.socketId = socket.id;

      socket.join(roomId);

      if (Object.keys(room.activePeers).length >= 2) room.status = "active";

      // Tell others this person joined
      socket.to(roomId).emit("peer-joined", { peerId: socket.id, userId, name, role });

      // Send full state to the joining user (includes board history for replay)
      socket.emit("identity-confirmed", {
        userId,
        name,
        role,
        participants:   room.participants,
        drawPermission: room.drawPermission,
        pages:          room.pages,
        activePage:     room.activePage,
        // Tell them who is already connected
        connectedPeers: Object.values(room.activePeers)
          .map(uid => room.participants[uid])
          .filter(p => p && p.userId !== userId),
      });

      console.log(`[JOIN] ${name} (${role}) → room ${roomId}`);
    } catch (err) {
      console.error("[join-room]", err);
      socket.emit("join-error", { message: "Failed to join. Please refresh." });
    }
  });

  // ── WebRTC signaling ──────────────────────
  socket.on("offer",         ({ roomId, offer })     => socket.to(roomId).emit("offer",         { offer,     from: socket.id }));
  socket.on("answer",        ({ roomId, answer })    => socket.to(roomId).emit("answer",        { answer,    from: socket.id }));
  socket.on("ice-candidate", ({ roomId, candidate }) => socket.to(roomId).emit("ice-candidate", { candidate }));

  // ── Draw permission ───────────────────────
  socket.on("set-draw-permission", ({ roomId, allowed }) => {
    try {
      const peer = peers.get(socket.id);
      const room = rooms.get(roomId);
      if (!room || !peer || peer.role !== "tutor") return;
      room.drawPermission = !!allowed;
      io.to(roomId).emit("draw-permission-changed", { allowed: room.drawPermission });
    } catch (err) { console.error("[set-draw-permission]", err); }
  });

  // ── Whiteboard draw ───────────────────────
  // data uses normalized coords (0–1) — consistent across screen sizes
  socket.on("draw", ({ roomId, data }) => {
    try {
      const peer = peers.get(socket.id);
      const room = rooms.get(roomId);
      if (!room || !peer) return;
      if (peer.role === "student" && !room.drawPermission) return;

      const pageId = data.pageId || room.activePage;
      if (!room.pages[pageId]) room.pages[pageId] = [];
      // Cap at 8000 commands per page
      if (room.pages[pageId].length < 8000) {
        room.pages[pageId].push({ ...data, by: peer.name });
      }

      socket.to(roomId).emit("draw", { ...data, senderName: peer.name });
    } catch (err) { console.error("[draw]", err); }
  });

  socket.on("clear-page", ({ roomId, pageId }) => {
    try {
      const peer = peers.get(socket.id);
      const room = rooms.get(roomId);
      if (!room || !peer) return;
      if (peer.role === "student" && !room.drawPermission) return;
      const pid = pageId || room.activePage;
      room.pages[pid] = [];
      io.to(roomId).emit("clear-page", { pageId: pid });
    } catch (err) { console.error("[clear-page]", err); }
  });

  socket.on("add-page", ({ roomId }) => {
    try {
      const peer = peers.get(socket.id);
      const room = rooms.get(roomId);
      if (!room || !peer || peer.role !== "tutor") return;
      const newId = String(Object.keys(room.pages).length + 1);
      room.pages[newId] = [];
      room.activePage   = newId;
      io.to(roomId).emit("page-changed", { pages: Object.keys(room.pages), activePage: newId });
    } catch (err) { console.error("[add-page]", err); }
  });

  socket.on("switch-page", ({ roomId, pageId }) => {
    try {
      const peer = peers.get(socket.id);
      const room = rooms.get(roomId);
      if (!room || !peer || peer.role !== "tutor") return;
      if (!room.pages[pageId]) return;
      room.activePage = pageId;
      io.to(roomId).emit("page-changed", { pages: Object.keys(room.pages), activePage: pageId });
    } catch (err) { console.error("[switch-page]", err); }
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
      console.log(`[LEFT] ${name} (${role}) ← room ${roomId}`);
    } catch (err) { console.error("[disconnect]", err); }
  });
});

// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🚀 TutorConnect SDK  →  http://localhost:${PORT}`);
  console.log(`  POST   /api/rooms              Create session`);
  console.log(`  GET    /api/rooms/:id/summary   Summary`);
  console.log(`  DELETE /api/rooms/:id           End session`);
  console.log(`  Session URL: /session/:roomId/:userId\n`);
});
