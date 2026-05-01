# TutorConnect SDK v2 🎓
### Self-hosted video + whiteboard — with identity & session tracking

---

## What this does

- 🎥 **Video calling** — peer-to-peer, no cost, no third-party
- 🖊️ **Shared whiteboard** — draw together in real time
- 👤 **Identity** — each person joins with their name & ID
- 📋 **Tracking** — logs who joined, when they left, how much they drew
- 🔒 **Access control** — only the 2 people you define can join a session

---

&nbsp;

# PART 1 — Deploy Your Server (10 mins)

> You only do this once. After this, TutorConnect just calls your server.

&nbsp;

### Step 1 — Put the code on GitHub

1. Go to **github.com** → sign in → click **"New repository"**
2. Name it `tutorconnect-sdk` → click **Create**
3. Unzip the file you downloaded
4. On the GitHub page, click **"uploading an existing file"**
5. Drag all the files in (server.js, package.json, public folder, README.md)
6. Click **"Commit changes"**

✅ Your code is on GitHub.

&nbsp;

### Step 2 — Deploy on Render (free hosting)

1. Go to **render.com** → sign up with your GitHub account
2. Click **"New +"** → **"Web Service"**
3. Click **"Connect"** next to your `tutorconnect-sdk` repo
4. Fill in these fields:
   - **Name:** `tutorconnect-sdk` (or anything)
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** Free
5. Click **"Create Web Service"**
6. Wait ~2 minutes → Render gives you a URL like:

```
https://tutorconnect-sdk.onrender.com
```

✅ **Your SDK is live.** Share this URL with TutorConnect.

---

&nbsp;

# PART 2 — How TutorConnect Integrates It

> This is what TutorConnect's developer adds to their existing app.

&nbsp;

## The Simple Flow

```
1. Tutor clicks "Start Session" in TutorConnect app
            ↓
2. TutorConnect calls YOUR server → gets 2 unique join links
   (one for tutor, one for student)
            ↓
3. Tutor gets their link → opens video + whiteboard
4. Student gets their link (via notification) → joins session
            ↓
5. Both are connected. Names show up. Everything is tracked.
```

&nbsp;

## On TutorConnect's Node.js Backend

When a session is created, add this:

```js
// Step 1: Create a session on YOUR server
const response = await fetch('https://tutorconnect-sdk.onrender.com/api/rooms', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    tutor:   { userId: 'teacher_1', name: 'Mr. Smith' },
    student: { userId: 'student_1', name: 'Alice' },
    metadata: { subject: 'Math', grade: '8' }  // optional, for your records
  })
});

const session = await response.json();

// session now contains:
// session.roomId          → "a1b2c3d4"
// session.tutorJoinUrl    → "https://tutorconnect-sdk.../session/a1b2c3d4?userId=teacher_1&name=Mr.+Smith"
// session.studentJoinUrl  → "https://tutorconnect-sdk.../session/a1b2c3d4?userId=student_1&name=Alice"

// Step 2: Send each person their own link
// Tutor's app opens: session.tutorJoinUrl
// Student's app opens: session.studentJoinUrl
```

&nbsp;

## On TutorConnect's Web App (browser)

```html
<!-- Add this once in your HTML -->
<script src="https://tutorconnect-sdk.onrender.com/sdk.js"></script>

<script>
const tc = new TutorConnect({ host: 'https://tutorconnect-sdk.onrender.com' });

// When tutor clicks "Start Session":
const session = await tc.createSession({
  tutor:   { userId: 'teacher_1', name: 'Mr. Smith' },
  student: { userId: 'student_1', name: 'Alice' }
});

// Open for the tutor (in a popup)
tc.launch(session.tutorJoinUrl);

// Send studentJoinUrl to student via your notification system
// When student clicks their join button:
tc.launch(session.studentJoinUrl);

// OR embed directly in the page instead of popup:
tc.embed('#session-box', session.tutorJoinUrl);
</script>

<!-- The session appears inside this div when embedded -->
<div id="session-box"></div>
```

&nbsp;

## On TutorConnect's Flutter App

```yaml
# pubspec.yaml — add this dependency
dependencies:
  webview_flutter: ^4.4.2
  http: ^1.1.0
```

