/* ============================================================
   ELITEPACE V2.0 — Complete Client Script
   Zero Errors | Production Ready | Premium Quality
   ============================================================ */

'use strict';

// ── CONSTANTS ─────────────────────────────────────────────────
const WARN_SECS    = 120; // 2 minutes warning
const CRIT_SECS    = 30;  // 30 seconds critical
const TOAST_MS     = 3500;
const LOAD_MS      = 2200;

const RATING_LABELS = {
  1: '😞 Poor experience',
  2: '😐 Below average',
  3: '😊 Good experience',
  4: '😃 Great experience!',
  5: '🤩 Absolutely loved it!'
};

const TOAST_ICONS = {
  ok:   '✅',
  err:  '❌',
  info: 'ℹ️',
  warn: '⚠️'
};

const LOAD_MESSAGES = [
  'Initializing ElitePace...',
  'Connecting to server...',
  'Loading real-time engine...',
  'Almost ready...',
  'Welcome to ElitePace! ⚡'
];

// ── APP STATE ──────────────────────────────────────────────────
const S = {
  socket:       null,
  roomId:       null,
  role:         null,
  name:         null,
  isConnected:  false,
  currentView:  'homeView',

  timer: {
    remaining: 0,
    total:     900,
    running:   false
  },

  speakerQueue: [],
  activeIdx:    -1,
  chatCount:    0,

  audioEnabled: false,
  wakeLock:     null,
  theme:        localStorage.getItem('ep_theme') || 'dark',

  // Offline queue
  offlineQueue: [],

  // Speaker local timer
  spkInterval:  null,
  spkRemaining: 0,
  spkTotal:     900,

  // Feedback state
  feedback: {
    rating:          0,
    selectedTags:    [],
    wouldRecommend:  null
  },

  // Problem state
  problem: {
    severity:        null,
    problemType:     null,
    subProblems:     [],
    whenItHappened:  null,
    fixedItself:     null,
    deviceInfo:      {}
  }
};

// ── DOM CACHE ──────────────────────────────────────────────────
const D = {};

function cacheDOM() {
  const ids = [
    // App
    'loadingScreen','connMsg','loadStatusText','app',
    // Views
    'homeView','managerView','speakerView',
    'endedView','speakerFeedbackView',
    'problemView','thankYouView',
    // Home
    'serverStatus','themeBtn','createBtn','joinBtn',
    'joinModal','closeJoin','joinRoomInput',
    'joinNameInput','joinAsSpeaker','joinAsCoHost',
    'proLink',
    // Manager Navbar
    'mgrBrandHome','mgrRoomId','copyRoomId',
    'mgrConnDot','reportPdfBtn','reportXlsBtn',
    'endSessionBtn',
    // Timer
    'tmMin','tmSec','setTimerBtn',
    'mgrTimer','mgrTimerLabel',
    'startBtn','pauseBtn','resetBtn',
    // Share
    'qrBox','speakerUrl','copyUrlBtn',
    'waBtn','emailBtn','addCoHostBtn',
    // Analytics
    'sSpeakers','sMsgs','sPauses','sClients',
    // Speaker Queue
    'speakerQueue','emptyQueue',
    'addSpeakerBtn','addSpeakerBtn2',
    'addSpeakerModal','closeAddSpeaker',
    'spkName','spkMin','spkSec',
    'confirmAddSpeaker',
    // Stealth Message
    'stealthMsg','stealthCount',
    'clearStealthBtn','sendStealthBtn','aiBtn',
    // Chat
    'chatMessages','chatInput',
    'sendChatBtn','chatCount',
    // Preview
    'speakerPreviewBox','previewTimer','previewMsg',
    // End Modal
    'endModal','closeEnd','endFeedback',
    'cancelEnd','confirmEnd',
    // Speaker View
    'speakerWrap','spkConnStatus','spkRoomBadge',
    'audioToggle','audioIcon',
    'getReadyAlert','spkWaiting',
    'spkTimerWrap','spkTimer','spkNameLabel',
    'spkProgFill','spkMsgArea','spkMsg',
    'spkChatMessages','spkChatInput','spkSendChat',
    'timeUpOverlay',
    // Ended View
    'dlPdfBtn','dlXlsBtn',
    'giveFeedbackBtn','reportProblemBtn',
    // Feedback View
    'backFromFeedback','starRating','ratingLabel',
    'tagGrid','fbMessage','fbCharCount',
    'recYes','recNo','submitFb','skipFb',
    // Problem View
    'backFromProblem','probTypes',
    'probDesc','probCharCount',
    'detDevice','detBrowser','detNetwork','detScreen',
    'submitProblem','skipProblem',
    // Thank You
    'shareTyWa',
    // Offline Banner
    'offlineBanner',
    // Toast
    'toastBox'
  ];

  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) D[id] = el;
  });
}

// ── UTILITY FUNCTIONS ──────────────────────────────────────────

/** Format seconds to MM:SS */
function fmtTime(secs) {
  if (typeof secs !== 'number' || isNaN(secs)) return '00:00';
  const s = Math.max(0, Math.floor(secs));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Escape HTML to prevent XSS */
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Show toast notification */
function showToast(msg, type = 'info') {
  if (!D.toastBox || !msg) return;

  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `
    <span class="ti">${TOAST_ICONS[type] || 'ℹ️'}</span>
    <span>${esc(String(msg))}</span>
  `;
  D.toastBox.appendChild(t);

  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => {
      if (t.parentNode) t.parentNode.removeChild(t);
    }, 350);
  }, TOAST_MS);
}

/** Show a view, hide all others */
function showView(viewId) {
  const views = [
    'homeView','managerView','speakerView',
    'endedView','speakerFeedbackView',
    'problemView','thankYouView'
  ];
  views.forEach(v => {
    if (D[v]) D[v].classList.add('hidden');
  });
  if (D[viewId]) {
    D[viewId].classList.remove('hidden');
    S.currentView = viewId;
  }
}

/** Update browser URL without reload */
function updateURL(roomId, role) {
  const base = window.location.pathname;
  window.history.pushState(
    { roomId, role },
    '',
    `${base}?room=${roomId}&role=${role}`
  );
}

/** Get speaker URL */
function getSpeakerUrl(roomId) {
  return `${window.location.origin}${window.location.pathname}?room=${roomId}&role=speaker`;
}

/** Get manager URL */
function getManagerUrl(roomId) {
  return `${window.location.origin}${window.location.pathname}?room=${roomId}&role=manager`;
}

/** Go to Home */
function goHome() {
  try {
    stopSpkTimer();
    releaseWakeLock();
    S.roomId = null;
    S.role   = null;
    S.timer  = { remaining: 0, total: 900, running: false };
    S.speakerQueue = [];
    S.activeIdx    = -1;
    S.chatCount    = 0;
    window.history.pushState({}, '', window.location.pathname);
    showView('homeView');
  } catch (err) {
    console.warn('goHome error:', err);
  }
}

// Make goHome global (called from HTML onclick)
window.goHome = goHome;

