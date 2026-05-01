/**
 * TutorConnect SDK  v2.0
 * Self-hosted video + whiteboard with user identity & activity tracking
 *
 * ── Quick start ──────────────────────────────────────────────
 *
 * <script src="https://your-domain.com/sdk.js"></script>
 * <script>
 *   const tc = new TutorConnect({ host: 'https://your-domain.com' });
 *
 *   // 1. Create session (do this server-side ideally)
 *   const session = await tc.createSession({
 *     tutorId:     'tutor_123',
 *     tutorName:   'Mr. Smith',
 *     studentId:   'student_456',
 *     studentName: 'Jane Doe',
 *   });
 *
 *   // 2. Open for tutor
 *   tc.launch(session.tutorJoinUrl);
 *
 *   // 3. Open for student (send this URL to them)
 *   tc.launch(session.studentJoinUrl);
 *
 *   // 4. Fetch activity logs anytime
 *   const logs = await tc.getLogs(session.roomId);
 * </script>
 */

(function (global) {
  "use strict";

  class TutorConnect {
    constructor({ host = "" } = {}) {
      this.host = host.replace(/\/$/, "");
    }

    // ── Create a session ──────────────────────────────────────
    /**
     * @param {{ tutorId, tutorName, studentId, studentName, metadata? }} opts
     * @returns {Promise<{ roomId, tutorJoinUrl, studentJoinUrl, embedCode }>}
     */
    async createSession({ tutorId, tutorName, studentId, studentName, metadata = {} } = {}) {
      const res = await fetch(`${this.host}/api/rooms`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ tutorId, tutorName, studentId, studentName, metadata }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to create session: ${res.statusText}`);
      }
      return res.json();
    }

    // ── Get session info ──────────────────────────────────────
    async getSession(roomId) {
      const res = await fetch(`${this.host}/api/rooms/${roomId}`);
      if (!res.ok) throw new Error("Session not found");
      return res.json().then(d => d.room);
    }

    // ── Get activity logs ─────────────────────────────────────
    /**
     * @param {string} roomId
     * @param {{ userId?, action? }} filters  — optional filters
     * @returns {Promise<{ total, logs }>}
     *
     * action can be: "joined" | "left" | "drew" | "cleared_board"
     */
    async getLogs(roomId, { userId, action } = {}) {
      const q = new URLSearchParams();
      if (userId) q.set("userId", userId);
      if (action) q.set("action", action);
      const res = await fetch(`${this.host}/api/rooms/${roomId}/logs?${q}`);
      if (!res.ok) throw new Error("Could not fetch logs");
      return res.json();
    }

    // ── End a session ─────────────────────────────────────────
    async endSession(roomId) {
      const res = await fetch(`${this.host}/api/rooms/${roomId}`, { method: "DELETE" });
      return res.json();
    }

    // ── Launch in popup ───────────────────────────────────────
    /**
     * @param {string} joinUrl  — use session.tutorJoinUrl or session.studentJoinUrl
     */
    launch(joinUrl, { width = 1100, height = 700 } = {}) {
      const left = (screen.width  - width)  / 2;
      const top  = (screen.height - height) / 2;
      window.open(joinUrl, "TutorConnect", `width=${width},height=${height},left=${left},top=${top},resizable=yes`);
    }

    // ── Embed in a div ────────────────────────────────────────
    /**
     * @param {string|Element} container
     * @param {string} joinUrl  — use session.tutorJoinUrl or session.studentJoinUrl
     */
    embed(container, joinUrl, { height = "600px" } = {}) {
      const el = typeof container === "string" ? document.querySelector(container) : container;
      if (!el) throw new Error(`Container not found: ${container}`);
      el.innerHTML = `
        <iframe
          src="${joinUrl}"
          allow="camera;microphone;fullscreen"
          style="width:100%;height:${height};border:none;border-radius:12px;display:block;"
          allowfullscreen
        ></iframe>`;
    }
  }

  global.TutorConnect = TutorConnect;
  if (typeof module !== "undefined" && module.exports) module.exports = TutorConnect;

})(typeof window !== "undefined" ? window : global);
