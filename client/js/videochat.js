requireLogin();

const els = {
  remoteVideo: document.getElementById('remoteVideo'),
  localVideo: document.getElementById('localVideo'),
  searchState: document.getElementById('searchState'),
  searchText: document.getElementById('searchText'),
  searchSub: document.getElementById('searchSub'),
  coinPill: document.getElementById('coinPill'),
  giftBadge: document.getElementById('giftBadge'),
  swipeHint: document.getElementById('swipeHint'),
  giftSheetBackdrop: document.getElementById('giftSheetBackdrop'),
  giftSheetBalance: document.getElementById('giftSheetBalance'),
  reportSheetBackdrop: document.getElementById('reportSheetBackdrop'),
  chatSheetBackdrop: document.getElementById('chatSheetBackdrop'),
  chatMessages: document.getElementById('chatMessages'),
  chatInput: document.getElementById('chatInput'),
  videoScreen: document.getElementById('videoScreen'),
  muteBtn: document.getElementById('muteBtn'),
  cameraBtn: document.getElementById('cameraBtn'),
};

// STUN (candidate discovery) + a public demo TURN relay (Metered's "Open
// Relay Project" - free, documented at https://www.metered.ca/tools/openrelay/)
// so calls still connect across strict mobile/carrier NATs that STUN alone
// can't traverse. This is what was mostly behind "connection takes forever" -
// without a TURN fallback, a good chunk of real-world phone-to-phone pairs
// simply cannot establish a direct path at all.
// For real production traffic at scale, swap this for your own dedicated
// TURN server (coturn, Twilio, Metered paid plan, etc) - the free relay above
// is rate-limited and meant for testing/small deployments.
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ],
  iceCandidatePoolSize: 10,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require'
};

const CONNECT_TIMEOUT_MS = 15000; // if a matched pair can't connect within this, auto-retry with someone new

let socket, localStream, pc, currentRoom = null, peerId = null, myUserId = null;
let isMuted = false, isCameraOn = true, giftSessionActive = false;
let pendingSignals = [];      // signal messages that arrive before `pc` exists yet
let connectTimeoutHandle = null;
let gotRemoteTrack = false;

async function init() {
  const { user } = await api('/api/user/me');
  myUserId = user.id;
  els.coinPill.textContent = '🪙 ' + fmtCoins(user.spendable_coins);
  window.__spendable = user.spendable_coins;

  if (user.account_status === 'banned') { window.location.href = '/banned.html'; return; }

  try {
    // Moderate resolution/frame-rate keeps calls smooth on average phone
    // uplinks - requesting 720p+ by default is a common cause of "laggy video"
    // once real cellular/wifi bandwidth is in the picture.
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    els.localVideo.srcObject = localStream;
  } catch (err) {
    toast('Camera/mic permission needed to start a video chat.');
    return;
  }

  connectSocket();
}

function connectSocket() {
  socket = io({ auth: { token: Session.getToken() } });

  socket.on('connect', () => socket.emit('find_match'));
  socket.on('searching', () => showSearching('searching'));
  socket.on('banned', () => window.location.href = '/banned.html');

  socket.on('matched', async ({ roomId, initiator, peerId: pId }) => {
    currentRoom = roomId; peerId = pId;
    gotRemoteTrack = false;
    pendingSignals = [];
    showSearching('connecting');
    await setupPeerConnection(initiator);
    startConnectTimeout();
  });

  socket.on('signal', async ({ data }) => {
    if (!pc) {
      // The offer/candidates can arrive a moment before our own
      // RTCPeerConnection finishes being created - buffer instead of
      // dropping them (dropping is what used to cause one side to get stuck
      // on the spinner forever).
      pendingSignals.push(data);
      return;
    }
    await handleSignal(data);
  });

  socket.on('partner_left', () => {
    toast('Partner left. Finding someone new...');
    cleanupPeer();
    showSearching('searching');
    socket.emit('find_match');
  });

  socket.on('balance_update', ({ spendable_coins }) => {
    window.__spendable = spendable_coins;
    els.coinPill.textContent = '🪙 ' + fmtCoins(spendable_coins);
  });

  socket.on('gift_started', ({ amount }) => {
    giftSessionActive = true;
    els.giftBadge.classList.remove('hidden');
    els.giftBadge.textContent = `🎁 ${amount}`;
  });

  socket.on('gift_tick', ({ remaining }) => {
    els.giftBadge.textContent = `🎁 ${remaining}`;
  });

  socket.on('gift_ended', () => {
    giftSessionActive = false;
    els.giftBadge.classList.add('hidden');
  });

  socket.on('gift_error', ({ error }) => {
    toast('Gift error: ' + error.replace(/_/g, ' '));
  });

  socket.on('chat_message', ({ text, at }) => {
    appendChatMessage(text, 'them', at);
    if (els.chatSheetBackdrop.classList.contains('hidden')) toast('New message');
  });
}