// ── SOCKET.IO CONNECTION ───────────────────────────────────────
function connectSocket() {
  try {
    S.socket = io(window.location.origin, {
      transports:           ['websocket', 'polling'],
      reconnection:         true,
      reconnectionDelay:    1000,
      reconnectionAttempts: Infinity,
      timeout:              20000
    });

    // ── Connected
    S.socket.on('connect', () => {
      S.isConnected = true;
      setServerStatus(true);
      updateConnDot('on');

      if (D.loadStatusText) {
        D.loadStatusText.textContent = 'Connected! ✅';
      }

      // Flush offline queue
      flushOfflineQueue();

      // Re-join if was in a room
      if (S.roomId && S.role && S.name) {
        S.socket.emit('room:join', {
          roomId: S.roomId,
          role:   S.role,
          name:   S.name
        });
      }
    });

    // ── Disconnected
    S.socket.on('disconnect', (reason) => {
      S.isConnected = false;
      setServerStatus(false);
      updateConnDot('off');
      setSpkStatus('disconnected');
      if (reason !== 'io client disconnect') {
        showToast('Connection lost — reconnecting...', 'warn');
      }
    });

    // ── Connect Error
    S.socket.on('connect_error', () => {
      if (D.loadStatusText) {
        D.loadStatusText.textContent = 'Retrying connection...';
      }
    });

    // ── Reconnected
    S.socket.io.on('reconnect', () => {
      setServerStatus(true);
      updateConnDot('on');
      showToast('Reconnected! ✅', 'ok');
    });

    // ── ROOM EVENTS ─────────────────────────────────────────
    S.socket.on('room:created', ({ roomId, role, room }) => {
      S.roomId = roomId;
      S.role   = 'manager';
      updateURL(roomId, 'manager');
      initManagerView(roomId, room);
    });

    S.socket.on('room:joined', ({ roomId, role, room }) => {
      S.roomId = roomId;
      S.role   = role;
      if (role === 'manager' || role === 'cohost') {
        updateURL(roomId, 'manager');
        initManagerView(roomId, room);
      } else {
        updateURL(roomId, 'speaker');
        initSpeakerFromRoom(room);
      }
    });

    S.socket.on('room:update', ({ room, event }) => {
      if (event) showToast(event, 'info');
      if (S.role === 'manager' || S.role === 'cohost') {
        updateMgrRoomData(room);
      }
    });

    S.socket.on('room:ended', () => {
      stopSpkTimer();
      releaseWakeLock();
      if (S.role === 'speaker') {
        setTimeout(() => showView('speakerFeedbackView'), 1200);
      } else {
        showView('endedView');
      }
    });

    S.socket.on('room:clientLeft', ({ clientCount }) => {
      if (D.sClients) D.sClients.textContent = clientCount || 0;
    });

    // ── TIMER EVENTS ─────────────────────────────────────────
    S.socket.on('timer:tick', ({
      remainingSeconds, isRunning,
      activeSpeakerIndex, speakerQueue
    }) => {
      S.timer.remaining = remainingSeconds;
      S.timer.running   = isRunning;
      S.activeIdx       = activeSpeakerIndex;
      S.speakerQueue    = speakerQueue || [];

      if (S.role === 'manager' || S.role === 'cohost') {
        updateMgrTimer(remainingSeconds);
        updateSpeakerQueueUI();
        updatePreview(remainingSeconds);
      } else {
        syncSpkTimer(remainingSeconds, S.timer.total);
      }
    });

    S.socket.on('timer:started', ({ timer, activeSpeakerIndex }) => {
      S.timer.remaining = timer.remainingSeconds;
      S.timer.total     = timer.totalSeconds;
      S.timer.running   = true;
      S.activeIdx       = activeSpeakerIndex;

      if (D.startBtn) D.startBtn.disabled = true;
      if (D.pauseBtn) D.pauseBtn.disabled = false;
      if (D.mgrTimerLabel) D.mgrTimerLabel.textContent = 'Running';
      showToast('Timer started! ▶', 'ok');
    });

    S.socket.on('timer:paused', ({ timer }) => {
      S.timer.running = false;
      if (D.startBtn) D.startBtn.disabled = false;
      if (D.pauseBtn) D.pauseBtn.disabled = true;
      if (D.mgrTimerLabel) D.mgrTimerLabel.textContent = 'Paused';
      showToast('Timer paused ⏸', 'info');
    });

    S.socket.on('timer:reset', ({ timer }) => {
      S.timer.remaining = timer.totalSeconds;
      S.timer.running   = false;
      updateMgrTimer(timer.totalSeconds);
      if (D.startBtn) D.startBtn.disabled = false;
      if (D.pauseBtn) D.pauseBtn.disabled = true;
      if (D.mgrTimerLabel) D.mgrTimerLabel.textContent = 'Ready to Start';
      updatePreview(timer.totalSeconds);
      showToast('Timer reset 🔄', 'info');
    });

    S.socket.on('timer:set', ({ timer }) => {
      S.timer.remaining = timer.remainingSeconds;
      S.timer.total     = timer.totalSeconds;
      S.timer.running   = false;
      updateMgrTimer(timer.remainingSeconds);
      updatePreview(timer.remainingSeconds);
      if (D.mgrTimerLabel) D.mgrTimerLabel.textContent = 'Timer set';
      showToast(`Timer set to ${fmtTime(timer.totalSeconds)} ✅`, 'ok');
    });

    S.socket.on('timer:adjusted', ({ remainingSeconds }) => {
      S.timer.remaining = remainingSeconds;
      updateMgrTimer(remainingSeconds);
      updatePreview(remainingSeconds);
    });

    S.socket.on('timer:ended', () => {
      S.timer.running = false;
      if (D.mgrTimerLabel) D.mgrTimerLabel.textContent = "Time's Up! ⏰";
      if (D.startBtn) D.startBtn.disabled = true;
      if (D.pauseBtn) D.pauseBtn.disabled = true;
      showToast("⏰ Time's up!", 'warn');
      speakText("Time is up! Please wrap up your presentation.");
    });

    S.socket.on('timer:warning', ({ message }) => {
      showToast(`⚡ ${message}`, 'warn');
      speakText('Two minutes remaining.');
    });

    S.socket.on('timer:critical', ({ message }) => {
      showToast(`🔴 ${message}`, 'err');
      speakText('Thirty seconds remaining.');
    });

    // ── SPEAKER EVENTS ────────────────────────────────────────
    S.socket.on('speaker:added', ({ queue }) => {
      S.speakerQueue = queue || [];
      updateSpeakerQueueUI();
      if (D.sSpeakers) D.sSpeakers.textContent = S.speakerQueue.length;
      showToast('Speaker added! 🎤', 'ok');
    });

    S.socket.on('speaker:removed', ({ queue }) => {
      S.speakerQueue = queue || [];
      updateSpeakerQueueUI();
      showToast('Speaker removed', 'info');
    });

    S.socket.on('speaker:activated', ({
      activeIndex, queue, timer
    }) => {
      S.activeIdx    = activeIndex;
      S.speakerQueue = queue || [];
      S.timer.total     = timer.totalSeconds;
      S.timer.remaining = timer.remainingSeconds;
      S.timer.running   = false;

      updateSpeakerQueueUI();
      updateMgrTimer(timer.remainingSeconds);
      updatePreview(timer.remainingSeconds);

      if (D.startBtn) D.startBtn.disabled = false;
      if (D.pauseBtn) D.pauseBtn.disabled = true;
      if (D.mgrTimerLabel) D.mgrTimerLabel.textContent = 'Ready to Start';

      const spk = queue[activeIndex];
      if (spk) {
        showToast(`${esc(spk.name)} is now active 🎤`, 'ok');
      }
    });

    S.socket.on('speaker:getReady', ({ message, speaker }) => {
      if (S.role === 'speaker') {
        showGetReadyAlert();
        speakText(message || "Get ready! You are up next!");
      }
    });

    // ── MESSAGE EVENT ─────────────────────────────────────────
    S.socket.on('message:received', ({ message }) => {
      if (S.role === 'speaker' && D.spkMsg) {
        if (message) {
          D.spkMsg.textContent = message;
          D.spkMsg.style.display = 'inline-block';
          D.spkMsg.style.animation = 'none';
          void D.spkMsg.offsetWidth;
          D.spkMsg.style.animation = 'slideUp 0.4s ease';
          speakText(message);
        } else {
          D.spkMsg.textContent = '';
          D.spkMsg.style.display = 'none';
        }
      }
    });

    // ── CHAT EVENTS ───────────────────────────────────────────
    S.socket.on('chat:message', (msg) => {
      appendChatMsg(msg);
      appendSpkChatMsg(msg);
      S.chatCount++;
      if (D.chatCount) D.chatCount.textContent = S.chatCount;
    });

    S.socket.on('chat:deleted', ({ messageId }) => {
      const el = document.querySelector(
        `[data-msgid="${CSS.escape(messageId)}"]`
      );
      if (el) {
        el.classList.add('deleted');
        const body = el.querySelector('.msg-body');
        if (body) body.textContent = '[Deleted by manager]';
      }
    });

    // ── COHOST LINK ───────────────────────────────────────────
    S.socket.on('cohost:link', ({ link, name }) => {
      navigator.clipboard.writeText(link)
        .then(() => {
          showToast(`Co-Host link copied for ${name}! 🔗`, 'ok');
        })
        .catch(() => {
          showToast(`Co-Host link: ${link}`, 'info');
        });
    });

    // ── SERVER ERROR ──────────────────────────────────────────
    S.socket.on('error', ({ message }) => {
      showToast(message || 'An error occurred', 'err');
    });

  } catch (err) {
    console.error('Socket connect error:', err);
    showToast('Failed to connect to server', 'err');
  }
}

