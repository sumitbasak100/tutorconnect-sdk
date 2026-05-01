const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST", "DELETE"] },
  pingTimeout: 20000,
  pingInterval: 10000,
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────
// Store (replace with Redis/DB for multi-server)
// ─────────────────────────────────────────────
const rooms = new Map();
const logs  = new Map();

function now() { return new Date().toISOString(); }

function addLog(roomId, entry) {
  if (!logs.has(roomId)) logs.set(roomId, []);
  logs.get(roomId).push({ ...entry, timestamp: now() });
}

// Throttle draw logs — max 1 per 5s per user to avoid flooding
const drawLogThrottle = new Map();
function addDrawLog(roomId, userId, name) {
  const key = `${roomId}:${userId}`;
  const last = drawLogThrottle.get(key) || 0;
  if (Date.now() - last > 5000) {
    addLog(roomId, { event: "drew", userId, name });
    drawLogThrottle.set(key, Date.now());
  }
}

// ─────────────────────────────────────────────
// Global error handlers — server never crashes
// ─────────────────────────────────────────────
process.on("uncaughtException",  (err)    => console.error("Uncaught exception:", err.message));
process.on("unhandledRejection", (reason) => console.error("Unhandled rejection:", reason));

// ─────────────────────────────────────────────
// REST API
// ─────────────────────────────────────────────

// POST /api/rooms — create session
app.post("/api/rooms", (req, res) => {
  try {
    const { tutor, student, metadata = {} } = req.body;

    if (!tutor?.userId || !tutor?.name)
      return res.status(400).json({ error: "tutor.userId and tutor.name are required" });
    if (!student?.userId || !student?.name)
      return res.status(400).json({ error: "student.userId and student.name are required" });
    if (tutor.userId === student.userId)
      return res.status(400).json({ error: "tutor and student cannot have the same userId" });

    const roomId = crypto.randomBytes(8).toString("hex");

    // Handle Railway / proxy host detection correctly
    const proto = req.headers["x-forwarded-proto"] || req.protocol;
    const host  = req.headers["x-forwarded-host"]  || req.get("host");
    const base  = `${proto}://${host}`;

    const room = {
      roomId,
      createdAt: now(),
      status: "waiting",       // waiting | active | ended
      metadata,
      drawPermission: false,   // tutor must grant student permission to draw
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
    };

    rooms.set(roomId, room);
    logs.set(roomId, []);
    addLog(roomId, { event: "room_created", metadata });

    const tutorJoinUrl   = `${base}/session/${roomId}?userId=${encodeURIComponent(tutor.userId)}&name=${encodeURIComponent(tutor.name)}&role=tutor`;
    const studentJoinUrl = `${base}/session/${roomId}?userId=${encodeURIComponent(student.userId)}&name=${encodeURIComponent(student.name)}&role=student`;

    res.json({
      success: true,
      roomId,
      tutorJoinUrl,
      studentJoinUrl,
      embedCode: `<iframe src="${tutorJoinUrl}" allow="camera;microphone" style="width:100%;height:620px;border:none;border-radius:12px;"></iframe>`,
    });
  } catch (err) {
    console.error("POST /api/rooms:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/rooms — list all rooms
app.get("/api/rooms", (req, res) => {
  res.json({ success: true, rooms: Array.from(rooms.values()) });
});

// GET /api/rooms/:roomId
app.get("/api/rooms/:roomId", (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });
  res.json({ success: true, room });
});

// GET /api/rooms/:roomId/logs
app.get("/api/rooms/:roomId/logs", (req, res) => {
  if (!rooms.has(req.params.roomId)) return res.status(404).json({ error: "Room not found" });
  res.json({ success: true, roomId: req.params.roomId, logs: logs.get(req.params.roomId) || [] });
});

// GET /api/rooms/:roomId/summary
app.get("/api/rooms/:roomId/summary", (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });

  const roomLogs = logs.get(req.params.roomId) || [];
  const summary = Object.values(room.participants).map(p => ({
    name:      p.name,
    role:      p.role,
    userId:    p.userId,
    joinedAt:  p.joinedAt || "Did not join",
    leftAt:    p.leftAt   || (p.joinedAt ? "Still in session" : "—"),
    drawCount: roomLogs.filter(l => l.event === "drew" && l.userId === p.userId).length,
  }));

  res.json({
    success: true,
    roomId: room.roomId,
    createdAt: room.createdAt,
    status: room.status,
    metadata: room.metadata,
    totalDrawEvents: roomLogs.filter(l => l.event === "drew").length,
    participants: summary,
  });
});

// DELETE /api/rooms/:roomId — end session
app.delete("/api/rooms/:roomId", (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (room) {
    room.status = "ended";
    addLog(req.params.roomId, { event: "room_ended", by: "api" });
  }
  io.to(req.params.roomId).emit("session-ended", { reason: "Session ended by host" });
  res.json({ success: true });
});

// Session page
app.get("/session/:roomId", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "session.html"));
});

// SDK script
app.get("/sdk.js", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "sdk.js"));
});

