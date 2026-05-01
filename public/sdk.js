/**
 * TutorConnect SDK  v2.0
 * Self-hosted video + whiteboard with identity & tracking
 *
 * ── Quick start ──────────────────────────────────────────
 *
 * <script src="https://your-domain.com/sdk.js"></script>
 * <script>
 *   const tc = new TutorConnect({ host: 'https://your-domain.com' });
 *
 *   const session = await tc.createSession({
 *     tutor:   { userId: 'teacher_1', name: 'Mr. Smith' },
 *     student: { userId: 'student_1', name: 'Alice' },
 *     metadata: { subject: 'Math', grade: '8' }
 *   });
 *
 *   // Give each person their own join button/link
 *   tc.launch(session.tutorJoinUrl);    // tutor clicks this
 *   tc.launch(session.studentJoinUrl);  // student clicks this
 * </script>
 */

(function (global) {
  "use strict";

  class TutorConnect {
    constructor({ host = "" } = {}) {
      this.host = host.replace(/\/$/, "");
    }

    /**
     * Create a new session
     *
     * @param {object} opts
     * @param {object} opts.tutor   - { userId, name }
     * @param {object} opts.student - { userId, name }
     * @param {object} opts.metadata - optional extra data (subject, grade, etc.)
     *
     * @returns {Promise<{
     *   roomId: string,
     *   tutorJoinUrl: string,    ← open this for the tutor
     *   studentJoinUrl: string,  ← open this for the student
     *   embedCode: string        ← copy-paste iframe
     * }>}
     */
    async createSession({ tutor, student, metadata = {} } = {}) {
      if (!tutor?.userId || !tutor?.name)     throw new Error("tutor.userId and tutor.name are required");
      if (!student?.userId || !student?.name) throw new Error("student.userId and student.name are required");

      const res = await fetch(`${this.host}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tutor, student, metadata }),
      });
      if (!res.ok) throw new Error(`Failed to create session: ${res.statusText}`);
      return res.json();
    }

    /**
     * Get session info (participants, status)
     */
    async getSession(roomId) {
      const res = await fetch(`${this.host}/api/rooms/${roomId}`);
      if (!res.ok) throw new Error("Session not found");
      return res.json().then(d => d.room);
    }

    /**
     * Get full activity log for a session
     * Returns array of { event, userId, name, timestamp }
     * Events: "joined" | "left" | "drew" | "cleared_board" | "room_created" | "room_ended"
     */
    async getLogs(roomId) {
      const res = await fetch(`${this.host}/api/rooms/${roomId}/logs`);
      if (!res.ok) throw new Error("Could not get logs");
      return res.json().then(d => d.logs);
    }

    /**
     * Get a clean human-readable summary of the session
     * { participants: [{ name, role, joinedAt, leftAt, drawCount }], totalDrawEvents }
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
     * Launch a join URL in a popup window
     * Pass either tutorJoinUrl or studentJoinUrl from createSession()
     */
    launch(joinUrl, { width = 1100, height = 700 } = {}) {
      const left = (screen.width  - width)  / 2;
      const top  = (screen.height - height) / 2;
      window.open(joinUrl, "TutorConnect", `width=${width},height=${height},left=${left},top=${top},resizable=yes`);
    }

    /**
     * Embed a session inside a div on your page
     * @param {string|Element} container - CSS selector or DOM element
     * @param {string} joinUrl - tutorJoinUrl or studentJoinUrl
     */
    embed(container, joinUrl, { height = "620px" } = {}) {
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