// ── EMIT WITH OFFLINE QUEUE ────────────────────────────────────
function emit(event, data) {
  if (S.isConnected && S.socket) {
    S.socket.emit(event, data);
  } else {
    S.offlineQueue.push({ event, data });
    showToast('Offline — action queued', 'warn');
  }
}

function flushOfflineQueue() {
  while (S.offlineQueue.length > 0) {
    const { event, data } = S.offlineQueue.shift();
    if (S.socket) S.socket.emit(event, data);
  }
}

// ── STATUS HELPERS ─────────────────────────────────────────────
function setServerStatus(connected) {
  if (!D.serverStatus) return;
  const dot  = D.serverStatus.querySelector('.status-dot');
  const text = D.serverStatus.querySelector('.status-text');
  if (dot)  dot.className  = `status-dot ${connected ? 'live' : 'err'}`;
  if (text) text.textContent = connected ? 'Live' : 'Offline';
}

function updateConnDot(state) {
  if (D.mgrConnDot) {
    D.mgrConnDot.className = `conn-indicator ${state}`;
  }
}

function setSpkStatus(state) {
  if (!D.spkConnStatus) return;
  const map = {
    connecting:   { t: 'Connecting...', c: '' },
    connected:    { t: 'Live ●',        c: 'on' },
    disconnected: { t: 'Reconnecting...', c: 're' },
    ended:        { t: 'Session Ended', c: 'off' }
  };
  const s = map[state] || map.connecting;
  D.spkConnStatus.innerHTML =
    `<i class="fas fa-circle"></i> ${s.t}`;
  D.spkConnStatus.className = `spk-conn ${s.c}`;
}

// ── MANAGER VIEW ───────────────────────────────────────────────
function initManagerView(roomId, room) {
  showView('managerView');

  if (D.mgrRoomId) D.mgrRoomId.textContent = roomId;

  const spkUrl = getSpeakerUrl(roomId);
  if (D.speakerUrl) D.speakerUrl.textContent = spkUrl;

  generateQR(roomId);
  updateConnDot('on');
  requestWakeLock();

  if (room) updateMgrRoomData(room);
  showToast(`Room ${roomId} ready! 🎉`, 'ok');
}

function updateMgrRoomData(room) {
  if (!room) return;

  S.timer.remaining = room.timer?.remainingSeconds ?? 0;
  S.timer.total     = room.timer?.totalSeconds ?? 900;
  S.timer.running   = room.timer?.isRunning ?? false;
  S.speakerQueue    = room.speakerQueue || [];
  S.activeIdx       = room.activeSpeakerIndex ?? -1;

  updateMgrTimer(S.timer.remaining);
  updateSpeakerQueueUI();
  updatePreview(S.timer.remaining);

  if (D.sClients) D.sClients.textContent = room.clientCount || 0;
  if (D.sMsgs)    D.sMsgs.textContent    = room.analytics?.totalMessages || 0;
  if (D.sPauses)  D.sPauses.textContent  = room.analytics?.totalPauses   || 0;
  if (D.sSpeakers) D.sSpeakers.textContent = S.speakerQueue.length;

  // Load chat history
  if (Array.isArray(room.chatHistory)) {
    room.chatHistory.slice(-30).forEach(msg => appendChatMsg(msg));
  }
}

// ── MANAGER TIMER UI ───────────────────────────────────────────
function updateMgrTimer(remaining) {
  if (!D.mgrTimer) return;
  D.mgrTimer.textContent = fmtTime(remaining);
  D.mgrTimer.className = 'timer-display';
  if (remaining <= 0)        D.mgrTimer.classList.add('crit');
  else if (remaining <= WARN_SECS) D.mgrTimer.classList.add('warn');
}

function updatePreview(remaining) {
  if (!D.previewTimer || !D.speakerPreviewBox) return;

  D.previewTimer.textContent = fmtTime(remaining);

  if (remaining <= 0) {
    D.speakerPreviewBox.style.background = '#2c0000';
    D.previewTimer.style.color = '#ef4444';
  } else if (remaining <= WARN_SECS) {
    D.speakerPreviewBox.style.background = '#2c1e00';
    D.previewTimer.style.color = '#f59e0b';
  } else {
    D.speakerPreviewBox.style.background = '#000';
    D.previewTimer.style.color = '#fff';
  }
}

// ── SPEAKER QUEUE UI ───────────────────────────────────────────
function updateSpeakerQueueUI() {
  if (!D.speakerQueue) return;

  if (!S.speakerQueue || S.speakerQueue.length === 0) {
    D.speakerQueue.innerHTML = `
      <div class="empty-queue">
        <i class="fas fa-microphone-slash"></i>
        <p>No speakers added yet</p>
        <button class="btn-sm" onclick="openAddSpeaker()">
          Add First Speaker
        </button>
      </div>`;
    if (D.sSpeakers) D.sSpeakers.textContent = '0';
    return;
  }

  D.speakerQueue.innerHTML = S.speakerQueue.map((spk, idx) => {
    const isActive = idx === S.activeIdx;
    const isNext   = idx === S.activeIdx + 1;

    const itemCls  = isActive ? 'active'
                   : isNext   ? 'next-up'
                   : spk.status === 'done' ? 'done' : '';

    const badgeCls = isActive ? 'badge-active'
                   : isNext   ? 'badge-next'
                   : spk.status === 'done' ? 'badge-done'
                   : 'badge-waiting';

    const badgeTxt = isActive ? '🎤 Active'
                   : isNext   ? '⚡ Next'
                   : spk.status === 'done' ? '✓ Done'
                   : '⏳ Waiting';

    const overTxt = spk.overTime > 0
      ? `<span style="color:var(--red)"> · +${fmtTime(spk.overTime)} over</span>`
      : '';

    const actBtns = !isActive && spk.status !== 'done'
      ? `<button class="spk-act-btn"
           onclick="setActiveSpeaker(${idx})"
           title="Set Active">
           <i class="fas fa-play"></i>
         </button>`
      : '';

    return `
      <div class="spk-item ${itemCls}" data-idx="${idx}">
        <div class="spk-num">${idx + 1}</div>
        <div class="spk-info">
          <div class="spk-name">${esc(spk.name)}</div>
          <div class="spk-time-limit">
            ⏱ ${fmtTime(spk.timeLimit)}
            ${spk.usedTime > 0
              ? ` · Used: ${fmtTime(spk.usedTime)}` : ''}
            ${overTxt}
          </div>
        </div>
        <span class="spk-status-badge ${badgeCls}">
          ${badgeTxt}
        </span>
        <div class="spk-actions">
          ${actBtns}
          <button class="spk-act-btn del"
            onclick="removeSpeaker('${esc(spk.id)}')"
            title="Remove Speaker">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>`;
  }).join('');

  if (D.sSpeakers) {
    D.sSpeakers.textContent = S.speakerQueue.length;
  }
}