async function handleSignal(data) {
  if (data.sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    if (data.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { roomId: currentRoom, data: { sdp: pc.localDescription } });
    }
  } else if (data.candidate) {
    try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (e) {}
  }
}

function showSearching(state) {
  // state: 'searching' | 'connecting' | 'hidden'
  if (state === 'hidden') {
    els.searchState.classList.add('hidden');
    els.swipeHint.classList.remove('hidden');
    return;
  }
  els.searchState.classList.remove('hidden');
  els.swipeHint.classList.add('hidden');
  if (state === 'searching') {
    els.searchText.textContent = 'Looking for someone...';
    els.searchSub.textContent = 'Please wait, we are connecting you to a random person.';
  } else {
    els.searchText.textContent = 'Connecting...';
    els.searchSub.textContent = 'Setting up your video call.';
  }
}

async function setupPeerConnection(initiator) {
  pc = new RTCPeerConnection(ICE_SERVERS);
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.ontrack = (event) => {
    els.remoteVideo.srcObject = event.streams[0];
    gotRemoteTrack = true;
    // Only hide the connecting animation once we actually have a live remote
    // track - this is the real fix for "one side still shows the round
    // spinner": we used to hide it immediately on `matched`, before the
    // media had actually arrived.
    showSearching('hidden');
    clearConnectTimeout();
  };

  pc.oniceconnectionstatechange = () => {
    if (!pc) return;
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
      // Give it a moment to self-recover (ICE restart / network blip) before giving up.
      setTimeout(() => {
        if (pc && (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') && !gotRemoteTrack) {
          toast('Connection failed. Finding someone new...');
          swipeNext();
        }
      }, 4000);
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', { roomId: currentRoom, data: { candidate: event.candidate } });
    }
  };

  // Flush any signals that arrived before `pc` existed.
  const queued = pendingSignals.splice(0, pendingSignals.length);
  for (const data of queued) await handleSignal(data);

  if (initiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', { roomId: currentRoom, data: { sdp: pc.localDescription } });
  }
}

function startConnectTimeout() {
  clearConnectTimeout();
  connectTimeoutHandle = setTimeout(() => {
    if (!gotRemoteTrack) {
      toast('Taking too long. Trying someone new...');
      swipeNext();
    }
  }, CONNECT_TIMEOUT_MS);
}
function clearConnectTimeout() {
  if (connectTimeoutHandle) { clearTimeout(connectTimeoutHandle); connectTimeoutHandle = null; }
}

function cleanupPeer() {
  clearConnectTimeout();
  if (pc) { pc.close(); pc = null; }
  els.remoteVideo.srcObject = null;
  currentRoom = null; peerId = null;
  giftSessionActive = false;
  gotRemoteTrack = false;
  pendingSignals = [];
  els.giftBadge.classList.add('hidden');
  els.chatMessages.innerHTML = '';
}

// ---- Swipe up for next ----
let touchStartY = null;
els.videoScreen.addEventListener('touchstart', (e) => { touchStartY = e.touches[0].clientY; }, { passive: true });
els.videoScreen.addEventListener('touchend', (e) => {
  if (touchStartY === null) return;
  const deltaY = touchStartY - e.changedTouches[0].clientY;
  if (deltaY > 80 && currentRoom) swipeNext();
  touchStartY = null;
});

function swipeNext() {
  if (socket) socket.emit('swipe_next');
  cleanupPeer();
  showSearching('searching');
}