// 404
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// ─────────────────────────────────────────────
// Socket.io — Signaling + Whiteboard + Tracking
// ─────────────────────────────────────────────
io.on("connection", (socket) => {
  let currentRoom = null;
  let currentUser = null;

  // ── Join room ─────────────────────────────
  socket.on("join-room", ({ roomId, userId, name, role }) => {
    try {
      const room = rooms.get(roomId);
      if (!room)
        return socket.emit("join-error", { message: "Session not found. It may have expired." });
      if (room.status === "ended")
        return socket.emit("join-error", { message: "This session has already ended." });
      if (!room.participants[userId])
        return socket.emit("join-error", { message: "You are not authorised to join this session." });

      currentRoom = roomId;
      currentUser = { userId, name, role };

      socket.join(roomId);

      // Update participant record — reset leftAt on rejoin
      const p = room.participants[userId];
      p.joinedAt = p.joinedAt || now();
      p.leftAt   = null;
      p.socketId = socket.id;
      room.connected[socket.id] = userId;

      if (Object.keys(room.connected).length >= 2) room.status = "active";

      addLog(roomId, { event: "joined", userId, name, role });

      // Tell others this person joined (with role so UI knows tutor vs student)
      socket.to(roomId).emit("peer-joined", { userId, name, role });

      // Send full room state to the joining user
      socket.emit("room-state", {
        roomId,
        participants: room.participants,
        connectedUsers: Object.values(room.connected).map(uid => room.participants[uid]),
        drawPermission: room.drawPermission,
        role,
      });

    } catch (err) {
      console.error("join-room error:", err);
      socket.emit("join-error", { message: "Failed to join. Please refresh and try again." });
    }
  });

  // ── WebRTC signaling ──────────────────────
  socket.on("offer", ({ roomId, offer }) => {
    socket.to(roomId).emit("offer", { offer, from: socket.id });
  });

  socket.on("answer", ({ roomId, answer }) => {
    socket.to(roomId).emit("answer", { answer, from: socket.id });
  });

  socket.on("ice-candidate", ({ roomId, candidate }) => {
    socket.to(roomId).emit("ice-candidate", { candidate });
  });

  // ── Draw permission (tutor only) ──────────
  socket.on("set-draw-permission", ({ roomId, allowed }) => {
    try {
      const room = rooms.get(roomId);
      if (!room || !currentUser) return;
      if (currentUser.role !== "tutor") return;

      room.drawPermission = !!allowed;

      addLog(roomId, {
        event: allowed ? "draw_permission_granted" : "draw_permission_revoked",
        by: currentUser.userId,
        byName: currentUser.name,
      });

      // Broadcast to everyone in room (tutor sees confirmation, student gets notified)
      io.to(roomId).emit("draw-permission-changed", {
        allowed: room.drawPermission,
        byName: currentUser.name,
      });
    } catch (err) {
      console.error("set-draw-permission error:", err);
    }
  });

  // ── Whiteboard draw ───────────────────────
  socket.on("draw", ({ roomId, data }) => {
    try {
      const room = rooms.get(roomId);
      if (!room || !currentUser) return;
      if (currentUser.role === "student" && !room.drawPermission) return;

      // Attach sender name so remote UI shows "X is drawing…"
      socket.to(roomId).emit("draw", { ...data, senderName: currentUser.name });
      addDrawLog(roomId, currentUser.userId, currentUser.name);
    } catch (err) {
      console.error("draw error:", err);
    }
  });

  socket.on("clear-board", ({ roomId }) => {
    try {
      const room = rooms.get(roomId);
      if (!room || !currentUser) return;
      if (currentUser.role === "student" && !room.drawPermission) return;

      socket.to(roomId).emit("clear-board");
      addLog(roomId, { event: "cleared_board", userId: currentUser.userId, name: currentUser.name });
    } catch (err) {
      console.error("clear-board error:", err);
    }
  });

  // ── Disconnect ────────────────────────────
  socket.on("disconnect", (reason) => {
    if (!currentRoom || !currentUser) return;

    const room = rooms.get(currentRoom);
    if (room) {
      const p = room.participants[currentUser.userId];
      if (p) p.leftAt = now();
      delete room.connected[socket.id];

      // Don't mark as ended — they might reconnect
      if (Object.keys(room.connected).length === 0 && room.status === "active") {
        room.status = "waiting";
      }
    }

    addLog(currentRoom, { event: "left", userId: currentUser.userId, name: currentUser.name, reason });
    socket.to(currentRoom).emit("peer-left", { userId: currentUser.userId, name: currentUser.name });
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🚀 TutorConnect SDK  →  http://localhost:${PORT}`);
  console.log(`\nEndpoints:`);
  console.log(`  POST   /api/rooms                  Create session`);
  console.log(`  GET    /api/rooms/:id               Room info`);
  console.log(`  GET    /api/rooms/:id/logs          Full activity log`);
  console.log(`  GET    /api/rooms/:id/summary       Human-readable summary`);
  console.log(`  DELETE /api/rooms/:id               End session\n`);
});