// Make these global (called from inline onclick)
window.setActiveSpeaker = function(index) {
  emit('speaker:setActive', { roomId: S.roomId, index });
};

window.removeSpeaker = function(speakerId) {
  emit('speaker:remove', { roomId: S.roomId, speakerId });
};

window.openAddSpeaker = function() {
  if (D.addSpeakerModal) {
    D.addSpeakerModal.classList.remove('hidden');
    setTimeout(() => D.spkName && D.spkName.focus(), 100);
  }
};

function confirmAddSpeaker() {
  try {
    const name = D.spkName?.value?.trim();
    const mins = parseInt(D.spkMin?.value || '10', 10);
    const secs = parseInt(D.spkSec?.value || '0',  10);

    if (!name) {
      showToast('Please enter speaker name', 'warn');
      D.spkName && shakeEl(D.spkName);
      return;
    }

    if (isNaN(mins) || mins < 1 || mins > 120) {
      showToast('Minutes must be 1–120', 'err');
      return;
    }

    const timeLimit = (mins * 60) + Math.max(0, Math.min(59, secs || 0));
    emit('speaker:add', { roomId: S.roomId, name, timeLimit });

    if (D.addSpeakerModal) D.addSpeakerModal.classList.add('hidden');
    if (D.spkName)  D.spkName.value  = '';
    if (D.spkMin)   D.spkMin.value   = '10';
    if (D.spkSec)   D.spkSec.value   = '0';

  } catch (err) {
    console.error('confirmAddSpeaker error:', err);
    showToast('Failed to add speaker', 'err');
  }
}

// ── SPEAKER VIEW ───────────────────────────────────────────────
function initSpeakerFromRoom(room) {
  showView('speakerView');
  requestWakeLock();

  if (D.spkRoomBadge) {
    D.spkRoomBadge.textContent = `Room: ${S.roomId}`;
  }

  setSpkStatus('connected');

  if (!room) return;

  S.timer.total     = room.timer?.totalSeconds     ?? 900;
  S.timer.remaining = room.timer?.remainingSeconds ?? 900;
  S.speakerQueue    = room.speakerQueue || [];
  S.activeIdx       = room.activeSpeakerIndex ?? -1;

  // Update speaker name label
  const spk = S.speakerQueue[S.activeIdx];
  if (spk && D.spkNameLabel) {
    D.spkNameLabel.textContent =
      `SPEAKING: ${spk.name.toUpperCase()}`;
  }

  if (room.timer?.isRunning) {
    showSpkTimer();
    syncSpkTimer(S.timer.remaining, S.timer.total);
  }

  // Load chat
  if (Array.isArray(room.chatHistory)) {
    room.chatHistory.slice(-15).forEach(msg => appendSpkChatMsg(msg));
  }
}

// ── SPEAKER TIMER ──────────────────────────────────────────────
function syncSpkTimer(remaining, total) {
  stopSpkTimer();
  S.spkRemaining = typeof remaining === 'number' ? remaining : 0;
  S.spkTotal     = typeof total     === 'number' ? total     : 900;

  updateSpkDisplay(S.spkRemaining, S.spkTotal);
  showSpkTimer();

  // Local countdown for smooth display
  S.spkInterval = setInterval(() => {
    if (S.spkRemaining <= 0) {
      S.spkRemaining = 0;
      updateSpkDisplay(0, S.spkTotal);
      stopSpkTimer();
      handleSpkTimeUp();
      return;
    }
    S.spkRemaining--;
    updateSpkDisplay(S.spkRemaining, S.spkTotal);
  }, 1000);
}

function stopSpkTimer() {
  if (S.spkInterval) {
    clearInterval(S.spkInterval);
    S.spkInterval = null;
  }
}

function updateSpkDisplay(remaining, total) {
  // Timer text
  if (D.spkTimer) {
    D.spkTimer.textContent = fmtTime(remaining);
  }

  // Progress bar
  if (D.spkProgFill && total > 0) {
    const pct = Math.max(0, Math.min(100, (remaining / total) * 100));
    D.spkProgFill.style.width = `${pct}%`;
  }

  // Color state
  if (!D.speakerWrap) return;
  if (remaining <= 0) {
    D.speakerWrap.className = 'speaker-wrap crit';
  } else if (remaining <= WARN_SECS) {
    D.speakerWrap.className = 'speaker-wrap warn';
  } else {
    D.speakerWrap.className = 'speaker-wrap';
  }
}

function showSpkTimer() {
  if (D.spkWaiting)    D.spkWaiting.style.display    = 'none';
  if (D.spkTimerWrap)  D.spkTimerWrap.style.display  = 'block';
  if (D.spkProgFill)   D.spkProgFill.closest('.spk-progress').style.display = 'block';
}

function handleSpkTimeUp() {
  if (D.timeUpOverlay) D.timeUpOverlay.classList.remove('hidden');
  if (D.speakerWrap)   D.speakerWrap.className = 'speaker-wrap crit';
  speakText('Time is up! Please wrap up your presentation.');
}

function showGetReadyAlert() {
  if (!D.getReadyAlert) return;
  D.getReadyAlert.classList.remove('hidden');
  setTimeout(() => {
    if (D.getReadyAlert) D.getReadyAlert.classList.add('hidden');
  }, 8000);
}

// ── CHAT ───────────────────────────────────────────────────────
function appendChatMsg(msg) {
  if (!D.chatMessages || !msg) return;

  // Remove empty state
  const empty = D.chatMessages.querySelector('.chat-empty');
  if (empty) empty.remove();

  const isManager = msg.senderRole === 'manager' ||
                    msg.senderRole === 'cohost';
  const time = new Date(msg.timestamp).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit'
  });

  const canDelete = S.role === 'manager' || S.role === 'cohost';
  const delBtn = canDelete
    ? `<button class="msg-del-btn"
         onclick="deleteChatMsg('${esc(msg.id)}')"
         title="Delete message">🗑</button>`
    : '';

  const el = document.createElement('div');
  el.className = `chat-msg ${isManager ? 'mgr' : 'spk'}${msg.deleted ? ' deleted' : ''}`;
  el.setAttribute('data-msgid', msg.id || '');
  el.innerHTML = `
    <div class="msg-sender">
      <span>${esc(msg.senderName)} · ${time}</span>
      ${delBtn}
    </div>
    <div class="msg-body">${esc(msg.message)}</div>
  `;

  D.chatMessages.appendChild(el);
  D.chatMessages.scrollTop = D.chatMessages.scrollHeight;
}