```dart
import 'package:webview_flutter/webview_flutter.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';

// Step 1: Create session (call this when tutor taps "Start Session")
Future<Map<String, dynamic>> createSession(String tutorId, String tutorName, String studentId, String studentName) async {
  final res = await http.post(
    Uri.parse('https://tutorconnect-sdk.onrender.com/api/rooms'),
    headers: {'Content-Type': 'application/json'},
    body: jsonEncode({
      'tutor':   { 'userId': tutorId,   'name': tutorName },
      'student': { 'userId': studentId, 'name': studentName },
    }),
  );
  return jsonDecode(res.body);
}

// Step 2: Open the session in a WebView
class SessionScreen extends StatefulWidget {
  final String joinUrl; // pass tutorJoinUrl OR studentJoinUrl
  const SessionScreen({ required this.joinUrl, super.key });
  @override State<SessionScreen> createState() => _SessionScreenState();
}

class _SessionScreenState extends State<SessionScreen> {
  late final WebViewController _ctrl;

  @override
  void initState() {
    super.initState();
    _ctrl = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..loadRequest(Uri.parse(widget.joinUrl));
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Session')),
    body: WebViewWidget(controller: _ctrl),
  );
}

// Usage in your app:
// final session = await createSession('t1', 'Mr. Smith', 's1', 'Alice');
// 
// Tutor:   Navigator.push(context, MaterialPageRoute(builder: (_) => SessionScreen(joinUrl: session['tutorJoinUrl'])));
// Student: Navigator.push(context, MaterialPageRoute(builder: (_) => SessionScreen(joinUrl: session['studentJoinUrl'])));
```

---

&nbsp;

# PART 3 — Tracking & Logs

> After a session, you can fetch exactly what happened — who joined, when, and how much they drew.

&nbsp;

## Get session summary

```js
// Simple overview
GET https://tutorconnect-sdk.onrender.com/api/rooms/ROOM_ID/summary

// Returns:
{
  "participants": [
    {
      "name": "Mr. Smith",
      "role": "tutor",
      "joinedAt": "2024-01-15T10:00:00Z",
      "leftAt": "2024-01-15T10:45:00Z",
      "drawCount": 42        ← how many times they drew on the board
    },
    {
      "name": "Alice",
      "role": "student",
      "joinedAt": "2024-01-15T10:01:30Z",
      "leftAt": "2024-01-15T10:45:00Z",
      "drawCount": 17
    }
  ],
  "totalDrawEvents": 59,
  "status": "ended"
}
```

&nbsp;

## Get full activity log

```js
// Every single event with timestamps
GET https://tutorconnect-sdk.onrender.com/api/rooms/ROOM_ID/logs

// Returns array of events like:
[
  { "event": "room_created", "timestamp": "2024-01-15T09:59:00Z" },
  { "event": "joined",  "userId": "teacher_1", "name": "Mr. Smith",  "timestamp": "2024-01-15T10:00:00Z" },
  { "event": "joined",  "userId": "student_1", "name": "Alice",      "timestamp": "2024-01-15T10:01:30Z" },
  { "event": "drew",    "userId": "teacher_1", "name": "Mr. Smith",  "timestamp": "2024-01-15T10:05:12Z" },
  { "event": "drew",    "userId": "student_1", "name": "Alice",      "timestamp": "2024-01-15T10:06:44Z" },
  { "event": "left",    "userId": "teacher_1", "name": "Mr. Smith",  "timestamp": "2024-01-15T10:45:00Z" },
  { "event": "left",    "userId": "student_1", "name": "Alice",      "timestamp": "2024-01-15T10:45:03Z" }
]
```

---

&nbsp;

# PART 4 — File Structure

```
tutorconnect-sdk/
├── server.js          ← The brain. Handles sessions, signaling, tracking.
├── package.json       ← Dependencies list (express, socket.io, cors)
├── public/
│   ├── session.html   ← The video + whiteboard page users see
│   └── sdk.js         ← Drop-in JS SDK for web apps
└── README.md          ← This file
```

---

&nbsp;

# PART 5 — Cost Breakdown

| Thing | Cost |
|---|---|
| Render hosting | **Free** (upgrade if you need always-on) |
| Video calls | **Free** — video goes directly between users, not through your server |
| Whiteboard sync | **Free** — only tiny drawing coordinates are sent |
| Custom domain | ~$10/year (optional) |

> 💡 Free Render servers sleep after 15 mins of inactivity. For production, upgrade to the $7/month plan so it's always on.

---

&nbsp;

# PART 6 — Production Checklist

- [ ] Deploy on Render (or Railway / Fly.io)
- [ ] Share your URL with TutorConnect's developer
- [ ] They add the `createSession` call to their backend
- [ ] They open `tutorJoinUrl` / `studentJoinUrl` in WebView or popup
- [ ] Test with 2 devices
- [ ] Upgrade Render to paid plan when going live ($7/month)
- [ ] Optional: add a TURN server for users on strict networks (Metered.ca has free tier)
