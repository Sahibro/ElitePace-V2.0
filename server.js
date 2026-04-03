'use strict';

// ── IMPORTS ──────────────────────────────────────────────────
require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const PDFDocument = require('pdfkit');
const ExcelJS    = require('exceljs');

// ── APP SETUP ─────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST','PATCH'] },
  pingTimeout:  60000,
  pingInterval: 25000,
  transports: ['websocket','polling']
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── IN-MEMORY STORES ──────────────────────────────────────────
const rooms     = new Map(); // roomId → room object
const problems  = [];        // problem reports
const feedbacks = [];        // user feedbacks
const errorLogs = [];        // frontend error logs
const timerIntervals = new Map(); // roomId → intervalId

// ── HELPER: Generate Room ID ───────────────────────────────────
function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

// ── HELPER: Format Duration ────────────────────────────────────
function formatDuration(ms) {
  if (!ms || isNaN(ms)) return '0s';
  const totalSecs = Math.max(0, Math.floor(ms / 1000));
  const hrs  = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  if (hrs  > 0) return `${hrs}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

// ── HELPER: Format Time MM:SS ──────────────────────────────────
function formatTime(secs) {
  if (!secs || isNaN(secs)) return '00:00';
  const s = Math.max(0, Math.floor(secs));
  return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}

// ── HELPER: Is Manager ────────────────────────────────────────
function isManager(socket, room) {
  if (!socket || !room) return false;
  return room.managers.has(socket.id) ||
    room.clients.get(socket.id)?.role === 'manager' ||
    room.clients.get(socket.id)?.role === 'cohost';
}

// ── HELPER: Serialize Room (safe to send) ─────────────────────
function serializeRoom(room) {
  if (!room) return null;
  return {
    roomId:              room.roomId,
    status:              room.status,
    timer:               room.timer,
    speakerQueue:        room.speakerQueue,
    activeSpeakerIndex:  room.activeSpeakerIndex,
    chatHistory:         room.chatHistory.slice(-50),
    analytics:           room.analytics,
    clientCount:         room.clients.size
  };
}

// ── CREATE ROOM OBJECT ─────────────────────────────────────────
function createRoom(roomId, managerId) {
  return {
    roomId,
    createdAt:  Date.now(),
    status:     'waiting',
    managers:   new Set([managerId]),
    speakerQueue: [],
    activeSpeakerIndex: -1,
    timer: {
      totalSeconds:     900,
      remainingSeconds: 900,
      isRunning:        false,
      isPaused:         false,
      lastTickAt:       null
    },
    chatHistory: [],
    analytics: {
      sessionStartTime: null,
      sessionEndTime:   null,
      totalPauses:      0,
      totalMessages:    0,
      speakerStats:     {}
    },
    clients: new Map() // socketId → { role, name }
  };
}

// ── CREATE SPEAKER OBJECT ──────────────────────────────────────
function createSpeaker(name, timeLimit, order) {
  return {
    id:        uuidv4(),
    name:      name  || `Speaker ${order}`,
    timeLimit: typeof timeLimit === 'number' && timeLimit > 0
                 ? timeLimit : 600,
    usedTime:  0,
    overTime:  0,
    status:    'waiting',
    joinedAt:  null,
    startedAt: null,
    endedAt:   null,
    socketId:  null
  };
}

// ── TIMER ENGINE ───────────────────────────────────────────────
function startServerTimer(roomId) {
  // Clear existing interval first
  stopServerTimer(roomId);

  const room = rooms.get(roomId);
  if (!room) return;

  room.timer.isRunning  = true;
  room.timer.isPaused   = false;
  room.timer.lastTickAt = Date.now();

  const interval = setInterval(() => {
    try {
      const r = rooms.get(roomId);
      if (!r || !r.timer.isRunning) {
        clearInterval(interval);
        timerIntervals.delete(roomId);
        return;
      }

      const now     = Date.now();
      const elapsed = Math.floor((now - r.timer.lastTickAt) / 1000);
      r.timer.lastTickAt = now;

      if (elapsed > 0) {
        r.timer.remainingSeconds = Math.max(
          0, r.timer.remainingSeconds - elapsed
        );

        // Update active speaker stats
        const spk = r.speakerQueue[r.activeSpeakerIndex];
        if (spk && spk.status === 'active') {
          spk.usedTime += elapsed;
          spk.overTime  = Math.max(0, spk.usedTime - spk.timeLimit);

          if (!r.analytics.speakerStats[spk.id]) {
            r.analytics.speakerStats[spk.id] = {
              name:      spk.name,
              timeLimit: spk.timeLimit,
              usedTime:  0,
              overTime:  0
            };
          }
          r.analytics.speakerStats[spk.id].usedTime = spk.usedTime;
          r.analytics.speakerStats[spk.id].overTime  = spk.overTime;
        }
      }

      // Emit tick
      io.to(roomId).emit('timer:tick', {
        remainingSeconds:    r.timer.remainingSeconds,
        isRunning:           r.timer.isRunning,
        activeSpeakerIndex:  r.activeSpeakerIndex,
        speakerQueue:        r.speakerQueue
      });

      // Warnings
      if (r.timer.remainingSeconds === 120) {
        io.to(roomId).emit('timer:warning', {
          message: 'Two minutes remaining!'
        });
      }
      if (r.timer.remainingSeconds === 30) {
        io.to(roomId).emit('timer:critical', {
          message: 'Thirty seconds remaining!'
        });
      }

      // Timer ended
      if (r.timer.remainingSeconds <= 0) {
        r.timer.isRunning        = false;
        r.timer.remainingSeconds = 0;
        clearInterval(interval);
        timerIntervals.delete(roomId);
        io.to(roomId).emit('timer:ended', { roomId });
        autoNextSpeaker(roomId);
      }

    } catch (err) {
      console.error('Timer interval error:', err);
      clearInterval(interval);
      timerIntervals.delete(roomId);
    }
  }, 1000);

  timerIntervals.set(roomId, interval);
}

function stopServerTimer(roomId) {
  const room = rooms.get(roomId);
  if (room) {
    room.timer.isRunning  = false;
    room.timer.lastTickAt = null;
  }
  if (timerIntervals.has(roomId)) {
    clearInterval(timerIntervals.get(roomId));
    timerIntervals.delete(roomId);
  }
}

function autoNextSpeaker(roomId) {
  try {
    const room = rooms.get(roomId);
    if (!room) return;

    const curr = room.activeSpeakerIndex;
    const next = curr + 1;

    if (curr >= 0 && room.speakerQueue[curr]) {
      room.speakerQueue[curr].status  = 'done';
      room.speakerQueue[curr].endedAt = Date.now();
    }

    if (next < room.speakerQueue.length) {
      room.speakerQueue[next].status = 'next';
      const nextSpk = room.speakerQueue[next];

      // Alert next speaker socket directly
      if (nextSpk.socketId) {
        io.to(nextSpk.socketId).emit('speaker:getReady', {
          message: "Get Ready! You're up next!",
          speaker: nextSpk
        });
      }
      // Also broadcast to room
      io.to(roomId).emit('speaker:getReady', {
        message: "Get Ready! You're up next!",
        speaker: nextSpk,
        nextIndex: next
      });
    }
  } catch (err) {
    console.error('autoNextSpeaker error:', err);
  }
}

// ── CLEAN UP OLD ROOMS (every 6 hours) ────────────────────────
setInterval(() => {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const now = Date.now();
  rooms.forEach((room, roomId) => {
    if (now - room.createdAt > SIX_HOURS) {
      stopServerTimer(roomId);
      rooms.delete(roomId);
      console.log(`🗑️ Cleaned up old room: ${roomId}`);
    }
  });
}, 60 * 60 * 1000); // run every 1 hour

// ════════════════════════════════════════════════════════════════
//  SOCKET.IO EVENTS
// ════════════════════════════════════════════════════════════════
io.on('connection', (socket) => {
  console.log(`✅ Client connected: ${socket.id}`);

  // ── CREATE ROOM ────────────────────────────────────────────
  socket.on('room:create', ({ name } = {}) => {
    try {
      const roomId = generateRoomId();
      const room   = createRoom(roomId, socket.id);

      room.clients.set(socket.id, {
        role: 'manager',
        name: name || 'Manager'
      });

      rooms.set(roomId, room);
      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.role   = 'manager';
      socket.data.name   = name || 'Manager';

      socket.emit('room:created', {
        roomId,
        role: 'manager',
        room: serializeRoom(room)
      });

      console.log(`🏠 Room created: ${roomId} by ${name}`);
    } catch (err) {
      console.error('room:create error:', err);
      socket.emit('error', { message: 'Failed to create room' });
    }
  });

  // ── JOIN ROOM ──────────────────────────────────────────────
  socket.on('room:join', ({ roomId, role, name } = {}) => {
    try {
      if (!roomId) {
        socket.emit('error', { message: 'Room ID required' });
        return;
      }

      const id   = roomId.toUpperCase().trim();
      const room = rooms.get(id);

      if (!room) {
        socket.emit('error', { message: 'Room not found. Check the ID.' });
        return;
      }
      if (room.status === 'ended') {
        socket.emit('error', { message: 'This session has ended.' });
        return;
      }

      socket.join(id);
      socket.data.roomId = id;
      socket.data.role   = role;
      socket.data.name   = name;

      const clientRole = (role === 'cohost') ? 'cohost' :
                         (role === 'manager') ? 'manager' : 'speaker';

      room.clients.set(socket.id, {
        role: clientRole,
        name: name || 'Guest'
      });

      if (clientRole === 'cohost') {
        room.managers.add(socket.id);
      }

      // Link speaker socket
      if (clientRole === 'speaker') {
        const spk = room.speakerQueue.find(s => s.name === name);
        if (spk) {
          spk.socketId = socket.id;
          spk.joinedAt = Date.now();
          spk.status   = 'ready';
        }
      }

      socket.emit('room:joined', {
        roomId: id,
        role:   clientRole,
        room:   serializeRoom(room)
      });

      // Notify others
      socket.to(id).emit('room:update', {
        room:  serializeRoom(room),
        event: `${name || 'Someone'} joined as ${clientRole}`
      });

      console.log(`👤 ${name} joined room ${id} as ${clientRole}`);
    } catch (err) {
      console.error('room:join error:', err);
      socket.emit('error', { message: 'Failed to join room' });
    }
  });

  // ── TIMER: START ───────────────────────────────────────────
  socket.on('timer:start', ({ roomId } = {}) => {
    try {
      const room = rooms.get(roomId);
      if (!room) { socket.emit('error',{ message:'Room not found' }); return; }
      if (!isManager(socket, room)) { socket.emit('error',{ message:'Not authorized' }); return; }
      if (room.timer.remainingSeconds <= 0) {
        socket.emit('error', { message: 'Reset timer first' }); return;
      }

      if (!room.analytics.sessionStartTime) {
        room.analytics.sessionStartTime = Date.now();
      }

      // Set first speaker active
      if (room.activeSpeakerIndex === -1 &&
          room.speakerQueue.length > 0) {
        room.activeSpeakerIndex       = 0;
        room.speakerQueue[0].status   = 'active';
        room.speakerQueue[0].startedAt = Date.now();
      }

      startServerTimer(roomId);

      io.to(roomId).emit('timer:started', {
        timer:               room.timer,
        activeSpeakerIndex:  room.activeSpeakerIndex,
        speakerQueue:        room.speakerQueue
      });
    } catch (err) {
      console.error('timer:start error:', err);
      socket.emit('error', { message: 'Failed to start timer' });
    }
  });

  // ── TIMER: PAUSE ───────────────────────────────────────────
  socket.on('timer:pause', ({ roomId } = {}) => {
    try {
      const room = rooms.get(roomId);
      if (!room || !isManager(socket, room)) return;

      stopServerTimer(roomId);
      room.timer.isPaused = true;
      room.analytics.totalPauses++;

      io.to(roomId).emit('timer:paused', { timer: room.timer });
    } catch (err) {
      console.error('timer:pause error:', err);
    }
  });

  // ── TIMER: RESET ───────────────────────────────────────────
  socket.on('timer:reset', ({ roomId } = {}) => {
    try {
      const room = rooms.get(roomId);
      if (!room || !isManager(socket, room)) return;

      stopServerTimer(roomId);
      room.timer.remainingSeconds = room.timer.totalSeconds;
      room.timer.isRunning        = false;
      room.timer.isPaused         = false;

      io.to(roomId).emit('timer:reset', { timer: room.timer });
    } catch (err) {
      console.error('timer:reset error:', err);
    }
  });

  // ── TIMER: SET ─────────────────────────────────────────────
  socket.on('timer:set', ({ roomId, totalSeconds } = {}) => {
    try {
      const room = rooms.get(roomId);
      if (!room || !isManager(socket, room)) return;

      const secs = parseInt(totalSeconds, 10);
      if (isNaN(secs) || secs < 1 || secs > 10800) {
        socket.emit('error', { message: 'Invalid time (1s–3hrs)' });
        return;
      }

      stopServerTimer(roomId);
      room.timer.totalSeconds     = secs;
      room.timer.remainingSeconds = secs;
      room.timer.isRunning        = false;
      room.timer.isPaused         = false;

      io.to(roomId).emit('timer:set', { timer: room.timer });
    } catch (err) {
      console.error('timer:set error:', err);
    }
  });

  // ── TIMER: ADJUST ──────────────────────────────────────────
  socket.on('timer:adjust', ({ roomId, seconds } = {}) => {
    try {
      const room = rooms.get(roomId);
      if (!room || !isManager(socket, room)) return;

      const adj = parseInt(seconds, 10);
      if (isNaN(adj)) return;

      room.timer.remainingSeconds = Math.max(0,
        Math.min(room.timer.totalSeconds,
          room.timer.remainingSeconds + adj));

      io.to(roomId).emit('timer:adjusted', {
        remainingSeconds: room.timer.remainingSeconds
      });
    } catch (err) {
      console.error('timer:adjust error:', err);
    }
  });

  // ── SPEAKER: ADD ───────────────────────────────────────────
  socket.on('speaker:add', ({ roomId, name, timeLimit } = {}) => {
    try {
      const room = rooms.get(roomId);
      if (!room || !isManager(socket, room)) return;
      if (!name || !name.trim()) {
        socket.emit('error', { message: 'Speaker name required' });
        return;
      }

      const spk = createSpeaker(
        name.trim(),
        parseInt(timeLimit, 10) || 600,
        room.speakerQueue.length + 1
      );
      room.speakerQueue.push(spk);

      io.to(roomId).emit('speaker:added', {
        speaker: spk,
        queue:   room.speakerQueue
      });
    } catch (err) {
      console.error('speaker:add error:', err);
    }
  });

  // ── SPEAKER: REMOVE ────────────────────────────────────────
  socket.on('speaker:remove', ({ roomId, speakerId } = {}) => {
    try {
      const room = rooms.get(roomId);
      if (!room || !isManager(socket, room)) return;

      room.speakerQueue = room.speakerQueue
        .filter(s => s.id !== speakerId);

      io.to(roomId).emit('speaker:removed', {
        speakerId,
        queue: room.speakerQueue
      });
    } catch (err) {
      console.error('speaker:remove error:', err);
    }
  });

  // ── SPEAKER: SET ACTIVE ────────────────────────────────────
  socket.on('speaker:setActive', ({ roomId, index } = {}) => {
    try {
      const room = rooms.get(roomId);
      if (!room || !isManager(socket, room)) return;

      const idx = parseInt(index, 10);
      if (isNaN(idx) || idx < 0 ||
          idx >= room.speakerQueue.length) {
        socket.emit('error', { message: 'Invalid speaker index' });
        return;
      }

      // Mark previous done
      const prev = room.speakerQueue[room.activeSpeakerIndex];
      if (prev && room.activeSpeakerIndex !== idx) {
        prev.status  = 'done';
        prev.endedAt = Date.now();
      }

      // Set new active
      room.activeSpeakerIndex            = idx;
      room.speakerQueue[idx].status      = 'active';
      room.speakerQueue[idx].startedAt   = Date.now();

      // Mark next speaker
      const nextIdx = idx + 1;
      if (nextIdx < room.speakerQueue.length &&
          room.speakerQueue[nextIdx].status === 'waiting') {
        room.speakerQueue[nextIdx].status = 'next';
      }

      // Reset timer to speaker's time
      stopServerTimer(roomId);
      room.timer.totalSeconds     = room.speakerQueue[idx].timeLimit;
      room.timer.remainingSeconds = room.speakerQueue[idx].timeLimit;
      room.timer.isRunning        = false;

      io.to(roomId).emit('speaker:activated', {
        activeIndex:  idx,
        queue:        room.speakerQueue,
        timer:        room.timer
      });
    } catch (err) {
      console.error('speaker:setActive error:', err);
    }
  });

  // ── CHAT: SEND ─────────────────────────────────────────────
  socket.on('chat:send', ({
    roomId, message, targetId, isPrivate
  } = {}) => {
    try {
      const room = rooms.get(roomId);
      if (!room) return;

      const msg = (message || '').trim().slice(0, 500);
      if (!msg) return;

      const client = room.clients.get(socket.id);
      const chatMsg = {
        id:          uuidv4(),
        senderId:    socket.id,
        senderName:  client?.name || 'Unknown',
        senderRole:  client?.role || 'speaker',
        message:     msg,
        timestamp:   Date.now(),
        isPrivate:   isPrivate || false,
        targetId:    targetId  || null,
        deleted:     false
      };

      room.chatHistory.push(chatMsg);
      room.analytics.totalMessages++;

      // Trim history to last 200
      if (room.chatHistory.length > 200) {
        room.chatHistory = room.chatHistory.slice(-200);
      }

      if (isPrivate && targetId) {
        socket.emit('chat:message', chatMsg);
        io.to(targetId).emit('chat:message', chatMsg);
        room.managers.forEach(mId => {
          if (mId !== socket.id && mId !== targetId) {
            io.to(mId).emit('chat:message', chatMsg);
          }
        });
      } else {
        io.to(roomId).emit('chat:message', chatMsg);
      }
    } catch (err) {
      console.error('chat:send error:', err);
    }
  });

  // ── CHAT: DELETE ───────────────────────────────────────────
  socket.on('chat:delete', ({ roomId, messageId } = {}) => {
    try {
      const room = rooms.get(roomId);
      if (!room || !isManager(socket, room)) return;

      const msg = room.chatHistory.find(m => m.id === messageId);
      if (msg) {
        msg.deleted = true;
        msg.message = '[Deleted by manager]';
      }
      io.to(roomId).emit('chat:deleted', { messageId });
    } catch (err) {
      console.error('chat:delete error:', err);
    }
  });

  // ── STEALTH MESSAGE ────────────────────────────────────────
  socket.on('message:send', ({ roomId, message } = {}) => {
    try {
      const room = rooms.get(roomId);
      if (!room || !isManager(socket, room)) return;

      io.to(roomId).emit('message:received', {
        message:   (message || '').slice(0, 200),
        timestamp: Date.now()
      });
    } catch (err) {
      console.error('message:send error:', err);
    }
  });

  // ── COHOST: ADD ────────────────────────────────────────────
  socket.on('cohost:add', ({ roomId, name } = {}) => {
    try {
      const room = rooms.get(roomId);
      if (!room || !isManager(socket, room)) return;

      const origin = `${socket.handshake.headers.origin ||
        'https://your-app.railway.app'}`;
      const link = `${origin}?room=${roomId}` +
        `&role=cohost&name=${encodeURIComponent(name || 'CoHost')}`;

      socket.emit('cohost:link', { link, name });
    } catch (err) {
      console.error('cohost:add error:', err);
    }
  });

  // ── END SESSION ────────────────────────────────────────────
  socket.on('room:end', ({ roomId, feedback } = {}) => {
    try {
      const room = rooms.get(roomId);
      if (!room || !isManager(socket, room)) return;

      stopServerTimer(roomId);
      room.status                    = 'ended';
      room.analytics.sessionEndTime  = Date.now();

      // Save feedback if provided
      if (feedback && feedback.trim()) {
        feedbacks.push({
          id:        uuidv4(),
          roomId,
          role:      'manager',
          message:   feedback.trim().slice(0, 500),
          timestamp: Date.now()
        });
      }

      io.to(roomId).emit('room:ended', {
        analytics: room.analytics
      });

      console.log(`🔴 Room ended: ${roomId}`);
    } catch (err) {
      console.error('room:end error:', err);
    }
  });

  // ── DISCONNECT ─────────────────────────────────────────────
  socket.on('disconnect', () => {
    try {
      const roomId = socket.data?.roomId;
      if (roomId) {
        const room = rooms.get(roomId);
        if (room) {
          room.clients.delete(socket.id);
          room.managers.delete(socket.id);

          io.to(roomId).emit('room:clientLeft', {
            socketId:    socket.id,
            name:        socket.data?.name || 'Someone',
            clientCount: room.clients.size
          });
        }
      }
      console.log(`❌ Disconnected: ${socket.id}`);
    } catch (err) {
      console.error('disconnect error:', err);
    }
  });
});

// ════════════════════════════════════════════════════════════════
//  REST API ROUTES
// ════════════════════════════════════════════════════════════════

// ── HEALTH CHECK ───────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    rooms:   rooms.size,
    uptime:  Math.floor(process.uptime()),
    memory:  process.memoryUsage().heapUsed,
    version: '2.0.0'
  });
});

// ── FEEDBACK: SAVE ─────────────────────────────────────────────
app.post('/feedback', (req, res) => {
  try {
    const {
      roomId, role, name, rating,
      message, tags, wouldRecommend
    } = req.body;

    const r = parseInt(rating, 10);
    if (!r || r < 1 || r > 5) {
      return res.status(400).json({
        error: 'Rating must be 1–5'
      });
    }

    const fb = {
      id:             uuidv4(),
      roomId:         roomId  || 'anonymous',
      role:           role    || 'unknown',
      name:           name    || 'Anonymous',
      rating:         r,
      message:        (message || '').slice(0, 500),
      tags:           Array.isArray(tags) ? tags : [],
      wouldRecommend: wouldRecommend === true,
      timestamp:      Date.now(),
      date:           new Date().toLocaleString()
    };

    feedbacks.push(fb);
    console.log(`💬 Feedback: ${r}⭐ from ${role || 'user'}`);
    res.json({ success: true, id: fb.id });
  } catch (err) {
    console.error('Feedback save error:', err);
    res.status(500).json({ error: 'Failed to save feedback' });
  }
});

// ── FEEDBACK: GET ALL ──────────────────────────────────────────
app.get('/feedbacks', (req, res) => {
  try {
    const total = feedbacks.length;
    const avg   = total > 0
      ? (feedbacks.reduce((a,b) => a + b.rating, 0) / total).toFixed(1)
      : 0;

    res.json({
      total,
      avgRating:       avg,
      wouldRecommend:  feedbacks.filter(f => f.wouldRecommend).length,
      byRating: {
        5: feedbacks.filter(f => f.rating === 5).length,
        4: feedbacks.filter(f => f.rating === 4).length,
        3: feedbacks.filter(f => f.rating === 3).length,
        2: feedbacks.filter(f => f.rating === 2).length,
        1: feedbacks.filter(f => f.rating === 1).length
      },
      recent: feedbacks.slice(-20).reverse()
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch feedbacks' });
  }
});

// ── PROBLEM: REPORT ────────────────────────────────────────────
app.post('/report-problem', (req, res) => {
  try {
    const {
      roomId, role, name, device, browser,
      network, problemType, subProblems,
      severity, description, whenItHappened,
      fixedItself, sessionDuration
    } = req.body;

    const prob = {
      id:              uuidv4(),
      roomId:          roomId       || 'unknown',
      role:            role         || 'unknown',
      name:            name         || 'Anonymous',
      device:          device       || 'unknown',
      browser:         browser      || 'unknown',
      network:         network      || 'unknown',
      problemType:     problemType  || 'other',
      subProblems:     Array.isArray(subProblems) ? subProblems : [],
      severity:        severity     || 'medium',
      description:     (description || '').slice(0, 1000),
      whenItHappened:  whenItHappened || 'unknown',
      fixedItself:     fixedItself === true,
      sessionDuration: sessionDuration || 0,
      timestamp:       Date.now(),
      date:            new Date().toLocaleString(),
      status:          'new'
    };

    problems.push(prob);

    if (prob.severity === 'critical') {
      console.error('🚨 CRITICAL PROBLEM:', prob.problemType,
        '|', prob.description.slice(0,100));
    } else {
      console.log(`🐛 Problem: ${prob.problemType} | ${prob.severity}`);
    }

    res.json({ success: true, id: prob.id });
  } catch (err) {
    console.error('Problem report error:', err);
    res.status(500).json({ error: 'Failed to save problem' });
  }
});

// ── PROBLEM: DASHBOARD ─────────────────────────────────────────
app.get('/problems', (req, res) => {
  try {
    const byType = {};
    problems.forEach(p => {
      if (!byType[p.problemType]) {
        byType[p.problemType] = {
          count: 0, severity: {}, uniqueRooms: new Set()
        };
      }
      byType[p.problemType].count++;
      byType[p.problemType].severity[p.severity] =
        (byType[p.problemType].severity[p.severity] || 0) + 1;
      byType[p.problemType].uniqueRooms.add(p.roomId);
    });

    // Convert Sets
    Object.keys(byType).forEach(k => {
      byType[k].uniqueRooms = byType[k].uniqueRooms.size;
    });

    const subFreq = {};
    problems.forEach(p => {
      (p.subProblems || []).forEach(sp => {
        subFreq[sp] = (subFreq[sp] || 0) + 1;
      });
    });

    res.json({
      summary: {
        total:       problems.length,
        critical:    problems.filter(p => p.severity==='critical').length,
        high:        problems.filter(p => p.severity==='high').length,
        medium:      problems.filter(p => p.severity==='medium').length,
        low:         problems.filter(p => p.severity==='low').length,
        fixedItself: problems.filter(p => p.fixedItself).length,
        errorLogs:   errorLogs.length
      },
      topProblems: Object.entries(byType)
        .sort((a,b) => b[1].count - a[1].count)
        .slice(0, 10),
      subProblemFreq:  subFreq,
      recentProblems:  problems.slice(-20).reverse(),
      recentErrors:    errorLogs.slice(-10).reverse()
    });
  } catch (err) {
    res.status(500).json({ error: 'Dashboard error' });
  }
});

// ── ERROR LOG ──────────────────────────────────────────────────
app.post('/log-error', (req, res) => {
  try {
    const { error, stack, roomId, role, userAgent, url } = req.body;
    errorLogs.push({
      id:        uuidv4(),
      error:     (error     || '').slice(0, 500),
      stack:     (stack     || '').slice(0, 2000),
      roomId:    roomId     || 'unknown',
      role:      role       || 'unknown',
      userAgent: (userAgent || '').slice(0, 200),
      url:       url        || '',
      timestamp: Date.now(),
      date:      new Date().toLocaleString()
    });
    // Keep last 500 logs only
    if (errorLogs.length > 500) errorLogs.splice(0, 100);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Log failed' });
  }
});

// ── PDF REPORT ──────────────────────────────────────────────────
app.get('/report/pdf/:roomId', (req, res) => {
  try {
    const room = rooms.get(
      (req.params.roomId || '').toUpperCase()
    );
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename=ElitePace-${room.roomId}.pdf`);
    doc.pipe(res);

    // ── Header
    doc.fontSize(28).font('Helvetica-Bold')
       .fillColor('#7c5cff').text('ElitePace', 50, 50);
    doc.fontSize(13).font('Helvetica').fillColor('#555')
       .text('Session Report', 50, 82);
    doc.moveTo(50,100).lineTo(550,100)
       .strokeColor('#7c5cff').lineWidth(2).stroke();

    // ── Session Info
    doc.fontSize(11).font('Helvetica-Bold')
       .fillColor('#000').text('SESSION INFORMATION', 50, 118);
    doc.font('Helvetica').fillColor('#333').fontSize(10);

    const start = room.analytics.sessionStartTime
      ? new Date(room.analytics.sessionStartTime).toLocaleString()
      : 'N/A';
    const end = room.analytics.sessionEndTime
      ? new Date(room.analytics.sessionEndTime).toLocaleString()
      : 'N/A';
    const dur = room.analytics.sessionStartTime &&
      room.analytics.sessionEndTime
      ? formatDuration(room.analytics.sessionEndTime -
          room.analytics.sessionStartTime)
      : 'N/A';

    const infoRows = [
      ['Room ID',         room.roomId],
      ['Start Time',      start],
      ['End Time',        end],
      ['Total Duration',  dur],
      ['Total Pauses',    room.analytics.totalPauses],
      ['Total Messages',  room.analytics.totalMessages],
      ['Total Speakers',  room.speakerQueue.length]
    ];

    let y = 136;
    infoRows.forEach(([k,v]) => {
      doc.font('Helvetica-Bold').text(`${k}:`, 50, y, {width:150});
      doc.font('Helvetica').text(String(v), 200, y);
      y += 16;
    });

    // ── Speaker Performance
    y += 12;
    doc.fontSize(11).font('Helvetica-Bold')
       .fillColor('#000').text('SPEAKER PERFORMANCE', 50, y);
    y += 18;

    const speakers = Object.values(room.analytics.speakerStats);
    if (speakers.length === 0) {
      doc.font('Helvetica').fontSize(10).fillColor('#999')
         .text('No speaker data recorded.', 50, y);
      y += 16;
    } else {
      // Table header
      doc.rect(50, y, 500, 18).fill('#ede9ff');
      doc.fillColor('#7c5cff').font('Helvetica-Bold').fontSize(9);
      doc.text('Speaker',     52, y+4);
      doc.text('Allocated',  210, y+4);
      doc.text('Used',       290, y+4);
      doc.text('Over Time',  370, y+4);
      doc.text('Status',     450, y+4);
      y += 20;

      speakers.forEach((spk, i) => {
        if (y > 700) { doc.addPage(); y = 50; }
        if (i % 2 === 0) {
          doc.rect(50, y-2, 500, 16).fill('#fafafa');
        }
        doc.fillColor('#333').font('Helvetica').fontSize(9);
        doc.text(spk.name,                          52, y);
        doc.text(formatTime(spk.timeLimit),        210, y);
        doc.text(formatTime(spk.usedTime),         290, y);
        doc.fillColor(spk.overTime > 0 ? '#ef4444' : '#10b981')
           .text(spk.overTime > 0
             ? `+${formatTime(spk.overTime)}` : 'On Time', 370, y);
        doc.fillColor('#333')
           .text(spk.overTime > 0 ? '⚠ Over' : '✓ OK', 450, y);
        y += 18;
      });
    }

    // ── Chat History
    y += 12;
    if (y > 680) { doc.addPage(); y = 50; }
    doc.fontSize(11).font('Helvetica-Bold')
       .fillColor('#000').text('CHAT HISTORY', 50, y);
    y += 16;

    const chats = room.chatHistory.filter(m => !m.deleted);
    if (chats.length === 0) {
      doc.font('Helvetica').fontSize(10).fillColor('#999')
         .text('No chat messages.', 50, y);
    } else {
      chats.slice(-50).forEach(msg => {
        if (y > 700) { doc.addPage(); y = 50; }
        const t = new Date(msg.timestamp).toLocaleTimeString();
        doc.fillColor('#7c5cff').font('Helvetica-Bold').fontSize(8)
           .text(`[${t}] ${msg.senderName}:`, 50, y, { width:150 });
        doc.fillColor('#333').font('Helvetica').fontSize(8)
           .text(msg.message, 205, y, { width:345 });
        y += 16;
      });
    }

    // ── Footer
    doc.fontSize(8).fillColor('#aaa')
       .text('Generated by ElitePace V2.0',
         50, 760, { align:'center', width:500 });

    doc.end();
  } catch (err) {
    console.error('PDF error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'PDF generation failed' });
    }
  }
});

