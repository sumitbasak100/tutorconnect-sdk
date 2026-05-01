# TutorConnect SDK 🎓
### Self-hosted Video + Whiteboard with User Tracking

Zero third-party costs. Built on open web technologies.

---

## What this does

- 🎥 **Video calling** between tutor and student (peer-to-peer, free)
- 🖊️ **Shared whiteboard** — both can draw, see each other drawing in real time
- 👤 **Identity** — each person joins with their name and ID from your app
- 📋 **Activity logs** — who joined when, who left, who drew

---

---

# PART 1 — Deploy Your Server (One Time Setup)

## Step 1 — Put the code on GitHub

1. Go to **github.com** and sign up / log in
2. Click the **+** button → **New repository**
3. Name it `tutorconnect-sdk`, click **Create repository**
4. Unzip the file you downloaded
5. On the GitHub page click **"uploading an existing file"**
6. Drag ALL the files into the box → click **Commit changes**

✅ Your code is now on GitHub.

---

## Step 2 — Deploy on Render (free hosting)

1. Go to **render.com** → Sign up with your GitHub account
2. Click **New +** → **Web Service**
3. Connect your `tutorconnect-sdk` GitHub repo
4. Fill in these fields:

| Field | Value |
|---|---|
| Name | tutorconnect-sdk |
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `node server.js` |
| Plan | **Free** |

5. Click **Create Web Service**
6. Wait ~2 minutes → you'll get a URL like:

```
https://tutorconnect-sdk.onrender.com
```

✅ **Your server is live.** Copy that URL — you'll use it everywhere below.

---

---

# PART 2 — How TutorConnect Uses It

## The flow (plain English)

```
Tutor clicks "Start Session" in TutorConnect app
       ↓
TutorConnect calls your server → "create a room for Tutor A and Student B"
       ↓
Your server returns two links:
  - tutorJoinUrl  → send to tutor
  - studentJoinUrl → send to student
       ↓
Both open their link → video + whiteboard appears
       ↓
Everything is tracked: who joined when, who drew what
```

---

## On their Node.js Web App

### Step 1 — Add the SDK script to their HTML
```html
<script src="https://tutorconnect-sdk.onrender.com/sdk.js"></script>
```

### Step 2 — When tutor clicks "Start Session"
```javascript
const tc = new TutorConnect({ host: 'https://tutorconnect-sdk.onrender.com' });

const session = await tc.createSession({
  tutorId:     'tutor_123',       // ← their actual tutor ID from your DB
  tutorName:   'Mr. Smith',       // ← tutor's name
  studentId:   'student_456',     // ← student's ID
  studentName: 'Jane Doe',        // ← student's name
});

// Open for tutor right away
tc.launch(session.tutorJoinUrl);

// Send studentJoinUrl to the student (via notification, SMS, email — however you do it)
console.log(session.studentJoinUrl);
// e.g. https://tutorconnect-sdk.onrender.com/session/abc123?userId=student_456&name=Jane%20Doe
```

### What the session object looks like
```json
{
  "roomId": "abc123def456",
  "tutorJoinUrl":   "https://tutorconnect-sdk.onrender.com/session/abc123?userId=tutor_123&name=Mr.+Smith",
  "studentJoinUrl": "https://tutorconnect-sdk.onrender.com/session/abc123?userId=student_456&name=Jane+Doe"
}
```

---

## On Flutter App

### Step 1 — Add webview_flutter to pubspec.yaml
```yaml
dependencies:
  webview_flutter: ^4.4.2
  http: ^1.1.0
```

### Step 2 — Create a session
```dart
import 'package:http/http.dart' as http;
import 'dart:convert';

Future<Map<String, dynamic>> createSession(
  String tutorId, String tutorName,
  String studentId, String studentName,
) async {
  final res = await http.post(
    Uri.parse('https://tutorconnect-sdk.onrender.com/api/rooms'),
    headers: {'Content-Type': 'application/json'},
    body: jsonEncode({
      'tutorId':     tutorId,
      'tutorName':   tutorName,
      'studentId':   studentId,
      'studentName': studentName,
    }),
  );
  return jsonDecode(res.body);
}
```

