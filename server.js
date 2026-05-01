const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────
// In-memory store (swap with DB in production)
// rooms   → room info + allowed users
// logs    → every tracked event
// ─────────────────────────────────────────────
const rooms = new Map(); // roomId → room object
const logs  = new Map(); // roomId → array of log entries

function now() { return new Date().toISOString(); }

function addLog(roomId, entry) {
  if (!logs.has(roomId)) logs.set(roomId, []);
  logs.get(roomId).push({ ...entry, timestamp: now() });
}

// ─────────────────────────────────────────────
// REST API
// ─────────────────────────────────────────────

/**
 * POST /api/rooms
 * Create a session. Define exactly who is allowed to join.
 *
 * Body:
 * {
 *   "tutor":   { "userId": "t1", "name": "Mr. Smith" },
 *   "student": { "userId": "s1", "name": "Alice" },
 *   "metadata": { "subject": "Math", "grade": "8" }  ← optional
 * }
 *
 * Response:
 * {
 *   "roomId": "abc123",
 *   "tutorJoinUrl":   "https://your-domain/session/abc123?userId=t1&name=Mr.+Smith",
 *   "studentJoinUrl": "https://your-domain/session/abc123?userId=s1&name=Alice"
 * }
 */
app.post("/api/rooms", (req, res) => {
  const { tutor, student, metadata = {} } = req.body;

  if (!tutor?.userId || !tutor?.name)   return res.status(400).json({ error: "tutor.userId and tutor.name are required" });
  if (!student?.userId || !student?.name) return res.status(400).json({ error: "student.userId and student.name are required" });

  const roomId = crypto.randomBytes(8).toString("hex");
  const base = `${req.protocol}://${req.get("host")}`;

  const room = {
    roomId,
    createdAt: now(),
    status: "waiting", // waiting | active | ended
    metadata,
    // Pre-defined participants
    participants: {
      [tutor.userId]:   { userId: tutor.userId,   name: tutor.name,   role: "tutor",   joinedAt: null, leftAt: null },
      [student.userId]: { userId: student.userId, name: student.name, role: "student", joinedAt: null, leftAt: null },
    },
    // Track who is currently connected (socketId → userId)
    connected: {},
  };

  rooms.set(roomId, room);
  logs.set(roomId, []);

  // Build join URLs — app just opens these for each user
  const tutorJoinUrl   = `${base}/session/${roomId}?userId=${encodeURIComponent(tutor.userId)}&name=${encodeURIComponent(tutor.name)}`;
  const studentJoinUrl = `${base}/session/${roomId}?userId=${encodeURIComponent(student.userId)}&name=${encodeURIComponent(student.name)}`;

  addLog(roomId, { event: "room_created", metadata });

  res.json({
    success: true,
    roomId,
    tutorJoinUrl,
    studentJoinUrl,
    // Convenience: raw embed code using tutor URL
    embedCode: `<iframe src="${tutorJoinUrl}" allow="camera;microphone" style="width:100%;height:620px;border:none;border-radius:12px;"></iframe>`,
  });
});

/**
 * GET /api/rooms/:roomId
 * Get room info + current participants status
 */
app.get("/api/rooms/:roomId", (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });
  res.json({ success: true, room });
});

/**
 * GET /api/rooms/:roomId/logs
 * Get full activity log for a session
 * (who joined when, left when, drew on board, etc.)
 */
app.get("/api/rooms/:roomId/logs", (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });
  const roomLogs = logs.get(req.params.roomId) || [];
  res.json({ success: true, roomId: req.params.roomId, logs: roomLogs });
});

/**
 * DELETE /api/rooms/:roomId
 * End session
 */
app.delete("/api/rooms/:roomId", (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (room) {
    room.status = "ended";
    addLog(req.params.roomId, { event: "room_ended", by: "api" });
  }
  io.to(req.params.roomId).emit("session-ended");
  res.json({ success: true });
});

/**
 * GET /api/rooms/:roomId/summary
 * Human-readable session summary
 */
app.get("/api/rooms/:roomId/summary", (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });

  const roomLogs = logs.get(req.params.roomId) || [];
  const drawEvents = roomLogs.filter(l => l.event === "drew").length;

  const summary = Object.values(room.participants).map(p => ({
    name:       p.name,
    role:       p.role,
    userId:     p.userId,
    joinedAt:   p.joinedAt || "Did not join",
    leftAt:     p.leftAt   || (p.joinedAt ? "Still in session" : "—"),
    drawCount:  roomLogs.filter(l => l.event === "drew" && l.userId === p.userId).length,
  }));

  res.json({
    success: true,
    roomId: room.roomId,
    createdAt: room.createdAt,
    status: room.status,
    metadata: room.metadata,
    totalDrawEvents: drawEvents,
    participants: summary,
  });
});

// Serve session page
app.get("/session/:roomId", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "session.html"));
});

// Serve SDK
app.get("/sdk.js", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "sdk.js"));
});

// ─────────────────────────────────────────────
// Socket.io — Signaling + Tracking
// ─────────────────────────────────────────────
io.on("connection", (socket) => {
  let currentRoom = null;
  let currentUser = null; // { userId, name }

  // User joins room with their identity
  socket.on("join-room", ({ roomId, userId, name }) => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit("error", { message: "Room not found" });

    // Validate: only pre-defined participants can join
    if (!room.participants[userId]) {
      return socket.emit("error", { message: "You are not authorised to join this session" });
    }

    currentRoom = roomId;
    currentUser = { userId, name };

    socket.join(roomId);

    // Update participant record
    room.participants[userId].joinedAt = now();
    room.participants[userId].socketId = socket.id;
    room.connected[socket.id] = userId;

    // Update room status
    const joinedCount = Object.values(room.participants).filter(p => p.joinedAt && !p.leftAt).length;
    if (joinedCount >= 2) room.status = "active";

    // Log the join
    addLog(roomId, { event: "joined", userId, name });

    // Tell the other person in the room someone joined
    socket.to(roomId).emit("peer-joined", { userId, name });

    // Send this user the current room state (so UI can show who's already there)
    socket.emit("room-state", {
      roomId,
      participants: room.participants,
      logs: logs.get(roomId),
    });
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

  // ── Whiteboard ────────────────────────────
  socket.on("draw", ({ roomId, data }) => {
    // Sync to the other person
    socket.to(roomId).emit("draw", data);

    // Log every draw stroke with who did it
    if (currentUser) {
      addLog(roomId, { event: "drew", userId: currentUser.userId, name: currentUser.name });
    }
  });

  socket.on("clear-board", ({ roomId }) => {
    socket.to(roomId).emit("clear-board");
    if (currentUser) {
      addLog(roomId, { event: "cleared_board", userId: currentUser.userId, name: currentUser.name });
    }
  });

  // ── Disconnect ────────────────────────────
  socket.on("disconnect", () => {
    if (!currentRoom || !currentUser) return;

    const room = rooms.get(currentRoom);
    if (room) {
      const participant = room.participants[currentUser.userId];
      if (participant) participant.leftAt = now();
      delete room.connected[socket.id];

      const stillConnected = Object.keys(room.connected).length;
      if (stillConnected === 0 && room.status === "active") room.status = "ended";
    }

    addLog(currentRoom, { event: "left", userId: currentUser.userId, name: currentUser.name });
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