window.deleteChatMsg = function(messageId) {
  emit('chat:delete', { roomId: S.roomId, messageId });
};

function appendSpkChatMsg(msg) {
  if (!D.spkChatMessages || !msg) return;

  const el = document.createElement('div');
  el.className = `spk-chat-msg ${
    msg.senderRole === 'manager' || msg.senderRole === 'cohost'
      ? 'from-mgr' : ''
  }`;
  el.textContent = `${msg.senderName}: ${msg.message}`;
  D.spkChatMessages.appendChild(el);
  D.spkChatMessages.scrollTop = D.spkChatMessages.scrollHeight;
}

function sendManagerChat() {
  try {
    const msg = D.chatInput?.value?.trim();
    if (!msg) return;
    emit('chat:send', {
      roomId:    S.roomId,
      message:   msg,
      isPrivate: false
    });
    if (D.chatInput) D.chatInput.value = '';
  } catch (err) {
    console.warn('sendManagerChat error:', err);
  }
}

function sendSpeakerChat() {
  try {
    const msg = D.spkChatInput?.value?.trim();
    if (!msg) return;
    emit('chat:send', {
      roomId:    S.roomId,
      message:   msg,
      isPrivate: false
    });
    if (D.spkChatInput) D.spkChatInput.value = '';
  } catch (err) {
    console.warn('sendSpeakerChat error:', err);
  }
}

// ── QR CODE ────────────────────────────────────────────────────
function generateQR(roomId) {
  if (!D.qrBox) return;
  D.qrBox.innerHTML = '';

  const url = getSpeakerUrl(roomId);

  try {
    new QRCode(D.qrBox, {
      text:         url,
      width:        160,
      height:       160,
      colorDark:    '#000000',
      colorLight:   '#ffffff',
      correctLevel: QRCode.CorrectLevel.H
    });
  } catch (err) {
    D.qrBox.innerHTML =
      `<p style="color:var(--tm);font-size:.8rem;
        text-align:center;padding:1rem">
        Room: ${esc(roomId)}
      </p>`;
    console.warn('QR generation error:', err);
  }
}

// ── COPY URL ───────────────────────────────────────────────────
function copyUrl() {
  const url = D.speakerUrl?.textContent;
  if (!url || url === '--') {
    showToast('No URL to copy', 'warn');
    return;
  }

  navigator.clipboard.writeText(url)
    .then(() => showToast('Speaker link copied! 📋', 'ok'))
    .catch(() => {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity  = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        showToast('Link copied! 📋', 'ok');
      } catch (e) {
        showToast('Could not copy link', 'err');
      }
      document.body.removeChild(ta);
    });
}

function copyRoomId() {
  if (!S.roomId) return;
  navigator.clipboard.writeText(S.roomId)
    .then(() => showToast(`Room ID ${S.roomId} copied!`, 'ok'))
    .catch(() => {});
}

// ── REPORTS ────────────────────────────────────────────────────
function downloadPDF() {
  if (!S.roomId) {
    showToast('No active session', 'warn');
    return;
  }
  window.open(`/report/pdf/${S.roomId}`, '_blank');
}

function downloadExcel() {
  if (!S.roomId) {
    showToast('No active session', 'warn');
    return;
  }
  window.open(`/report/excel/${S.roomId}`, '_blank');
}

// ── TEXT TO SPEECH ─────────────────────────────────────────────
function speakText(text) {
  if (!S.audioEnabled || !text) return;
  if (!('speechSynthesis' in window)) return;

  try {
    window.speechSynthesis.cancel();
    const utt   = new SpeechSynthesisUtterance(text);
    utt.rate    = 0.9;
    utt.pitch   = 1;
    utt.volume  = 1;
    window.speechSynthesis.speak(utt);
  } catch (err) {
    console.warn('TTS error:', err);
  }
}

function toggleAudio() {
  S.audioEnabled = !S.audioEnabled;

  if (D.audioIcon) {
    D.audioIcon.className = S.audioEnabled
      ? 'fas fa-volume-up'
      : 'fas fa-volume-mute';
  }

  if (D.audioToggle) {
    D.audioToggle.style.background = S.audioEnabled
      ? 'var(--acc)' : '';
    D.audioToggle.style.color = S.audioEnabled ? '#fff' : '';
    D.audioToggle.style.borderColor = S.audioEnabled
      ? 'var(--acc)' : '';
  }

  if (S.audioEnabled) {
    speakText('Audio alerts are now enabled.');
  }

  showToast(
    S.audioEnabled ? 'Audio alerts ON 🔊' : 'Audio alerts OFF 🔇',
    'info'
  );
}

// ── WAKE LOCK ──────────────────────────────────────────────────
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      S.wakeLock = await navigator.wakeLock.request('screen');
      console.log('✅ Wake Lock active');
    }
  } catch (err) {
    console.warn('Wake Lock unavailable:', err.message);
  }
}

function releaseWakeLock() {
  if (S.wakeLock) {
    S.wakeLock.release().catch(() => {});
    S.wakeLock = null;
  }
}

document.addEventListener('visibilitychange', async () => {
  if (S.wakeLock !== null &&
      document.visibilityState === 'visible') {
    await requestWakeLock();
  }
});

// ── THEME ──────────────────────────────────────────────────────
function initTheme() {
  if (S.theme === 'light') {
    document.body.classList.add('light');
    if (D.themeBtn) D.themeBtn.textContent = '☀️';
  }
}

function toggleTheme() {
  document.body.classList.toggle('light');
  const isLight = document.body.classList.contains('light');
  S.theme = isLight ? 'light' : 'dark';
  localStorage.setItem('ep_theme', S.theme);
  if (D.themeBtn) D.themeBtn.textContent = isLight ? '☀️' : '🌙';
}

// ── OFFLINE DETECTION ──────────────────────────────────────────
function initOfflineDetection() {
  window.addEventListener('online', () => {
    if (D.offlineBanner) D.offlineBanner.classList.add('hidden');
    showToast('Back online! 🟢', 'ok');
    flushOfflineQueue();
  });

  window.addEventListener('offline', () => {
    if (D.offlineBanner) D.offlineBanner.classList.remove('hidden');
    showToast('You are offline', 'warn');
  });
}

// ── SHAKE ANIMATION ────────────────────────────────────────────
function shakeEl(el) {
  if (!el) return;
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = 'shake 0.4s ease';
}

// Add shake keyframe if not in CSS
const shakeStyle = document.createElement('style');
shakeStyle.textContent = `
  @keyframes shake {
    0%,100% { transform: translateX(0); }
    25%      { transform: translateX(-8px); }
    75%      { transform: translateX(8px); }
  }
`;
document.head.appendChild(shakeStyle);

// ── DEVICE DETECTION ───────────────────────────────────────────
function detectDevice() {
  const ua = navigator.userAgent;
  const info = {};

  // Device type
  if (/Android/i.test(ua))     info.device = 'Android';
  else if (/iPhone/i.test(ua)) info.device = 'iPhone';
  else if (/iPad/i.test(ua))   info.device = 'iPad';
  else if (/Windows/i.test(ua)) info.device = 'Windows PC';
  else if (/Mac/i.test(ua))    info.device = 'Mac';
  else                          info.device = 'Unknown';

  // Browser
  if (/Edg/i.test(ua))                       info.browser = 'Edge';
  else if (/Chrome/i.test(ua))               info.browser = 'Chrome';
  else if (/Firefox/i.test(ua))              info.browser = 'Firefox';
  else if (/Safari/i.test(ua))               info.browser = 'Safari';
  else                                        info.browser = 'Other';

  // Network
  const conn = navigator.connection || navigator.mozConnection;
  info.network = conn
    ? (conn.effectiveType || conn.type || 'Online')
    : (navigator.onLine ? 'Online' : 'Offline');

  // Screen
  info.screen = `${screen.width}×${screen.height}`;

  S.problem.deviceInfo = info;

  if (D.detDevice)  D.detDevice.textContent  = info.device;
  if (D.detBrowser) D.detBrowser.textContent = info.browser;
  if (D.detNetwork) D.detNetwork.textContent = info.network;
  if (D.detScreen)  D.detScreen.textContent  = info.screen;

  return info;
}