### Step 3 — Open in WebView
```dart
import 'package:webview_flutter/webview_flutter.dart';

class SessionScreen extends StatefulWidget {
  final String joinUrl; // pass tutorJoinUrl or studentJoinUrl
  const SessionScreen({ required this.joinUrl });
  @override State<SessionScreen> createState() => _State();
}

class _State extends State<SessionScreen> {
  late final WebViewController _ctrl;

  @override
  void initState() {
    super.initState();
    _ctrl = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..loadRequest(Uri.parse(widget.joinUrl));
  }

  @override
  Widget build(BuildContext context) =>
    Scaffold(body: WebViewWidget(controller: _ctrl));
}

// Usage:
// final session = await createSession('tutor_1', 'Mr. Smith', 'student_1', 'Jane Doe');
// Navigator.push(context, MaterialPageRoute(
//   builder: (_) => SessionScreen(joinUrl: session['tutorJoinUrl'])
// ));
```

---

## iFrame embed (simplest option for web)

Just paste this where you want the session to appear:

```html
<!-- For tutor -->
<iframe
  src="https://tutorconnect-sdk.onrender.com/session/ROOM_ID?userId=tutor_123&name=Mr.+Smith"
  allow="camera;microphone;fullscreen"
  style="width:100%;height:600px;border:none;border-radius:12px;"
></iframe>

<!-- For student -->
<iframe
  src="https://tutorconnect-sdk.onrender.com/session/ROOM_ID?userId=student_456&name=Jane+Doe"
  allow="camera;microphone;fullscreen"
  style="width:100%;height:600px;border:none;border-radius:12px;"
></iframe>
```

---

---

# PART 3 — Activity Logs (Tracking)

## Fetch all logs for a session
```javascript
const logs = await tc.getLogs('ROOM_ID');
console.log(logs);
```

### What a log looks like
```json
{
  "total": 5,
  "logs": [
    { "userId": "tutor_123",   "name": "Mr. Smith", "action": "joined",        "timestamp": "2024-01-15T10:00:00Z" },
    { "userId": "student_456", "name": "Jane Doe",  "action": "joined",        "timestamp": "2024-01-15T10:01:30Z" },
    { "userId": "student_456", "name": "Jane Doe",  "action": "drew",          "timestamp": "2024-01-15T10:05:12Z", "strokeColor": "#ffffff", "strokeSize": 3 },
    { "userId": "tutor_123",   "name": "Mr. Smith", "action": "cleared_board", "timestamp": "2024-01-15T10:10:00Z" },
    { "userId": "student_456", "name": "Jane Doe",  "action": "left",          "timestamp": "2024-01-15T10:45:00Z" }
  ]
}
```

## Filter logs by user or action
```javascript
// Only see what the student did
const studentLogs = await tc.getLogs('ROOM_ID', { userId: 'student_456' });

// Only see join/leave events
const presenceLogs = await tc.getLogs('ROOM_ID', { action: 'joined' });
```

## End a session (from your backend)
```javascript
await tc.endSession('ROOM_ID');
// Kicks everyone out and clears the room
```

---

---

# PART 4 — File Structure

```
tutorconnect-sdk/
├── server.js          ← The brain: API + signaling + tracking
├── package.json       ← Dependencies list
├── public/
│   ├── session.html   ← The video + whiteboard page
│   └── sdk.js         ← Drop-in JS SDK for web apps
└── README.md          ← This file
```

---

# PART 5 — Cost Breakdown

| What | Cost |
|---|---|
| Render hosting | Free (upgrades available) |
| Video calls | Free — peer-to-peer, no server cost |
| Whiteboard sync | Free — tiny data |
| Custom domain | ~$10/year (optional) |

---

# PART 6 — Production Checklist (when ready to scale)

- [ ] Replace in-memory room store with **PostgreSQL** or **Redis**
- [ ] Add a **TURN server** (free tier at metered.ca) for users on strict networks
- [ ] Add API key auth to `/api/rooms` so only your app can create sessions
- [ ] Set `PORT` env variable on Render for custom port