// ---- Mute / Camera toggle ----
els.muteBtn.addEventListener('click', () => {
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  els.muteBtn.classList.toggle('active', isMuted);
});
els.cameraBtn.addEventListener('click', () => {
  isCameraOn = !isCameraOn;
  localStream.getVideoTracks().forEach(t => t.enabled = isCameraOn);
  els.cameraBtn.classList.toggle('active', !isCameraOn);
});

// ---- Chat ----
document.getElementById('chatBtn').addEventListener('click', () => {
  if (!currentRoom) return toast('Wait until you are connected to someone.');
  els.chatSheetBackdrop.classList.remove('hidden');
  els.chatInput.focus();
});
document.getElementById('closeChatSheet').addEventListener('click', () => els.chatSheetBackdrop.classList.add('hidden'));

function sendChat() {
  const text = els.chatInput.value.trim();
  if (!text || !currentRoom) return;
  socket.emit('chat_message', { text });
  appendChatMessage(text, 'me', Date.now());
  els.chatInput.value = '';
}
document.getElementById('sendChatBtn').addEventListener('click', sendChat);
els.chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

function appendChatMessage(text, from, at) {
  const div = document.createElement('div');
  div.style.cssText = `max-width:78%; padding:9px 13px; border-radius:14px; font-size:13px; word-break:break-word; ${
    from === 'me'
      ? 'align-self:flex-end; background:linear-gradient(135deg,#33e6ff,#2196ff); color:#031425;'
      : 'align-self:flex-start; background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.12);'
  }`;
  div.textContent = text;
  els.chatMessages.appendChild(div);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

// ---- Gift sheet ----
document.getElementById('giftBtn').addEventListener('click', () => {
  if (!currentRoom) return toast('Wait until you are connected to someone.');
  if (giftSessionActive) return toast('A gift is already active in this call.');
  els.giftSheetBalance.textContent = 'Balance: ' + fmtCoins(window.__spendable) + ' 🪙';
  els.giftSheetBackdrop.classList.remove('hidden');
});
document.getElementById('closeGiftSheet').addEventListener('click', () => els.giftSheetBackdrop.classList.add('hidden'));
document.querySelectorAll('.gift-opt').forEach(opt => {
  opt.addEventListener('click', () => {
    const amt = Number(opt.dataset.amt);
    if (amt > window.__spendable) { toast('Insufficient balance for this gift.'); return; }
    socket.emit('send_gift', { amount: amt });
    els.giftSheetBackdrop.classList.add('hidden');
  });
});

// ---- Report flow: capture 5s clip of remote video as evidence ----
document.getElementById('reportBtn').addEventListener('click', () => {
  if (!currentRoom) return toast('You are not in a call.');
  els.reportSheetBackdrop.classList.remove('hidden');
});
document.getElementById('closeReportSheet').addEventListener('click', () => els.reportSheetBackdrop.classList.add('hidden'));

document.querySelectorAll('.reason-opt').forEach(opt => {
  opt.addEventListener('click', async () => {
    const reason = opt.dataset.reason;
    els.reportSheetBackdrop.classList.add('hidden');
    await submitReportWithEvidence(reason);
  });
});

async function submitReportWithEvidence(reason) {
  const reportedUserId = peerId;
  const sessionId = currentRoom;
  toast('Capturing evidence...');

  let blob = null;
  try {
    blob = await captureClip(els.remoteVideo, 5000);
  } catch (e) {
    console.warn('Evidence capture failed', e);
  }

  const form = new FormData();
  form.append('reported_user_id', reportedUserId || '');
  form.append('reason', reason);
  form.append('session_id', sessionId || '');
  if (blob) form.append('clip', blob, 'evidence.webm');

  try {
    await api('/api/reports', { method: 'POST', body: form, isForm: true });
    toast('Report submitted. Ending call.');
  } catch (e) {
    toast('Report failed to submit.');
  }

  // Immediately end the current session regardless of evidence capture outcome.
  socket.emit('leave_room');
  cleanupPeer();
  socket.emit('find_match');
  showSearching('searching');
}

function captureClip(videoEl, durationMs) {
  return new Promise((resolve, reject) => {
    const stream = videoEl.srcObject;
    if (!stream) return reject(new Error('no_stream'));
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
    recorder.onerror = reject;
    recorder.start();
    setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, durationMs);
  });
}

window.addEventListener('beforeunload', () => {
  if (socket) socket.emit('leave_room');
});

init();
