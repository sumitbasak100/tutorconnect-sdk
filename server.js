/**
 * TutorConnect SDK — Server
 *
 * URL format:  /session/:roomId/:userId
 * No event logs. Scalable to 10k+ concurrent sessions on a single node.
 *
 * Scalability notes:
 * ─────────────────
 * Video is 100% peer-to-peer (WebRTC). Your server carries ZERO video data.
 * The server only handles:
 *   - Signaling  (~500 bytes per session setup)
 *   - Whiteboard strokes (~50 bytes per stroke, only during active drawing)
 *   - Room state in memory (~1KB per room)
 *
 * 10,000 sessions ≈ 20,000 socket connections ≈ ~100MB RAM. Totally fine.
 *
 * To scale BEYOND a single server (horizontal scaling):
 *   1. Replace the `rooms` Map with Redis  (npm install ioredis)
 *   2. Add Socket.io Redis adapter         (npm install @socket.io/redis-adapter)
 *   3. Deploy multiple Railway instances behind a load balancer
 */

"use strict";

const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");
const cors   = require("cors");
const crypto = require("crypto");
const path   = require("path");

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST", "DELETE"] },
  // Tune for high concurrency
  pingTimeout:          20000,
  pingInterval:         10000,
  maxHttpBufferSize:    1e5,   // 100KB max per message — prevents memory abuse
  transports:           ["websocket", "polling"],
});

app.use(cors());
app.use(express.json({ limit: "50kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────
// In-memory store
// Swap `rooms` Map for Redis to scale horizontally.
// ─────────────────────────────────────────────
const rooms = new Map(); // roomId → room

function ts() { return new Date().toISOString(); }

// Auto-cleanup ended/idle rooms after 2 hours to free memory
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, room] of rooms) {
    if (new Date(room.createdAt).getTime() < cutoff && Object.keys(room.connected).length === 0) {
      rooms.delete(id);
    }
  }
}, 30 * 60 * 1000); // run every 30 mins

// ─────────────────────────────────────────────
// Global safety net — server never crashes
// ─────────────────────────────────────────────
process.on("uncaughtException",  (err)    => console.error("[uncaughtException]",  err.message));
process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function getBase(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host  = req.headers["x-forwarded-host"]  || req.get("host");
  return `${proto}://${host}`;
}

// ─────────────────────────────────────────────
// REST API
// ─────────────────────────────────────────────

/**
 * POST /api/rooms
 * Create a session room.
 *
 * Body:
 * {
 *   "tutor":    { "userId": "t1", "name": "Mr. Smith" },
 *   "student":  { "userId": "s1", "name": "Alice" },
 *   "metadata": { "subject": "Math" }   ← optional
 * }
 *
 * Response:
 * {
 *   "roomId":        "a1b2c3d4e5f6",
 *   "tutorJoinUrl":   "https://domain/session/a1b2.../t1",
 *   "studentJoinUrl": "https://domain/session/a1b2.../s1"
 * }
 */
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
      status:         "waiting",  // waiting | active | ended
      metadata,
      drawPermission: false,      // student draw permission — tutor controls this
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
      connected: {}, // socketId → userId
    });

    // Clean URL format: /session/:roomId/:userId
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

// GET /api/rooms — list rooms (admin use)
app.get("/api/rooms", (_req, res) => {
  res.json({ success: true, count: rooms.size, rooms: Array.from(rooms.values()) });
});

// GET /api/rooms/:roomId
app.get("/api/rooms/:roomId", (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });
  res.json({ success: true, room });
});

// GET /api/rooms/:roomId/summary
app.get("/api/rooms/:roomId/summary", (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });

  res.json({
    success:      true,
    roomId:       room.roomId,
    createdAt:    room.createdAt,
    status:       room.status,
    metadata:     room.metadata,
    participants: Object.values(room.participants).map(p => ({
      name:     p.name,
      role:     p.role,
      userId:   p.userId,
      joinedAt: p.joinedAt || "Did not join",
      leftAt:   p.leftAt   || (p.joinedAt ? "Still in session" : "—"),
    })),
  });
});

// DELETE /api/rooms/:roomId — end session
app.delete("/api/rooms/:roomId", (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (room) room.status = "ended";
  io.to(req.params.roomId).emit("session-ended", { reason: "Session ended by host" });
  res.json({ success: true });
});

// Serve session page — NEW clean URL: /session/:roomId/:userId
app.get("/session/:roomId/:userId", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "session.html"));
});

// SDK script
app.get("/sdk.js", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "sdk.js"));
});

// 404
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// ─────────────────────────────────────────────
// Socket.io — Signaling + Whiteboard
// ─────────────────────────────────────────────
io.on("connection", (socket) => {
  let currentRoom = null;
  let currentUser = null;

  // ── Join ─────────────────────────────────
  socket.on("join-room", ({ roomId, userId }) => {
    try {
      const room = rooms.get(roomId);
      if (!room)
        return socket.emit("join-error", { message: "Session not found. It may have expired." });
      if (room.status === "ended")
        return socket.emit("join-error", { message: "This session has already ended." });

      const participant = room.participants[userId];
      if (!participant)
        return socket.emit("join-error", { message: "You are not authorised to join this session." });

      currentRoom = roomId;
      currentUser = { userId, name: participant.name, role: participant.role };

      socket.join(roomId);

      // Update record — reset leftAt on rejoin
      participant.joinedAt = participant.joinedAt || ts();
      participant.leftAt   = null;
      participant.socketId = socket.id;
      room.connected[socket.id] = userId;

      if (Object.keys(room.connected).length >= 2) room.status = "active";

      // Notify others
      socket.to(roomId).emit("peer-joined", {
        userId,
        name: participant.name,
        role: participant.role,
      });

      // Send full room state to this user
      socket.emit("room-state", {
        participants:   room.participants,
        connectedUsers: Object.values(room.connected).map(uid => room.participants[uid]),
        drawPermission: room.drawPermission,
        role:           participant.role,
        name:           participant.name,
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

  // ── Draw permission (tutor only) ──────────
  socket.on("set-draw-permission", ({ roomId, allowed }) => {
    try {
      const room = rooms.get(roomId);
      if (!room || !currentUser || currentUser.role !== "tutor") return;
      room.drawPermission = !!allowed;
      io.to(roomId).emit("draw-permission-changed", { allowed: room.drawPermission });
    } catch (err) {
      console.error("[set-draw-permission]", err);
    }
  });

  // ── Whiteboard ────────────────────────────
  socket.on("draw", ({ roomId, data }) => {
    try {
      const room = rooms.get(roomId);
      if (!room || !currentUser) return;
      if (currentUser.role === "student" && !room.drawPermission) return;
      socket.to(roomId).emit("draw", { ...data, senderName: currentUser.name });
    } catch (err) {
      console.error("[draw]", err);
    }
  });

  socket.on("clear-board", ({ roomId }) => {
    try {
      const room = rooms.get(roomId);
      if (!room || !currentUser) return;
      if (currentUser.role === "student" && !room.drawPermission) return;
      socket.to(roomId).emit("clear-board");
    } catch (err) {
      console.error("[clear-board]", err);
    }
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
    } catch (err) {
      console.error("[disconnect]", err);
    }
  });
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🚀 TutorConnect SDK  →  http://localhost:${PORT}`);
  console.log(`\n  POST   /api/rooms                 Create session`);
  console.log(`  GET    /api/rooms/:id              Room info`);
  console.log(`  GET    /api/rooms/:id/summary      Session summary`);
  console.log(`  DELETE /api/rooms/:id              End session`);
  console.log(`\n  Session URL: /session/:roomId/:userId\n`);
});
