const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");
const cors    = require("cors");
const crypto  = require("crypto");
const path    = require("path");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: "*", methods: ["GET","POST"] } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────────────────────
// In-memory store  (swap with Redis/Postgres for production)
// ─────────────────────────────────────────────────────────────

const rooms = new Map();   // roomId → room object
const peers = new Map();   // socketId → { userId, name, roomId }

function createLog(roomId, userId, name, action, extra = {}) {
  const entry = {
    id:        crypto.randomBytes(4).toString("hex"),
    roomId,
    userId,
    name,
    action,   // "joined" | "left" | "drew" | "cleared_board"
    timestamp: new Date().toISOString(),
    ...extra,
  };
  const room = rooms.get(roomId);
  if (room) room.logs.push(entry);
  return entry;
}

// ─────────────────────────────────────────────────────────────
// REST API
// ─────────────────────────────────────────────────────────────

// Create a room — must include tutorId + tutorName, studentId + studentName
app.post("/api/rooms", (req, res) => {
  const {
    tutorId, tutorName,
    studentId, studentName,
    metadata = {}
  } = req.body;

  if (!tutorId || !tutorName || !studentId || !studentName) {
    return res.status(400).json({
      error: "tutorId, tutorName, studentId and studentName are all required."
    });
  }

  const roomId = crypto.randomBytes(8).toString("hex");

  rooms.set(roomId, {
    roomId,
    createdAt: new Date().toISOString(),
    metadata,
    // Pre-register the two allowed participants
    participants: {
      [tutorId]:   { userId: tutorId,   name: tutorName,   role: "tutor",   joined: false },
      [studentId]: { userId: studentId, name: studentName, role: "student", joined: false },
    },
    logs: [],
    activePeers: {},  // socketId → userId
  });

  const base = `${req.protocol}://${req.get("host")}`;

  res.json({
    success: true,
    roomId,
    // Ready-made join URLs to send to each person
    tutorJoinUrl:   `${base}/session/${roomId}?userId=${tutorId}&name=${encodeURIComponent(tutorName)}`,
    studentJoinUrl: `${base}/session/${roomId}?userId=${studentId}&name=${encodeURIComponent(studentName)}`,
    // iFrame embed (pass userId+name as query params)
    embedCode: `<iframe src="${base}/session/${roomId}?userId=USER_ID&name=USER_NAME" allow="camera;microphone" style="width:100%;height:600px;border:none;border-radius:12px;"></iframe>`,
  });
});

// Get room info + full activity log
app.get("/api/rooms/:roomId", (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });
  res.json({ success: true, room });
});

// Get only the activity logs for a room
app.get("/api/rooms/:roomId/logs", (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });

  const { userId, action } = req.query;
  let logs = room.logs;
  if (userId) logs = logs.filter(l => l.userId === userId);
  if (action) logs = logs.filter(l => l.action === action);

  res.json({ success: true, roomId: req.params.roomId, total: logs.length, logs });
});

// End a room
app.delete("/api/rooms/:roomId", (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (room) {
    // Log "left" for anyone still active
    Object.entries(room.activePeers).forEach(([, userId]) => {
      const p = room.participants[userId];
      if (p) createLog(req.params.roomId, userId, p.name, "left", { reason: "session_ended" });
    });
  }
  rooms.delete(req.params.roomId);
  io.to(req.params.roomId).emit("session-ended");
  res.json({ success: true });
});

// Serve session page
app.get("/session/:roomId", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "session.html"));
});

// Serve SDK
app.get("/sdk.js", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "sdk.js"));
});

// ─────────────────────────────────────────────────────────────
// Socket.io — Signaling + Whiteboard + Tracking
// ─────────────────────────────────────────────────────────────

io.on("connection", (socket) => {

  // ── Join room ──────────────────────────────
  socket.on("join-room", ({ roomId, userId, name }) => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit("error", { message: "Room not found" });

    // Register this socket
    peers.set(socket.id, { userId, name, roomId });
    room.activePeers[socket.id] = userId;

    // Mark participant as joined
    if (room.participants[userId]) {
      room.participants[userId].joined     = true;
      room.participants[userId].joinedAt   = new Date().toISOString();
      room.participants[userId].socketId   = socket.id;
    }

    socket.join(roomId);

    // Log it
    const log = createLog(roomId, userId, name, "joined");

    // Tell the new joiner their identity was recognised
    socket.emit("identity-confirmed", {
      userId,
      name,
      role: room.participants[userId]?.role || "unknown",
      participants: room.participants,
    });

    // Tell everyone else
    socket.to(roomId).emit("peer-joined", { peerId: socket.id, userId, name });

    console.log(`[JOIN]  ${name} (${userId}) → room ${roomId}`);
  });

  // ── WebRTC Signaling ───────────────────────
  socket.on("offer",         ({ roomId, offer })     => socket.to(roomId).emit("offer",         { offer,     from: socket.id }));
  socket.on("answer",        ({ roomId, answer })    => socket.to(roomId).emit("answer",        { answer,    from: socket.id }));
  socket.on("ice-candidate", ({ roomId, candidate }) => socket.to(roomId).emit("ice-candidate", { candidate, from: socket.id }));

  // ── Whiteboard ─────────────────────────────
  socket.on("draw", ({ roomId, data }) => {
    const peer = peers.get(socket.id);
    if (!peer) return;

    // Relay stroke to others
    socket.to(roomId).emit("draw", data);

    // Log a "drew" event (throttled — one log per stroke, not per pixel)
    createLog(roomId, peer.userId, peer.name, "drew", {
      strokeColor: data.color,
      strokeSize:  data.size,
    });
  });

  socket.on("clear-board", ({ roomId }) => {
    const peer = peers.get(socket.id);
    if (peer) createLog(roomId, peer.userId, peer.name, "cleared_board");
    socket.to(roomId).emit("clear-board");
  });

  // ── Disconnect ─────────────────────────────
  socket.on("disconnect", () => {
    const peer = peers.get(socket.id);
    if (!peer) return;

    const { userId, name, roomId } = peer;
    const room = rooms.get(roomId);

    if (room) {
      delete room.activePeers[socket.id];
      if (room.participants[userId]) {
        room.participants[userId].joined   = false;
        room.participants[userId].leftAt   = new Date().toISOString();
      }
      createLog(roomId, userId, name, "left");
      socket.to(roomId).emit("peer-left", { peerId: socket.id, userId, name });
    }

    peers.delete(socket.id);
    console.log(`[LEFT]  ${name} (${userId}) ← room ${roomId}`);
  });
});

// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🚀 TutorConnect SDK  →  http://localhost:${PORT}`);
  console.log(`📡 Create room  :  POST   /api/rooms`);
  console.log(`📋 Room logs    :  GET    /api/rooms/:id/logs`);
  console.log(`🎥 Session page :  GET    /session/:id?userId=X&name=Y\n`);
});