// ── FEEDBACK SYSTEM ────────────────────────────────────────────
function initFeedbackSystem() {
  // Star rating
  const stars = document.querySelectorAll('.star-btn');
  stars.forEach(star => {
    star.addEventListener('click', () => {
      const val = parseInt(star.getAttribute('data-val'), 10);
      S.feedback.rating = val;

      stars.forEach((s, i) => {
        const active = i < val;
        s.classList.toggle('active', active);
        s.style.filter = active ? 'grayscale(0%)' : 'grayscale(100%)';
      });

      if (D.ratingLabel) {
        D.ratingLabel.textContent = RATING_LABELS[val] || '';
      }
    });

    // Hover preview
    star.addEventListener('mouseenter', () => {
      const val = parseInt(star.getAttribute('data-val'), 10);
      stars.forEach((s, i) => {
        s.style.filter = i < val ? 'grayscale(0%)' : 'grayscale(100%)';
      });
    });

    star.addEventListener('mouseleave', () => {
      stars.forEach((s, i) => {
        s.style.filter = i < S.feedback.rating
          ? 'grayscale(0%)' : 'grayscale(100%)';
      });
    });
  });

  // Tags
  document.querySelectorAll('.tag-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tag = btn.getAttribute('data-tag');
      btn.classList.toggle('selected');
      if (S.feedback.selectedTags.includes(tag)) {
        S.feedback.selectedTags =
          S.feedback.selectedTags.filter(t => t !== tag);
      } else {
        S.feedback.selectedTags.push(tag);
      }
    });
  });

  // Would recommend
  D.recYes?.addEventListener('click', () => {
    S.feedback.wouldRecommend = true;
    D.recYes.classList.add('selected');
    D.recNo?.classList.remove('selected');
  });

  D.recNo?.addEventListener('click', () => {
    S.feedback.wouldRecommend = false;
    D.recNo.classList.add('selected');
    D.recYes?.classList.remove('selected');
  });

  // Char count
  D.fbMessage?.addEventListener('input', () => {
    const len = (D.fbMessage.value || '').length;
    if (D.fbCharCount) D.fbCharCount.textContent = len;
  });

  // Submit
  D.submitFb?.addEventListener('click', submitFeedback);

  // Skip
  D.skipFb?.addEventListener('click', () => {
    showView('thankYouView');
  });

  // Back
  D.backFromFeedback?.addEventListener('click', () => {
    showView('endedView');
  });
}

async function submitFeedback() {
  try {
    if (S.feedback.rating === 0) {
      showToast('Please give a star rating first! ⭐', 'warn');
      const sr = document.querySelector('.star-rating');
      if (sr) shakeEl(sr);
      return;
    }

    const btn = D.submitFb;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML =
        '<i class="fas fa-spinner fa-spin"></i> Submitting...';
    }

    const response = await fetch('/feedback', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId:         S.roomId || 'anonymous',
        role:           S.role   || 'unknown',
        name:           S.name   || 'Anonymous',
        rating:         S.feedback.rating,
        message:        D.fbMessage?.value?.trim() || '',
        tags:           S.feedback.selectedTags,
        wouldRecommend: S.feedback.wouldRecommend
      })
    });

    if (!response.ok) throw new Error('Server error');

    showToast('Feedback submitted! Thank you 🙏', 'ok');
    setTimeout(() => showView('thankYouView'), 1000);

  } catch (err) {
    console.error('submitFeedback error:', err);
    showToast('Failed to submit. Try again.', 'err');

    const btn = D.submitFb;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML =
        '<i class="fas fa-paper-plane"></i> Submit Feedback';
    }
  }
}

// ── PROBLEM REPORT SYSTEM ──────────────────────────────────────
function initProblemSystem() {
  detectDevice();

  // Severity
  document.querySelectorAll('.sev-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sev-btn')
        .forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      S.problem.severity = btn.getAttribute('data-sev');
    });
  });

  // Categories (accordion)
  document.querySelectorAll('.prob-category').forEach(cat => {
    const header = cat.querySelector('.prob-cat-header');
    if (!header) return;

    header.addEventListener('click', () => {
      const isOpen = cat.classList.contains('open');

      document.querySelectorAll('.prob-category')
        .forEach(c => {
          c.classList.remove('open');
          c.classList.remove('selected');
        });

      if (!isOpen) {
        cat.classList.add('open');
        cat.classList.add('selected');
        S.problem.problemType = cat.getAttribute('data-type');
      }
    });
  });

  // Sub-problem checkboxes
  document.querySelectorAll('.sub-check input').forEach(cb => {
    cb.addEventListener('change', () => {
      const sub = cb.getAttribute('data-sub');
      if (!sub) return;
      if (cb.checked) {
        if (!S.problem.subProblems.includes(sub)) {
          S.problem.subProblems.push(sub);
        }
      } else {
        S.problem.subProblems =
          S.problem.subProblems.filter(s => s !== sub);
      }
    });
  });

  // When buttons
  document.querySelectorAll('.when-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.when-btn')
        .forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      S.problem.whenItHappened = btn.getAttribute('data-when');
    });
  });

  // Fixed buttons
  document.querySelectorAll('.fixed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.fixed-btn')
        .forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      S.problem.fixedItself = btn.getAttribute('data-fixed');
    });
  });

  // Char count
  D.probDesc?.addEventListener('input', () => {
    const len = (D.probDesc.value || '').length;
    if (D.probCharCount) D.probCharCount.textContent = len;
  });

  // Submit
  D.submitProblem?.addEventListener('click', submitProblem);

  // Skip
  D.skipProblem?.addEventListener('click', () => {
    showView('thankYouView');
  });

  // Back
  D.backFromProblem?.addEventListener('click', () => {
    showView('endedView');
  });
}

async function submitProblem() {
  try {
    if (!S.problem.severity) {
      showToast('Problem कितनी serious है? Select करें', 'warn');
      const sg = document.querySelector('.severity-grid');
      if (sg) shakeEl(sg);
      return;
    }

    if (!S.problem.problemType &&
        S.problem.subProblems.length === 0) {
      showToast('Problem किस चीज़ में थी? Select करें', 'warn');
      return;
    }

    const btn = D.submitProblem;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML =
        '<i class="fas fa-spinner fa-spin"></i> Submitting...';
    }

    const response = await fetch('/report-problem', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId:          S.roomId || 'anonymous',
        role:            S.role   || 'unknown',
        name:            S.name   || 'Anonymous',
        device:          S.problem.deviceInfo.device,
        browser:         S.problem.deviceInfo.browser,
        network:         S.problem.deviceInfo.network,
        problemType:     S.problem.problemType || 'other',
        subProblems:     S.problem.subProblems,
        severity:        S.problem.severity,
        description:     D.probDesc?.value?.trim() || '',
        whenItHappened:  S.problem.whenItHappened,
        fixedItself:     S.problem.fixedItself === 'true',
        sessionDuration: S.timer.total || 0,
        timestamp:       Date.now()
      })
    });

    if (!response.ok) throw new Error('Server error');

    showToast('Problem report हो गई! जल्द fix करेंगे 🔧', 'ok');
    setTimeout(() => showView('thankYouView'), 1200);

  } catch (err) {
    console.error('submitProblem error:', err);
    showToast('Submit नहीं हुआ। फिर try करें।', 'err');

    const btn = D.submitProblem;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML =
        '<i class="fas fa-bug"></i> Submit Problem Report';
    }
  }
}

