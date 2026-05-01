/**
 * TutorConnect SDK  v3.0
 * Self-hosted video + whiteboard — clean URLs, no query params
 *
 * Session URLs: /session/:roomId/:userId
 *
 * ── Quick start ──────────────────────────────────────────
 *
 * <script src="https://your-domain.com/sdk.js"></script>
 * <script>
 *   const tc = new TutorConnect({ host: 'https://your-domain.com' });
 *
 *   const session = await tc.createSession({
 *     tutor:    { userId: 'teacher_1', name: 'Mr. Smith' },
 *     student:  { userId: 'student_1', name: 'Alice' },
 *     metadata: { subject: 'Math' }   // optional
 *   });
 *
 *   // Each person gets their own URL — open it however you want
 *   tc.launch(session.tutorJoinUrl);    // tutor
 *   tc.launch(session.studentJoinUrl);  // student
 * </script>
 */

(function (global) {
  "use strict";

  class TutorConnect {
    constructor({ host = "" } = {}) {
      this.host = host.replace(/\/$/, "");
    }

    /**
     * Create a session
     * @param {{ tutor: {userId, name}, student: {userId, name}, metadata?: object }} opts
     * @returns {Promise<{ roomId, tutorJoinUrl, studentJoinUrl, embedCode }>}
     */
    async createSession({ tutor, student, metadata = {} } = {}) {
      if (!tutor?.userId || !tutor?.name)     throw new Error("tutor.userId and tutor.name are required");
      if (!student?.userId || !student?.name) throw new Error("student.userId and student.name are required");

      const res = await fetch(`${this.host}/api/rooms`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ tutor, student, metadata }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Request failed: ${res.status}`);
      }
      return res.json();
    }

    /**
     * Get session info
     */
    async getSession(roomId) {
      const res = await fetch(`${this.host}/api/rooms/${roomId}`);
      if (!res.ok) throw new Error("Session not found");
      return res.json().then(d => d.room);
    }

    /**
     * Get session summary (who joined, when, draw counts)
     */
    async getSummary(roomId) {
      const res = await fetch(`${this.host}/api/rooms/${roomId}/summary`);
      if (!res.ok) throw new Error("Could not get summary");
      return res.json();
    }

    /**
     * End a session
     */
    async endSession(roomId) {
      const res = await fetch(`${this.host}/api/rooms/${roomId}`, { method: "DELETE" });
      return res.json();
    }

    /**
     * Launch a join URL in a popup
     * @param {string} joinUrl  — tutorJoinUrl or studentJoinUrl from createSession()
     */
    launch(joinUrl, { width = 1200, height = 720 } = {}) {
      const left = Math.max(0, (screen.width  - width)  / 2);
      const top  = Math.max(0, (screen.height - height) / 2);
      window.open(joinUrl, `tc_session_${Date.now()}`, `width=${width},height=${height},left=${left},top=${top},resizable=yes`);
    }

    /**
     * Embed a session inside a div
     * @param {string|Element} container
     * @param {string} joinUrl  — tutorJoinUrl or studentJoinUrl
     */
    embed(container, joinUrl, { height = "620px" } = {}) {
      const el = typeof container === "string" ? document.querySelector(container) : container;
      if (!el) throw new Error(`Container not found: ${container}`);
      el.innerHTML = `<iframe src="${joinUrl}" allow="camera;microphone;fullscreen" style="width:100%;height:${height};border:none;border-radius:12px;display:block;" allowfullscreen></iframe>`;
    }

    /**
     * Just get the join URL (for Flutter WebView / React Native)
     * @param {string} roomId
     * @param {string} userId
     */
    getJoinUrl(roomId, userId) {
      return `${this.host}/session/${roomId}/${encodeURIComponent(userId)}`;
    }
  }

  global.TutorConnect = TutorConnect;
  if (typeof module !== "undefined" && module.exports) module.exports = TutorConnect;

})(typeof window !== "undefined" ? window : global);
