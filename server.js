'use strict';

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');

const app = express();
const server = http.createServer(app);

// ── SOCKET.IO ────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── DATA STORES ──────────────────────────────────────────────
const rooms    = new Map();
const problems = [];
const feedbacks = [];
const errorLogs = [];

// ── HELPERS ──────────────────────────────────────────────────
function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

function isManager(socket, room) {
  if (!room || !socket) return false;
  return room.managers.has(socket.id) ||
    room.clients.get(socket.id)?.role === 'manager';
}

function formatDuration(ms) {
  if (!ms || isNaN(ms)) return '0s';
  const totalSecs = Math.max(0, Math.floor(ms / 1000));
  const hrs  = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  if (hrs > 0)  return `${hrs}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

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

// ── ROOM FACTORY ─────────────────────────────────────────────
function createRoom(roomId, managerId) {
  return {
    roomId,
    createdAt:   Date.now(),
    status:      'waiting',
    managers:    new Set([managerId]),
    speakerQueue:[],
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
    clients: new Map()
  };
}

function createSpeaker(name, timeLimit, order) {
  return {
    id:        uuidv4(),
    name:      name || `Speaker ${order}`,
    timeLimit: timeLimit || 600,
    usedTime:  0,
    overTime:  0,
    status:    'waiting',
    joinedAt:  null,
    startedAt: null,
    endedAt:   null,
    socketId:  null
  };
}

// ── TIMER ENGINE ─────────────────────────────────────────────
const timerIntervals = new Map();

function startServerTimer(roomId) {
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
          if (spk.usedTime > spk.timeLimit) {
            spk.overTime = spk.usedTime - spk.timeLimit;
          }
          if (!r.analytics.speakerStats[spk.id]) {
            r.analytics.speakerStats[spk.id] = {
              name:      spk.name,
              timeLimit: spk.timeLimit,
              usedTime:  0,
              overTime:  0
            };
          }
          r.analytics.speakerStats[spk.id].usedTime = spk.usedTime;
          r.analytics.speakerStats[spk.id].overTime = spk.overTime;
        }
      }

      // Broadcast tick
      io.to(roomId).emit('timer:tick', {
        remainingSeconds:    r.timer.remainingSeconds,
        isRunning:           r.timer.isRunning,
        activeSpeakerIndex:  r.activeSpeakerIndex,
        speakerQueue:        r.speakerQueue
      });

      // 2-minute warning
      if (r.timer.remainingSeconds === 120) {
        io.to(roomId).emit('timer:warning', {
          message: 'Two minutes remaining!'
        });
      }

      // 30-second warning
      if (r.timer.remainingSeconds === 30) {
        io.to(roomId).emit('timer:critical', {
          message: 'Thirty seconds remaining!'
        });
      }

      // Timer ended
      if (r.timer.remainingSeconds <= 0) {
        r.timer.isRunning = false;
        clearInterval(interval);
        timerIntervals.delete(roomId);
        io.to(roomId).emit('timer:ended', { roomId });

        // Alert next speaker
        const nextIdx = r.activeSpeakerIndex + 1;
        if (nextIdx < r.speakerQueue.length) {
          const nextSpk = r.speakerQueue[nextIdx];
          if (nextSpk) {
            nextSpk.status = 'next';
            io.to(roomId).emit('speaker:getReady', {
              speaker: nextSpk,
              nextIndex: nextIdx,
              message: "Get Ready! You're up next!"
            });
          }
        }
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

// ── SOCKET EVENTS ────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`✅ Connected: ${socket.id}`);

  // CREATE ROOM
  socket.on('room:create', ({ name } = {}) => {
    try {
      const roomId = generateRoomId();
      const room   = createRoom(roomId, socket.id);
      room.clients.set(socket.id, {
        role:     'manager',
        name:     name || 'Manager',
        socketId: socket.id
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
      console.log(`🏠 Room created: ${roomId}`);
    } catch (err) {
      console.error('room:create error:', err);
      socket.emit('error', { message: 'Failed to create room' });
    }
  });

  // JOIN ROOM
  socket.on('room:join', ({ roomId, role, name } = {}) => {
    try {
      if (!roomId) {
        socket.emit('error', { message: 'Room ID required' });
        return;
      }
      const rid  = roomId.toUpperCase().trim();
      const room = rooms.get(rid);

      if (!room) {
        socket.emit('error', { message: 'Room not found. Check Room ID.' });
        return;
      }
      if (room.status === 'ended') {
        socket.emit('error', { message: 'This session has ended.' });
        return;
      }

      socket.join(rid);
      socket.data.roomId = rid;
      socket.data.role   = role;
      socket.data.name   = name;

      const clientRole = (role === 'cohost')
        ? 'cohost'
        : (role === 'manager' ? 'manager' : 'speaker');

      room.clients.set(socket.id, {
        role:     clientRole,
        name:     name || 'Guest',
        socketId: socket.id
      });

      if (role === 'cohost') {
        room.managers.add(socket.id);
      }

      // Update speaker socket if matched by name
      if (role === 'speaker' && name) {
        const spk = room.speakerQueue.find(s => s.name === name);
        if (spk) {
          spk.socketId = socket.id;
          spk.joinedAt = Date.now();
          if (spk.status === 'waiting') spk.status = 'ready';
        }
      }

      socket.emit('room:joined', {
        roomId:   rid,
        role:     clientRole,
        room:     serializeRoom(room)
      });

      io.to(rid).emit('room:update', {
        room:  serializeRoom(room),
        event: `${name || 'Someone'} joined`
      });

      console.log(`👤 ${name} joined ${rid} as ${clientRole}`);
    } catch (err) {
      console.error('room:join error:', err);
      socket.emit('error', { message: 'Failed to join room' });
    }
  });

  // TIMER: SET
  socket.on('timer:set', ({ roomId, totalSeconds } = {}) => {
    try {
      const room = rooms.get(roomId);
      if (!room || !isManager(socket, room)) return;
      const secs = parseInt(totalSeconds, 10);
      if (isNaN(secs) || secs < 1 || secs > 10800) {
        socket.emit('error', { message: 'Invalid timer value' });
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

  // TIMER: START
  socket.on('timer:start', ({ roomId } = {}) => {
    try {
      const room = rooms.get(roomId);
      if (!room || !isManager(socket, room)) return;
      if (room.timer.remainingSeconds <= 0) {
        socket.emit('error', { message: 'Please reset timer first' });
        return;
      }
      if (!room.analytics.sessionStartTime) {
        room.analytics.sessionStartTime = Date.now();
      }
      // Set first speaker active
      if (room.activeSpeakerIndex === -1 &&
          room.speakerQueue.length > 0) {
        room.activeSpeakerIndex        = 0;
        room.speakerQueue[0].status    = 'active';
        room.speakerQueue[0].startedAt = Date.now();
        // Alert next speaker
        if (room.speakerQueue[1]) {
          room.speakerQueue[1].status = 'next';
        }
      }
      startServerTimer(roomId);
      io.to(roomId).emit('timer:started', {
        timer:               room.timer,
        activeSpeakerIndex:  room.activeSpeakerIndex,
        speakerQueue:        room.speakerQueue
      });
    } catch (err) {
      console.error('timer:start error:', err);
    }
  });

  // TIMER: PAUSE
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

  // TIMER: RESET
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

  // TIMER: ADJUST
  socket.on('timer:adjust', ({ roomId, seconds } = {}) => {
    try {
      const room = rooms.get(roomId);
      if (!room || !isManager(socket, room)) return;
      const adj = parseInt(seconds, 10);
      if (isNaN(adj)) return;
      room.timer.remainingSeconds = Math.max(
        0,
        Math.min(room.timer.totalSeconds,
          room.timer.remainingSeconds + adj)
      );
      io.to(roomId).emit('timer:adjusted', {
        remainingSeconds: room.timer.remainingSeconds
      });
    } catch (err) {
      console.error('timer:adjust error:', err);
    }
  });

  // SPEAKER: ADD
  socket.on('speaker:add', ({ roomId, name, timeLimit } = {}) => {
    try {
      const room = rooms.get(roomId);
      if (!room || !isManager(socket, room)) return;
      if (!name || !name.trim()) {
        socket.emit('error', { message: 'Speaker name required' });
        return;
      }
      const order   = room.speakerQueue.length + 