// ── AUTO ERROR LOGGER ──────────────────────────────────────────
function initErrorLogger() {
  window.addEventListener('error', (e) => {
    fetch('/log-error', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error:     e.message || 'Unknown error',
        stack:     e.error?.stack || '',
        roomId:    S.roomId,
        role:      S.role,
        userAgent: navigator.userAgent,
        url:       window.location.href,
        timestamp: Date.now()
      })
    }).catch(() => {});
  });

  window.addEventListener('unhandledrejection', (e) => {
    fetch('/log-error', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error:     e.reason?.message || String(e.reason) || 'Promise rejection',
        stack:     e.reason?.stack || '',
        roomId:    S.roomId,
        role:      S.role,
        userAgent: navigator.userAgent,
        url:       window.location.href,
        timestamp: Date.now()
      })
    }).catch(() => {});
  });
}

// ── URL ROUTING ────────────────────────────────────────────────
function handleRoute() {
  try {
    const params = new URLSearchParams(window.location.search);
    const roomId = params.get('room');
    const role   = params.get('role');
    const name   = params.get('name') ||
                   localStorage.getItem('ep_name') || 'Guest';

    if (roomId && role && S.socket) {
      S.name = name;
      const id = roomId.toUpperCase().trim();

      if (role === 'speaker' || role === 'cohost') {
        S.socket.emit('room:join', { roomId: id, role, name });
      } else if (role === 'manager') {
        S.roomId = id;
        S.role   = 'manager';
        // Wait for socket connection then re-join
      }
    } else {
      showView('homeView');
    }
  } catch (err) {
    console.warn('handleRoute error:', err);
    showView('homeView');
  }
}

// ── LOADING ANIMATION ──────────────────────────────────────────
function animateLoadingMessages() {
  let i = 0;
  const interval = setInterval(() => {
    if (!D.loadStatusText || i >= LOAD_MESSAGES.length) {
      clearInterval(interval);
      return;
    }
    D.loadStatusText.textContent = LOAD_MESSAGES[i];
    i++;
  }, LOAD_MS / LOAD_MESSAGES.length);
}

function hideLoadingScreen() {
  setTimeout(() => {
    if (!D.loadingScreen) return;
    D.loadingScreen.classList.add('out');
    setTimeout(() => {
      if (D.loadingScreen) D.loadingScreen.style.display = 'none';
      if (D.app) D.app.classList.remove('hidden');
      showView('homeView');
      handleRoute();
    }, 600);
  }, LOAD_MS);
}