// ── EXCEL REPORT ───────────────────────────────────────────────
app.get('/report/excel/:roomId', async (req, res) => {
  try {
    const room = rooms.get(
      (req.params.roomId || '').toUpperCase()
    );
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = 'ElitePace V2.0';
    wb.created = new Date();

    // ── Sheet 1: Summary
    const ws1 = wb.addWorksheet('Session Summary');
    ws1.columns = [
      { header: 'Field', key: 'field', width: 25 },
      { header: 'Value', key: 'value', width: 40 }
    ];
    ws1.getRow(1).font = { bold:true, color:{ argb:'7c5cff' } };

    const dur2 = room.analytics.sessionStartTime &&
      room.analytics.sessionEndTime
      ? formatDuration(room.analytics.sessionEndTime -
          room.analytics.sessionStartTime) : 'N/A';

    ws1.addRows([
      { field:'Room ID',         value: room.roomId },
      { field:'Start Time',      value: room.analytics.sessionStartTime
          ? new Date(room.analytics.sessionStartTime).toLocaleString()
          : 'N/A' },
      { field:'End Time',        value: room.analytics.sessionEndTime
          ? new Date(room.analytics.sessionEndTime).toLocaleString()
          : 'N/A' },
      { field:'Total Duration',  value: dur2 },
      { field:'Total Pauses',    value: room.analytics.totalPauses },
      { field:'Total Messages',  value: room.analytics.totalMessages },
      { field:'Total Speakers',  value: room.speakerQueue.length }
    ]);

    // ── Sheet 2: Speakers
    const ws2 = wb.addWorksheet('Speaker Performance');
    ws2.columns = [
      { header:'Speaker',        key:'name',      width:25 },
      { header:'Allocated Time', key:'allocated',  width:18 },
      { header:'Used Time',      key:'used',       width:15 },
      { header:'Over Time',      key:'overtime',   width:15 },
      { header:'Status',         key:'status',     width:12 }
    ];
    ws2.getRow(1).font = { bold:true };
    ws2.getRow(1).fill = {
      type:'pattern', pattern:'solid',
      fgColor:{ argb:'EDE9FF' }
    };

    Object.values(room.analytics.speakerStats).forEach(spk => {
      ws2.addRow({
        name:      spk.name,
        allocated: formatTime(spk.timeLimit),
        used:      formatTime(spk.usedTime),
        overtime:  spk.overTime > 0
          ? `+${formatTime(spk.overTime)}` : 'On Time',
        status:    spk.overTime > 0 ? 'Over' : 'OK'
      });
    });

    // ── Sheet 3: Chat
    const ws3 = wb.addWorksheet('Chat History');
    ws3.columns = [
      { header:'Time',    key:'time',    width:22 },
      { header:'Sender',  key:'sender',  width:20 },
      { header:'Role',    key:'role',    width:12 },
      { header:'Message', key:'message', width:60 },
      { header:'Private', key:'priv',    width:10 }
    ];
    ws3.getRow(1).font = { bold:true };

    room.chatHistory
      .filter(m => !m.deleted)
      .forEach(msg => {
        ws3.addRow({
          time:    new Date(msg.timestamp).toLocaleString(),
          sender:  msg.senderName,
          role:    msg.senderRole,
          message: msg.message,
          priv:    msg.isPrivate ? 'Yes' : 'No'
        });
      });

    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename=ElitePace-${room.roomId}.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Excel error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Excel generation failed' });
    }
  }
});

// ── SPA FALLBACK ───────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START SERVER ───────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 ElitePace V2.0 running on port ${PORT}`);
  console.log(`🌐 http://localhost:${PORT}`);
});
