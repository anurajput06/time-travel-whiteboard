(function () {
  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  const boardStage = document.getElementById('boardStage');
  const opList = document.getElementById('opList');
  const peerCountEl = document.getElementById('peerCount');
  const userNameEl = document.getElementById('userName');
  const signOutBtn = document.getElementById('signOutBtn');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const roomLabel = document.getElementById('roomLabel');
  const copyLinkBtn = document.getElementById('copyLinkBtn');
  const canvasHint = document.getElementById('canvasHint');
  const tmSlider = document.getElementById('tmSlider');
  const tmTimeLabel = document.getElementById('tmTimeLabel');
  const forkBtn = document.getElementById('forkBtn');
  const mergeBtn = document.getElementById('mergeBtn');
  const mergeRoomInput = document.getElementById('mergeRoomInput');
  const tmStatus = document.getElementById('tmStatus');
  const undoBtn = document.getElementById('undoBtn');
  const redoBtn = document.getElementById('redoBtn');

  const CFG = window.WHITEBOARD_CONFIG || {};
  const HTTP_URL = CFG.SERVER_HTTP_URL || 'http://localhost:8080';
  const WS_URL = CFG.SERVER_WS_URL || 'ws://localhost:8080';

  // ---- Identity (from auth session, or anonymous guest) ----
  const session = window.WhiteboardAuth ? window.WhiteboardAuth.getSession() : null;
  const clientId = session ? session.user.email : Math.random().toString(36).slice(2, 7);
  let displayName = session ? session.user.name : clientId;
  userNameEl.textContent = 'you: ' + displayName + (session ? '' : ' (guest)');
  if (session) {
    signOutBtn.style.display = 'inline';
    signOutBtn.addEventListener('click', () => window.WhiteboardAuth.logout());
  }

  // ---- Editable display name ----
  // Works for guests too (session-only) and for signed-in users (this
  // session only, for now — it doesn't persist back to the account).
  const editNameBtn = document.getElementById('editNameBtn');
  editNameBtn.addEventListener('click', () => {
    document.getElementById('profileDropdown').style.display = 'none';
    const next = window.prompt('Your display name (visible to others in this room):', displayName);
    if (next === null) return; // cancelled
    const clean = next.trim().slice(0, 40);
    if (!clean) return;
    displayName = clean;
    userNameEl.textContent = 'you: ' + displayName + (session ? '' : ' (guest)');
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'rename', name: displayName }));
    else outbox.push({ type: 'rename', name: displayName });
  });

  function hashCode(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; } return h; }

  // ---- Room ----
  const urlParams = new URLSearchParams(window.location.search);
  let roomId = urlParams.get('room');
  if (!roomId) {
    roomId = Math.random().toString(36).slice(2, 8);
    urlParams.set('room', roomId);
    window.history.replaceState({}, '', `${window.location.pathname}?${urlParams.toString()}`);
  }
  roomLabel.textContent = roomId;

  copyLinkBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(window.location.href).then(() => {
      copyLinkBtn.textContent = '✓ Copied!';
      setTimeout(() => { copyLinkBtn.textContent = '📋 Copy invite link'; }, 1500);
    }).catch(() => {});
  });

  // ---- Save as image ----
  // The visible <canvas> is transparent by design (so the eraser can reveal
  // whatever background is behind it — see the eraser fix). That means a
  // plain canvas.toDataURL() would export a transparent PNG, losing whatever
  // background color you picked. So we composite background + drawing onto
  // a fresh offscreen canvas just for the export.
  const downloadBtn = document.getElementById('downloadBtn');
  downloadBtn.addEventListener('click', () => {
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = canvas.width;
    exportCanvas.height = canvas.height;
    const exportCtx = exportCanvas.getContext('2d');

    const bg = getComputedStyle(document.getElementById('boardFrame')).backgroundColor || '#FFFFFF';
    exportCtx.fillStyle = bg;
    exportCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
    exportCtx.drawImage(canvas, 0, 0);

    exportCanvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `whiteboard-${roomId}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      downloadBtn.innerHTML = '<span class="ft-icon">✓</span><span class="ft-label">Saved!</span>';
      setTimeout(() => { downloadBtn.innerHTML = '<span class="ft-icon">💾</span><span class="ft-label">Save</span>'; }, 1500);
    }, 'image/png');
  });

  // ---- Drawing / tool state ----
  let currentColor = '#1F2430';
  let currentWidth = 3;
  let tool = 'pen';        // 'pen' | 'eraser' | 'text'
  let currentBrush = 'pen'; // 'pen' | 'marker' | 'highlighter' (only meaningful when tool === 'pen')
  let clearBefore = 0;
  const knownOps = new Map();     // opId -> op   (the G-Set "adds")
  const tombstones = new Set();   // opId set     (the "removes" half of the 2P-Set)
  let localOpCount = 0;

  // Local undo/redo stacks — only track ops *this client* created this session.
  const ownOpStack = [];
  const redoStack = [];
  function updateUndoRedoButtons() {
    undoBtn.disabled = ownOpStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;
  }

  // ---- Time Machine state ----
  let boardOpenedAt = Date.now();
  let liveMode = true;

  function hideHint() { if (canvasHint) canvasHint.style.display = 'none'; }

  // ---- Activity log collapse toggle (frees up board space when hidden) ----
  const oplogPanel = document.getElementById('oplogPanel');
  const toggleLogBtn = document.getElementById('toggleLogBtn');
  const showLogBtn = document.getElementById('showLogBtn');
  const LOG_COLLAPSE_KEY = 'whiteboard_log_collapsed_v1';
  function setLogCollapsed(collapsed) {
    oplogPanel.classList.toggle('collapsed', collapsed);
    showLogBtn.style.display = collapsed ? 'block' : 'none';
    try { localStorage.setItem(LOG_COLLAPSE_KEY, collapsed ? '1' : '0'); } catch (e) {}
  }
  toggleLogBtn.addEventListener('click', () => setLogCollapsed(true));
  showLogBtn.addEventListener('click', () => setLogCollapsed(false));
  try { setLogCollapsed(localStorage.getItem(LOG_COLLAPSE_KEY) === '1'); } catch (e) {}

  // ---- Time Machine collapse toggle (same idea — board gets more room) ----
  const timeMachinePanel = document.getElementById('timeMachinePanel');
  const hideTmBtn = document.getElementById('hideTmBtn');
  const showTmBtn = document.getElementById('showTmBtn');
  const TM_COLLAPSE_KEY = 'whiteboard_tm_collapsed_v1';
  function setTmCollapsed(collapsed) {
    timeMachinePanel.classList.toggle('collapsed', collapsed);
    showTmBtn.style.display = collapsed ? 'block' : 'none';
    try { localStorage.setItem(TM_COLLAPSE_KEY, collapsed ? '1' : '0'); } catch (e) {}
  }
  hideTmBtn.addEventListener('click', () => setTmCollapsed(true));
  showTmBtn.addEventListener('click', () => setTmCollapsed(false));
  try { setTmCollapsed(localStorage.getItem(TM_COLLAPSE_KEY) === '1'); } catch (e) {}

  // ---- Presence dropdown (who's actually in this room) ----
  const presenceBtn = document.getElementById('presenceBtn');
  const presenceDropdown = document.getElementById('presenceDropdown');
  let myPeerId = null;
  let roomPeers = []; // [{id, name}] — includes yourself
  function renderPresenceDropdown() {
    const others = roomPeers.filter(p => p.id !== myPeerId);
    if (others.length === 0 && roomPeers.length <= 1) {
      presenceDropdown.innerHTML = `<div class="presence-row">Just you so far</div>`;
      return;
    }
    presenceDropdown.innerHTML = roomPeers.map(p => {
      const isYou = p.id === myPeerId;
      return `<div class="presence-row"><span class="presence-dot"></span>${p.name}${isYou ? ' (you)' : ''}</div>`;
    }).join('');
  }
  presenceBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = presenceDropdown.style.display !== 'none';
    presenceDropdown.style.display = open ? 'none' : 'block';
  });
  document.addEventListener('click', () => { presenceDropdown.style.display = 'none'; });
  presenceDropdown.addEventListener('click', (e) => e.stopPropagation());

  // ---- Profile dropdown (name / edit name / sign out) ----
  const profileBtn = document.getElementById('profileBtn');
  const profileDropdown = document.getElementById('profileDropdown');
  profileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = profileDropdown.style.display !== 'none';
    profileDropdown.style.display = open ? 'none' : 'flex';
  });
  document.addEventListener('click', () => { profileDropdown.style.display = 'none'; });
  profileDropdown.addEventListener('click', (e) => e.stopPropagation());

  // ---- Voice chat: WebRTC audio, signaled over the existing WebSocket ----
  // Mesh model: whoever has their mic ON calls everyone else in the room
  // directly (one RTCPeerConnection per listener). Turning your mic off
  // tears down only the calls YOU initiated — you can still hear anyone
  // else whose mic is on, without needing your own mic on.
  const micBtn = document.getElementById('micBtn');
  const voiceStatus = document.getElementById('voiceStatus');
  const audioContainer = document.getElementById('audioContainer');
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

  let micOn = false;
  let localStream = null;
  const outgoingConnections = new Map(); // peerId -> RTCPeerConnection (we're sending them our audio)
  const incomingConnections = new Map(); // peerId -> RTCPeerConnection (they're sending us audio)

  function sendSignal(to, payload) {
    const msg = { type: 'signal', to, payload };
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function callPeer(peerId) {
    if (!localStream || outgoingConnections.has(peerId)) return;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    outgoingConnections.set(peerId, pc);
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    pc.onicecandidate = (e) => {
      if (e.candidate) sendSignal(peerId, { kind: 'ice', candidate: e.candidate, role: 'offerer' });
    };
    pc.createOffer()
      .then(offer => pc.setLocalDescription(offer).then(() => offer))
      .then(offer => sendSignal(peerId, { kind: 'offer', sdp: offer.sdp }))
      .catch(() => {});
  }

  function handleIncomingSignal(fromPeerId, payload) {
    if (payload.kind === 'offer') {
      let pc = incomingConnections.get(fromPeerId);
      if (pc) pc.close();
      pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      incomingConnections.set(fromPeerId, pc);
      pc.onicecandidate = (e) => {
        if (e.candidate) sendSignal(fromPeerId, { kind: 'ice', candidate: e.candidate, role: 'answerer' });
      };
      pc.ontrack = (e) => {
        let audioEl = document.getElementById('audio-' + fromPeerId);
        if (!audioEl) {
          audioEl = document.createElement('audio');
          audioEl.id = 'audio-' + fromPeerId;
          audioEl.autoplay = true;
          audioContainer.appendChild(audioEl);
        }
        audioEl.srcObject = e.streams[0];
      };
      pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp })
        .then(() => pc.createAnswer())
        .then(answer => pc.setLocalDescription(answer).then(() => answer))
        .then(answer => sendSignal(fromPeerId, { kind: 'answer', sdp: answer.sdp }))
        .catch(() => {});
    } else if (payload.kind === 'answer') {
      const pc = outgoingConnections.get(fromPeerId);
      if (pc) pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp }).catch(() => {});
    } else if (payload.kind === 'ice') {
      // role tells us, from the SENDER's perspective, which side of the
      // handshake this candidate belongs to — so we know which of our two
      // local connection maps (outgoing vs incoming) it applies to.
      const pc = payload.role === 'offerer' ? incomingConnections.get(fromPeerId) : outgoingConnections.get(fromPeerId);
      if (pc) pc.addIceCandidate(payload.candidate).catch(() => {});
    }
  }

  function teardownPeer(peerId) {
    const pcOut = outgoingConnections.get(peerId);
    if (pcOut) { pcOut.close(); outgoingConnections.delete(peerId); }
    const pcIn = incomingConnections.get(peerId);
    if (pcIn) { pcIn.close(); incomingConnections.delete(peerId); }
    const audioEl = document.getElementById('audio-' + peerId);
    if (audioEl) audioEl.remove();
  }

  function syncVoiceWithPeers() {
    const currentIds = new Set(roomPeers.map(p => p.id).filter(id => id !== myPeerId));
    if (micOn) {
      currentIds.forEach(id => { if (!outgoingConnections.has(id)) callPeer(id); });
    }
    const knownIds = new Set([...outgoingConnections.keys(), ...incomingConnections.keys()]);
    knownIds.forEach(id => { if (!currentIds.has(id)) teardownPeer(id); });
  }

  async function turnMicOn() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      voiceStatus.textContent = 'Mic permission denied or unavailable.';
      return;
    }
    micOn = true;
    micBtn.textContent = '🎤 Mic on';
    micBtn.classList.add('active');
    voiceStatus.textContent = 'Others here can hear you';
    roomPeers.filter(p => p.id !== myPeerId).forEach(p => callPeer(p.id));
  }
  function turnMicOff() {
    micOn = false;
    micBtn.textContent = '🎤 Mic off';
    micBtn.classList.remove('active');
    voiceStatus.textContent = '';
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    outgoingConnections.forEach(pc => pc.close());
    outgoingConnections.clear();
  }
  micBtn.addEventListener('click', () => { micOn ? turnMicOff() : turnMicOn(); });

  // ---- Brush render parameters ----
  function brushParams(brush) {
    if (brush === 'marker') return { alpha: 0.9, widthMul: 1.9, cap: 'round', composite: 'source-over' };
    if (brush === 'highlighter') return { alpha: 0.32, widthMul: 4.5, cap: 'square', composite: 'source-over' };
    if (brush === 'eraser') return { alpha: 1, widthMul: 4, cap: 'round', composite: 'destination-out' };
    return { alpha: 1, widthMul: 1, cap: 'round', composite: 'source-over' }; // 'pen'
  }

  // ---- Toolbar wiring: colors ----
  document.querySelectorAll('.swatch:not(.swatch-custom)').forEach(sw => {
    sw.addEventListener('click', () => {
      document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
      sw.classList.add('active');
      currentColor = sw.dataset.color;
      setTool('pen');
      updateCursor();
    });
  });

  const customColorPicker = document.getElementById('customColorPicker');
  customColorPicker.addEventListener('input', () => {
    document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
    document.querySelector('.swatch-custom').classList.add('active');
    currentColor = customColorPicker.value;
    setTool('pen');
    updateCursor();
  });

  // ---- Per-tool cursor preview: an actual pencil/marker/highlighter/eraser
  // shaped cursor (not just an abstract dot), tinted with the current color ----
  function svgCursor(svgInner, size, hotX, hotY) {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' viewBox='0 0 32 32'>${svgInner}</svg>`;
    const encoded = encodeURIComponent(svg).replace(/'/g, '%27');
    return `url("data:image/svg+xml,${encoded}") ${hotX} ${hotY}, crosshair`;
  }
  function buildPenCursor(color) {
    // A slim pencil body with a colored tip pointing down-left (toward the cursor hotspot).
    const inner = `<line x1='27' y1='5' x2='9' y2='23' stroke='#D1D5DB' stroke-width='6' stroke-linecap='round'/>`
      + `<line x1='27' y1='5' x2='22' y2='10' stroke='#6B7280' stroke-width='6' stroke-linecap='round'/>`
      + `<polygon points='9,23 15,20 12,17' fill='${color}' stroke='#FFFFFF' stroke-width='1'/>`;
    return svgCursor(inner, 32, 10, 22);
  }
  function buildMarkerCursor(color, alpha) {
    // A chunkier marker body with a rounded colored nib.
    const inner = `<line x1='26' y1='6' x2='12' y2='20' stroke='#B8BEC8' stroke-width='10' stroke-linecap='round'/>`
      + `<circle cx='10' cy='22' r='6' fill='${color}' fill-opacity='${alpha}' stroke='#FFFFFF' stroke-width='1.5'/>`;
    return svgCursor(inner, 32, 10, 22);
  }
  function buildHighlighterCursor(color, alpha) {
    // A flat, wide chisel tip — visually distinct (wider + translucent) from the marker.
    const inner = `<line x1='25' y1='7' x2='14' y2='18' stroke='#D1D5DB' stroke-width='9' stroke-linecap='round'/>`
      + `<rect x='6' y='16' width='14' height='9' rx='2' fill='${color}' fill-opacity='${alpha}' stroke='#FFFFFF' stroke-width='1' transform='rotate(-45 13 20)'/>`;
    return svgCursor(inner, 32, 11, 22);
  }
  function buildEraserCursor() {
    const inner = `<rect x='6' y='10' width='20' height='14' rx='4' fill='#FFFFFF' stroke='#9AA1AC' stroke-width='2' transform='rotate(-20 16 17)'/>`;
    return svgCursor(inner, 32, 16, 17);
  }
  function updateCursor() {
    if (tool === 'text') { canvas.style.cursor = 'text'; return; }
    if (tool === 'eraser') { canvas.style.cursor = buildEraserCursor(); return; }
    const { alpha } = brushParams(currentBrush);
    if (currentBrush === 'marker') canvas.style.cursor = buildMarkerCursor(currentColor, alpha);
    else if (currentBrush === 'highlighter') canvas.style.cursor = buildHighlighterCursor(currentColor, alpha);
    else canvas.style.cursor = buildPenCursor(currentColor);
  }

  // ---- Toolbar wiring: brush types + eraser + text ----
  const brushButtons = {
    pen: document.getElementById('brushPenBtn'),
    marker: document.getElementById('brushMarkerBtn'),
    highlighter: document.getElementById('brushHighlighterBtn'),
  };
  const eraserBtn = document.getElementById('eraserBtn');
  const textToolBtn = document.getElementById('textToolBtn');

  function setActiveToolButton(activeBtn) {
    [...Object.values(brushButtons), eraserBtn, textToolBtn].forEach(b => b.classList.remove('active'));
    if (activeBtn) activeBtn.classList.add('active');
  }

  function setTool(newTool, brush) {
    tool = newTool;
    if (brush) currentBrush = brush;
    if (tool === 'pen') setActiveToolButton(brushButtons[currentBrush]);
    else if (tool === 'eraser') setActiveToolButton(eraserBtn);
    else if (tool === 'text') setActiveToolButton(textToolBtn);
    updateCursor();
  }

  brushButtons.pen.addEventListener('click', () => setTool('pen', 'pen'));
  brushButtons.marker.addEventListener('click', () => setTool('pen', 'marker'));
  brushButtons.highlighter.addEventListener('click', () => setTool('pen', 'highlighter'));
  eraserBtn.addEventListener('click', () => setTool('eraser'));
  textToolBtn.addEventListener('click', () => setTool('text'));

  document.getElementById('widthSlider').addEventListener('input', e => { currentWidth = parseInt(e.target.value, 10); updateCursor(); });
  document.getElementById('clearBtn').addEventListener('click', broadcastClear);
  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);

  // ---- Board background (LOCAL preference only — never synced, so everyone
  // can pick their own without affecting anyone else's view of the board) ----
  const BG_STORAGE_KEY = 'whiteboard_bg_pref_v1';
  function applyBackground(color) {
    document.getElementById('boardFrame').style.backgroundColor = color;
    document.querySelectorAll('.bg-swatch').forEach(s => s.classList.remove('active'));
    const matching = document.querySelector(`.bg-swatch[data-bg="${color}"]`);
    if (matching) matching.classList.add('active');
    else document.querySelector('.bg-swatch-custom').classList.add('active');
  }
  function setBackground(color) {
    applyBackground(color);
    try { localStorage.setItem(BG_STORAGE_KEY, color); } catch (e) {}
  }
  document.querySelectorAll('.bg-swatch:not(.bg-swatch-custom)').forEach(sw => {
    sw.addEventListener('click', () => setBackground(sw.dataset.bg));
  });
  const customBgPicker = document.getElementById('customBgPicker');
  customBgPicker.addEventListener('input', () => setBackground(customBgPicker.value));
  // Restore this browser's saved preference on load (falls back to default white).
  try {
    const savedBg = localStorage.getItem(BG_STORAGE_KEY);
    if (savedBg) applyBackground(savedBg);
  } catch (e) {}

  // ---- Canvas drawing (pen / marker / highlighter / eraser) ----
  let drawing = false;
  let currentStroke = null;

  function toBoardCoords(evt) {
    const rect = canvas.getBoundingClientRect();
    return { x: (evt.clientX - rect.left) / rect.width, y: (evt.clientY - rect.top) / rect.height };
  }

  canvas.addEventListener('pointerdown', e => {
    if (!liveMode) return; // don't draw while scrubbing history
    if (tool === 'text') return; // text placement is handled by the 'click' listener below

    drawing = true;
    const p = toBoardCoords(e);
    currentStroke = {
      id: clientId + '-' + Date.now() + '-' + (localOpCount++),
      clientId,
      type: 'stroke',
      brush: tool === 'eraser' ? 'eraser' : currentBrush,
      color: tool === 'eraser' ? '#000000' : currentColor, // color is unused for eraser (compositing ignores it) but kept for schema validity
      width: tool === 'eraser' ? currentWidth * 4 : currentWidth,
      points: [p],
      ts: Date.now(),
    };
  });
  canvas.addEventListener('pointermove', e => {
    if (!drawing) return;
    const p = toBoardCoords(e);
    currentStroke.points.push(p);
    renderIncremental(currentStroke);
  });
  window.addEventListener('pointerup', () => {
    if (!drawing) return;
    drawing = false;
    if (currentStroke && currentStroke.points.length > 1) {
      commitOwnOp(currentStroke);
    }
    currentStroke = null;
  });

  function commitOwnOp(op) {
    knownOps.set(op.id, op);
    ownOpStack.push(op.id);
    redoStack.length = 0; // a fresh action clears the redo stack, standard undo/redo semantics
    updateUndoRedoButtons();
    hideHint();
    logOp(op, true);
    sendOp(op);
    refreshTimeMachineRange();
  }

  canvas.addEventListener('click', e => {
    if (tool === 'text' && liveMode) { openTextInput(e); }
  });

  // ---- Text tool ----
  let activeTextInput = null;
  function openTextInput(evt) {
    if (activeTextInput) commitTextInput(); // commit any in-progress text box first
    const rect = canvas.getBoundingClientRect();
    const stageRect = boardStage.getBoundingClientRect();
    const left = rect.left - stageRect.left + (evt.clientX - rect.left);
    const top = rect.top - stageRect.top + (evt.clientY - rect.top);
    const fx = (evt.clientX - rect.left) / rect.width;
    const fy = (evt.clientY - rect.top) / rect.height;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-input-overlay';
    input.style.left = left + 'px';
    input.style.top = (top - 14) + 'px';
    input.style.color = currentColor;
    input.style.fontSize = Math.max(14, currentWidth * 6) + 'px';
    input.placeholder = 'Type here…';
    boardStage.appendChild(input);

    activeTextInput = { el: input, fx, fy };

    input.addEventListener('keydown', (ke) => {
      ke.stopPropagation();
      if (ke.key === 'Enter') commitTextInput();
      if (ke.key === 'Escape') cancelTextInput();
    });
    input.addEventListener('blur', () => commitTextInput());

    // Deferring focus to the next tick wins against the browser's default
    // focus handling for the click that just happened — focusing
    // synchronously inside the click handler was getting silently undone,
    // which fired 'blur' immediately and made the text box vanish before
    // anyone could type into it.
    setTimeout(() => input.focus(), 0);
  }

  function commitTextInput() {
    if (!activeTextInput) return;
    const { el, fx, fy } = activeTextInput;
    const text = el.value.trim();
    const fontPx = parseFloat(el.style.fontSize);
    activeTextInput = null;
    el.remove();
    if (!text) return;

    const op = {
      id: clientId + '-' + Date.now() + '-' + (localOpCount++),
      clientId,
      type: 'text',
      color: currentColor,
      x: fx, y: fy,
      text,
      fontSize: fontPx / canvas.height, // store as a fraction of canvas height so it scales like strokes do
      ts: Date.now(),
    };
    commitOwnOp(op);
    redrawAll();
  }
  function cancelTextInput() {
    if (!activeTextInput) return;
    activeTextInput.el.remove();
    activeTextInput = null;
  }

  // ---- Undo / Redo (2P-Set: tombstone your own last op / un-tombstone it) ----
  function undo() {
    if (ownOpStack.length === 0) return;
    const opId = ownOpStack.pop();
    if (tombstones.has(opId)) { updateUndoRedoButtons(); return undo(); } // already hidden, skip
    tombstones.add(opId);
    redoStack.push(opId);
    updateUndoRedoButtons();
    redrawAll();
    sendUndo(opId);
  }
  function redo() {
    if (redoStack.length === 0) return;
    const opId = redoStack.pop();
    tombstones.delete(opId);
    ownOpStack.push(opId);
    updateUndoRedoButtons();
    redrawAll();
    sendRedo(opId);
  }

  // ---- Rendering ----
  function renderIncremental(stroke) {
    if (stroke.points.length < 2) return;
    const { alpha, widthMul, cap, composite } = brushParams(stroke.brush);
    ctx.globalCompositeOperation = composite;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = stroke.color; ctx.lineWidth = stroke.width * widthMul;
    ctx.lineCap = cap; ctx.lineJoin = 'round';
    ctx.beginPath();
    const p0 = stroke.points[stroke.points.length - 2], p1 = stroke.points[stroke.points.length - 1];
    ctx.moveTo(p0.x * canvas.width, p0.y * canvas.height);
    ctx.lineTo(p1.x * canvas.width, p1.y * canvas.height);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function renderFullStroke(stroke) {
    if (stroke.points.length < 2) return;
    const { alpha, widthMul, cap, composite } = brushParams(stroke.brush);
    ctx.globalCompositeOperation = composite;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = stroke.color; ctx.lineWidth = stroke.width * widthMul;
    ctx.lineCap = cap; ctx.lineJoin = 'round';
    ctx.beginPath();
    stroke.points.forEach((p, i) => {
      const x = p.x * canvas.width, y = p.y * canvas.height;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function renderTextOp(op) {
    const px = op.fontSize * canvas.height;
    ctx.globalAlpha = 1;
    ctx.fillStyle = op.color;
    ctx.font = `600 ${px}px Inter, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillText(op.text, op.x * canvas.width, op.y * canvas.height - px * 0.9);
  }

  // The Time Machine "X-factor": redrawAll is the ONLY function that changes
  // when scrubbing history — it filters the same 2P-Set by a timestamp
  // cutoff and by tombstones. No special backend support needed.
  function redrawAll() {
    const cutoff = liveMode ? Infinity : sliderValueToTimestamp();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    Array.from(knownOps.values())
      .filter(op => op.ts >= clearBefore && op.ts <= cutoff && !tombstones.has(op.id))
      .sort((a, b) => a.ts - b.ts)
      .forEach(op => op.type === 'text' ? renderTextOp(op) : renderFullStroke(op));
  }

  function logOp(op, isLocal) {
    const row = document.createElement('div');
    row.className = 'op-row';
    const dotColor = '#' + ((Math.abs(hashCode(op.clientId)) % 0xFFFFFF).toString(16).padStart(6, '0'));
    const who = isLocal ? 'you' : op.clientId.split('@')[0];
    const what = op.type === 'text'
      ? `added text "${op.text.slice(0, 18)}${op.text.length > 18 ? '…' : ''}"`
      : op.brush === 'eraser' ? `erased a spot (${op.points.length}pt)` : `drew a ${op.points.length}pt stroke`;
    row.innerHTML = `<span class="op-dot" style="background:${dotColor}"></span>
      <span class="op-meta"><b>${who}</b> ${what}<br><span class="op-time">#${op.id.slice(-6)} · ${new Date(op.ts).toLocaleTimeString()}</span></span>`;
    opList.prepend(row);
    while (opList.children.length > 60) opList.removeChild(opList.lastChild);
  }
  function logClear(who, isLocal) {
    const row = document.createElement('div');
    row.className = 'op-row';
    row.innerHTML = `<span class="op-dot" style="background:#9AA1AC"></span>
      <span class="op-meta"><b>${isLocal ? 'you' : who}</b> cleared the board<br><span class="op-time">${new Date().toLocaleTimeString()}</span></span>`;
    opList.prepend(row);
  }

  // ---- Time Machine slider wiring ----
  function refreshTimeMachineRange() {
    if (knownOps.size === 0) return;
    const timestamps = Array.from(knownOps.values()).map(o => o.ts);
    boardOpenedAt = Math.min(...timestamps);
  }
  function sliderValueToTimestamp() {
    const pct = Number(tmSlider.value) / 100;
    const now = Date.now();
    return boardOpenedAt + pct * (now - boardOpenedAt);
  }
  tmSlider.addEventListener('input', () => {
    liveMode = Number(tmSlider.value) >= 100;
    tmTimeLabel.textContent = liveMode ? 'live' : new Date(sliderValueToTimestamp()).toLocaleTimeString();
    redrawAll();
  });

  forkBtn.addEventListener('click', async () => {
    const atTimestamp = liveMode ? Date.now() : Math.round(sliderValueToTimestamp());
    tmStatus.textContent = 'Saving this moment as a new board…';
    try {
      const res = await fetch(`${HTTP_URL}/rooms/${encodeURIComponent(roomId)}/fork`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ atTimestamp }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong — please try again.');
      tmStatus.textContent = `Done! New board "${data.forkId}" created with ${data.opsCarried} item(s) — opening it in a new tab…`;
      const forkUrl = new URL(window.location.href);
      forkUrl.searchParams.set('room', data.forkId);
      window.open(forkUrl.toString(), '_blank');
    } catch (err) {
      tmStatus.textContent = "Couldn't save a new board: " + err.message;
    }
  });

  mergeBtn.addEventListener('click', async () => {
    const sourceRoomId = mergeRoomInput.value.trim();
    if (!sourceRoomId) { tmStatus.textContent = 'Paste the other board\'s code above first.'; return; }
    tmStatus.textContent = 'Bringing that board\'s drawings in…';
    try {
      const res = await fetch(`${HTTP_URL}/rooms/${encodeURIComponent(roomId)}/merge`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceRoomId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong — please try again.');
      tmStatus.textContent = data.merged > 0
        ? `Done! Added ${data.merged} new drawing(s) from that board — nothing was lost or overwritten.`
        : `That board didn't have anything new to add.`;
    } catch (err) {
      tmStatus.textContent = "Couldn't bring that board in: " + err.message;
    }
  });

  // ---- WebSocket connection with backoff reconnect ----
  let ws = null;
  let reconnectDelay = 1000;
  const MAX_RECONNECT_DELAY = 15000;
  const outbox = [];

  function setStatus(state) {
    if (state === 'connected') { statusDot.style.background = 'var(--accent-teal)'; statusText.textContent = 'Connected'; }
    else if (state === 'connecting') { statusDot.style.background = 'var(--accent-amber)'; statusText.textContent = 'Connecting…'; }
    else { statusDot.style.background = 'var(--ink-faint)'; statusText.textContent = 'Offline (drawing locally)'; }
  }

  function connect() {
    setStatus('connecting');
    const tokenParam = session ? `&token=${encodeURIComponent(session.token)}` : '';
    const wsUrl = `${WS_URL}?room=${encodeURIComponent(roomId)}${tokenParam}`;
    try { ws = new WebSocket(wsUrl); } catch (err) { scheduleReconnect(); return; }

    ws.onopen = () => {
      setStatus('connected');
      reconnectDelay = 1000;
      while (outbox.length) ws.send(JSON.stringify(outbox.shift()));
    };

    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }

      if (msg.type === 'init') {
        clearBefore = msg.clearTs || 0;
        (msg.ops || []).forEach(op => knownOps.set(op.id, op));
        (msg.tombstones || []).forEach(id => tombstones.add(id));
        peerCountEl.textContent = msg.peerCount || 1;
        myPeerId = msg.yourPeerId || null;
        roomPeers = msg.peers || [];
        renderPresenceDropdown();
        syncVoiceWithPeers();
        refreshTimeMachineRange();
        redrawAll();
      } else if (msg.type === 'op') {
        if (!knownOps.has(msg.op.id)) {
          knownOps.set(msg.op.id, msg.op);
          if (msg.op.clientId !== clientId) logOp(msg.op, false);
          refreshTimeMachineRange();
          redrawAll();
        }
      } else if (msg.type === 'undo') {
        if (!tombstones.has(msg.opId)) { tombstones.add(msg.opId); redrawAll(); }
      } else if (msg.type === 'redo') {
        if (tombstones.has(msg.opId)) { tombstones.delete(msg.opId); redrawAll(); }
      } else if (msg.type === 'clear') {
        if (msg.ts > clearBefore) {
          clearBefore = msg.ts;
          if (msg.clientId !== clientId) logClear(msg.clientId, false);
          redrawAll();
        }
      } else if (msg.type === 'presence') {
        peerCountEl.textContent = msg.peerCount;
        roomPeers = msg.peers || [];
        renderPresenceDropdown();
        syncVoiceWithPeers();
      } else if (msg.type === 'signal') {
        handleIncomingSignal(msg.from, msg.payload);
      }
    };

    ws.onclose = () => {
      setStatus('offline');
      [...outgoingConnections.keys(), ...incomingConnections.keys()].forEach(teardownPeer);
      scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  function scheduleReconnect() {
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(MAX_RECONNECT_DELAY, reconnectDelay * 1.7);
  }

  function sendOp(op) {
    const msg = { type: 'op', op };
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else outbox.push(msg);
  }
  function sendUndo(opId) {
    const msg = { type: 'undo', opId };
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else outbox.push(msg);
  }
  function sendRedo(opId) {
    const msg = { type: 'redo', opId };
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else outbox.push(msg);
  }

  function broadcastClear() {
    const ts = Date.now();
    clearBefore = ts;
    redrawAll();
    logClear(clientId, true);
    ownOpStack.length = 0; redoStack.length = 0; updateUndoRedoButtons();
    const msg = { type: 'clear', ts, clientId };
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else outbox.push(msg);
  }

  updateUndoRedoButtons();
  updateCursor();
  connect();
})();