// ── EVENT LISTENERS ────────────────────────────────────────────
function attachEvents() {

  // ── THEME ────────────────────────────────────────────────
  D.themeBtn?.addEventListener('click', toggleTheme);

  // ── HOME: CREATE SESSION ──────────────────────────────────
  D.createBtn?.addEventListener('click', () => {
    const name = prompt('Your name (Manager):')?.trim();
    if (!name) {
      showToast('Please enter your name', 'warn');
      return;
    }
    S.name = name;
    localStorage.setItem('ep_name', name);
    emit('room:create', { name });
  });

  // ── HOME: JOIN SESSION ────────────────────────────────────
  D.joinBtn?.addEventListener('click', () => {
    if (D.joinModal) D.joinModal.classList.remove('hidden');
    setTimeout(() => D.joinRoomInput?.focus(), 100);
  });

  D.closeJoin?.addEventListener('click', () => {
    if (D.joinModal) D.joinModal.classList.add('hidden');
  });

  D.joinModal?.addEventListener('click', (e) => {
    if (e.target === D.joinModal) {
      D.joinModal.classList.add('hidden');
    }
  });

  D.joinAsSpeaker?.addEventListener('click', () => joinRoom('speaker'));
  D.joinAsCoHost?.addEventListener('click',  () => joinRoom('cohost'));

  D.joinRoomInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinRoom('speaker');
    // Auto uppercase
    D.joinRoomInput.value =
      D.joinRoomInput.value.toUpperCase();
  });

  // Pro link teaser
  D.proLink?.addEventListener('click', () => {
    showToast('Pro version coming soon! 🚀', 'info');
  });

  // ── MANAGER: NAVBAR ───────────────────────────────────────
  D.mgrBrandHome?.addEventListener('click', () => {
    if (confirm('Go home? Session will continue for others.')) {
      goHome();
    }
  });

  D.copyRoomId?.addEventListener('click', copyRoomId);
  D.reportPdfBtn?.addEventListener('click', downloadPDF);
  D.reportXlsBtn?.addEventListener('click', downloadExcel);

  D.endSessionBtn?.addEventListener('click', () => {
    if (D.endModal) D.endModal.classList.remove('hidden');
  });

  // ── TIMER CONTROLS ────────────────────────────────────────
  D.setTimerBtn?.addEventListener('click', () => {
    const mins = parseInt(D.tmMin?.value || '15', 10);
    const secs = parseInt(D.tmSec?.value || '0',  10);

    if (isNaN(mins) || mins < 1 || mins > 180) {
      showToast('Minutes must be 1–180', 'err');
      D.tmMin && shakeEl(D.tmMin);
      return;
    }
    if (isNaN(secs) || secs < 0 || secs > 59) {
      showToast('Seconds must be 0–59', 'err');
      D.tmSec && shakeEl(D.tmSec);
      return;
    }

    emit('timer:set', {
      roomId: S.roomId,
      totalSeconds: (mins * 60) + secs
    });
  });

  D.startBtn?.addEventListener('click', () => {
    emit('timer:start', { roomId: S.roomId });
  });

  D.pauseBtn?.addEventListener('click', () => {
    emit('timer:pause', { roomId: S.roomId });
  });

  D.resetBtn?.addEventListener('click', () => {
    emit('timer:reset', { roomId: S.roomId });
  });

  // Timer input — Enter key
  [D.tmMin, D.tmSec].forEach(inp => {
    inp?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') D.setTimerBtn?.click();
    });
  });

  // Quick adjust buttons
  document.querySelectorAll('.adj').forEach(btn => {
    btn.addEventListener('click', () => {
      const adj = parseInt(btn.getAttribute('data-adj'), 10);
      if (!isNaN(adj)) {
        emit('timer:adjust', { roomId: S.roomId, seconds: adj });
      }
    });
  });

  // ── SHARE ─────────────────────────────────────────────────
  D.copyUrlBtn?.addEventListener('click', copyUrl);

  D.waBtn?.addEventListener('click', () => {
    if (!S.roomId) return;
    const url = getSpeakerUrl(S.roomId);
    const msg = encodeURIComponent(
      `Join ElitePace session!\nRoom: ${S.roomId}\nLink: ${url}`
    );
    window.open(`https://wa.me/?text=${msg}`, '_blank', 'noopener');
  });

  D.emailBtn?.addEventListener('click', () => {
    if (!S.roomId) return;
    const url  = getSpeakerUrl(S.roomId);
    const sub  = encodeURIComponent('Your ElitePace Speaker Link');
    const body = encodeURIComponent(
      `Join the session!\nRoom: ${S.roomId}\nLink: ${url}`
    );
    window.location.href = `mailto:?subject=${sub}&body=${body}`;
  });

  D.addCoHostBtn?.addEventListener('click', () => {
    const name = prompt('Co-Host Name:')?.trim();
    if (!name) return;
    emit('cohost:add', { roomId: S.roomId, name });
  });

  // ── SPEAKER QUEUE ─────────────────────────────────────────
  D.addSpeakerBtn?.addEventListener('click',  openAddSpeaker);
  D.addSpeakerBtn2?.addEventListener('click', openAddSpeaker);

  D.closeAddSpeaker?.addEventListener('click', () => {
    if (D.addSpeakerModal) D.addSpeakerModal.classList.add('hidden');
  });

  D.addSpeakerModal?.addEventListener('click', (e) => {
    if (e.target === D.addSpeakerModal) {
      D.addSpeakerModal.classList.add('hidden');
    }
  });

  D.confirmAddSpeaker?.addEventListener('click', confirmAddSpeaker);

  D.spkName?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmAddSpeaker();
  });

  // ── STEALTH MESSAGE ───────────────────────────────────────
  D.stealthMsg?.addEventListener('input', () => {
    const len = (D.stealthMsg.value || '').length;
    if (D.stealthCount) D.stealthCount.textContent = len;

    // Max length guard
    if (len > 200) {
      D.stealthMsg.value = D.stealthMsg.value.slice(0, 200);
      if (D.stealthCount) D.stealthCount.textContent = 200;
    }
  });

  D.sendStealthBtn?.addEventListener('click', () => {
    const msg = D.stealthMsg?.value?.trim();
    if (!msg) {
      showToast('Type a message first', 'warn');
      D.stealthMsg && shakeEl(D.stealthMsg);
      return;
    }
    emit('message:send', { roomId: S.roomId, message: msg });
    showToast('Message sent to speaker! ✉️', 'ok');

    // Update preview
    if (D.previewMsg) D.previewMsg.textContent = msg;
  });

  D.clearStealthBtn?.addEventListener('click', () => {
    if (D.stealthMsg)    D.stealthMsg.value = '';
    if (D.stealthCount)  D.stealthCount.textContent = '0';
    if (D.previewMsg)    D.previewMsg.textContent = '';
    emit('message:send', { roomId: S.roomId, message: '' });
    showToast('Message cleared', 'info');
  });

  // Quick message buttons
  document.querySelectorAll('.q-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const msg = btn.getAttribute('data-msg');
      if (msg && D.stealthMsg) {
        D.stealthMsg.value = msg;
        if (D.stealthCount) D.stealthCount.textContent = msg.length;
        D.stealthMsg.focus();
      }
    });
  });

  // AI teaser
  D.aiBtn?.addEventListener('click', () => {
    showToast('AI Tone Polish coming in Pro! ✨🚀', 'info');
  });

  // ── CHAT ──────────────────────────────────────────────────
  D.sendChatBtn?.addEventListener('click', sendManagerChat);

  D.chatInput?.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      sendManagerChat();
    }
  });

  // ── END SESSION ───────────────────────────────────────────
  D.closeEnd?.addEventListener('click', () => {
    if (D.endModal) D.endModal.classList.add('hidden');
  });

  D.cancelEnd?.addEventListener('click', () => {
    if (D.endModal) D.endModal.classList.add('hidden');
  });

  D.endModal?.addEventListener('click', (e) => {
    if (e.target === D.endModal) {
      D.endModal.classList.add('hidden');
    }
  });

  D.confirmEnd?.addEventListener('click', () => {
    const feedback = D.endFeedback?.value?.trim() || '';
    emit('room:end', { roomId: S.roomId, feedback });
    if (D.endModal) D.endModal.classList.add('hidden');
    releaseWakeLock();
  });

  // ── ENDED VIEW ────────────────────────────────────────────
  D.dlPdfBtn?.addEventListener('click', downloadPDF);
  D.dlXlsBtn?.addEventListener('click', downloadExcel);

  D.giveFeedbackBtn?.addEventListener('click', () => {
    initFeedbackSystem();
    showView('speakerFeedbackView');
  });

  D.reportProblemBtn?.addEventListener('click', () => {
    initProblemSystem();
    showView('problemView');
  });

  // ── SPEAKER VIEW ──────────────────────────────────────────
  D.audioToggle?.addEventListener('click', toggleAudio);

  D.spkSendChat?.addEventListener('click', sendSpeakerChat);

  D.spkChatInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendSpeakerChat();
  });

  // ── THANK YOU ─────────────────────────────────────────────
  D.shareTyWa?.addEventListener('click', () => {
    const msg = encodeURIComponent(
      `🎯 Check out ElitePace — Premium Presentation Timer!\n` +
      `No login needed. Real-time sync. Color alerts.\n\n` +
      window.location.origin
    );
    window.open(`https://wa.me/?text=${msg}`, '_blank', 'noopener');
  });

  // ── KEYBOARD SHORTCUTS ────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    // Space = Start/Pause
    if (e.code === 'Space' &&
        (S.role === 'manager' || S.role === 'cohost')) {
      e.preventDefault();
      if (S.timer.running) D.pauseBtn?.click();
      else                 D.startBtn?.click();
    }

    // Escape = close modals
    if (e.code === 'Escape') {
      [D.endModal, D.joinModal, D.addSpeakerModal].forEach(m => {
        m?.classList.add('hidden');
      });
    }

    // Ctrl+R = Reset (prevent browser refresh)
    if (e.ctrlKey && e.code === 'KeyR' &&
        (S.role === 'manager' || S.role === 'cohost')) {
      e.preventDefault();
      D.resetBtn?.click();
    }
  });

  // ── BROWSER BACK/FORWARD ──────────────────────────────────
  window.addEventListener('popstate', handleRoute);
}

// ── JOIN ROOM ──────────────────────────────────────────────────
function joinRoom(role) {
  try {
    const rawId = D.joinRoomInput?.value?.trim() || '';
    const roomId = rawId.toUpperCase();
    const name   = D.joinNameInput?.value?.trim() ||
                   localStorage.getItem('ep_name') || '';

    if (!roomId || roomId.length < 4 || roomId.length > 6) {
      showToast('Enter a valid Room ID (4–6 characters)', 'warn');
      D.joinRoomInput && shakeEl(D.joinRoomInput);
      return;
    }

    if (!name) {
      showToast('Please enter your name', 'warn');
      D.joinNameInput && shakeEl(D.joinNameInput);
      return;
    }

    S.name = name;
    localStorage.setItem('ep_name', name);

    if (D.joinModal) D.joinModal.classList.add('hidden');

    S.socket.emit('room:join', { roomId, role, name });

  } catch (err) {
    console.error('joinRoom error:', err);
    showToast('Failed to join room', 'err');
  }
}

// ── INITIALIZATION ─────────────────────────────────────────────
function init() {
  try {
    cacheDOM();
    initTheme();
    initOfflineDetection();
    initErrorLogger();
    animateLoadingMessages();
    connectSocket();
    attachEvents();
    hideLoadingScreen();

    console.log('✅ ElitePace V2.0 initialized!');

  } catch (err) {
    console.error('❌ Init error:', err);

    // Fallback — show app anyway
    if (D.loadingScreen) D.loadingScreen.style.display = 'none';
    if (D.app) D.app.classList.remove('hidden');
    showView('homeView');
  }
}

// ── START ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
