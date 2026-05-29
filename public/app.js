// Press-to-hold-to-translate front-end.
//
// Architecture: the browser asks our backend for an ephemeral Realtime session
// token, then opens a WebRTC connection DIRECTLY to OpenAI. Audio frames go
// straight to OpenAI; our backend is never in the audio path.
//
// Turn detection is manual (turn_detection: null on the server). The model
// only responds when we send input_audio_buffer.commit + response.create —
// which we do on button release. That's what keeps it from speaking while you
// are still talking.

const LANGUAGES = [
  'Afrikaans', 'Arabic', 'Armenian', 'Azerbaijani', 'Belarusian', 'Bosnian',
  'Bulgarian', 'Catalan', 'Chinese (Mandarin)', 'Chinese (Cantonese)', 'Croatian',
  'Czech', 'Danish', 'Dutch', 'English', 'Estonian', 'Finnish', 'French',
  'Galician', 'German', 'Greek', 'Hebrew', 'Hindi', 'Hungarian', 'Icelandic',
  'Indonesian', 'Italian', 'Japanese', 'Kannada', 'Kazakh', 'Korean', 'Latvian',
  'Lithuanian', 'Macedonian', 'Malay', 'Marathi', 'Maori', 'Nepali', 'Norwegian',
  'Persian', 'Polish', 'Portuguese (Brazil)', 'Portuguese (Portugal)', 'Romanian',
  'Russian', 'Serbian', 'Slovak', 'Slovenian', 'Spanish', 'Swahili', 'Swedish',
  'Tagalog', 'Tamil', 'Thai', 'Turkish', 'Ukrainian', 'Urdu', 'Vietnamese', 'Welsh',
];

const STORAGE_KEY = 'pthtt:languages:v1';
const HOLD_THRESHOLD_MS = 250; // < this = tap-toggle; >= this = walkie-talkie hold

const el = {
  talkBtn: document.getElementById('talk-btn'),
  status: document.getElementById('status'),
  timer: document.getElementById('timer'),
  transcript: document.getElementById('transcript'),
  remoteAudio: document.getElementById('remote-audio'),
  settingsBtn: document.getElementById('settings-btn'),
  langPairLabel: document.getElementById('lang-pair-label'),
  picker: document.getElementById('picker'),
  langA: document.getElementById('lang-a'),
  langB: document.getElementById('lang-b'),
  pickerSave: document.getElementById('picker-save'),
  pickerCancel: document.getElementById('picker-cancel'),
  toast: document.getElementById('toast'),
};

// Populate language dropdowns
for (const lang of LANGUAGES) {
  for (const select of [el.langA, el.langB]) {
    const opt = document.createElement('option');
    opt.value = lang;
    opt.textContent = lang;
    select.appendChild(opt);
  }
}

// ---------- App state ----------

const state = {
  languages: loadLanguages(),
  // Realtime session
  pc: null,            // RTCPeerConnection
  dc: null,            // RTCDataChannel
  micStream: null,
  micSender: null,
  sessionConfig: null, // { client_secret, model }
  connecting: false,

  // Per-turn UI tracking
  currentTurnEl: null,
  pendingResponseId: null,

  // Button state machine: 'idle' | 'holding' | 'recording' | 'committed'
  btnState: 'idle',
  pressStartedAt: 0,
  pressTimer: null,
  turnStartedAt: 0,
  timerInterval: null,
};

function loadLanguages() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.languageA && parsed?.languageB && parsed.languageA !== parsed.languageB) {
      return parsed;
    }
  } catch {}
  return null;
}

function saveLanguages(languageA, languageB) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ languageA, languageB }));
  state.languages = { languageA, languageB };
  updateLangLabel();
}

function updateLangLabel() {
  if (!state.languages) {
    el.langPairLabel.textContent = '— ↔ —';
  } else {
    el.langPairLabel.textContent = `${state.languages.languageA} ↔ ${state.languages.languageB}`;
  }
}

// ---------- Language picker modal ----------

function openPicker(initial = false) {
  if (state.languages) {
    el.langA.value = state.languages.languageA;
    el.langB.value = state.languages.languageB;
  } else {
    el.langA.value = 'English';
    el.langB.value = 'Spanish';
  }
  el.pickerCancel.hidden = initial;
  el.picker.hidden = false;
}

function closePicker() {
  el.picker.hidden = true;
}

el.settingsBtn.addEventListener('click', () => openPicker(false));
el.pickerCancel.addEventListener('click', closePicker);
el.pickerSave.addEventListener('click', async () => {
  const a = el.langA.value;
  const b = el.langB.value;
  if (a === b) {
    showToast('Pick two different languages', true);
    return;
  }
  const changed =
    !state.languages || state.languages.languageA !== a || state.languages.languageB !== b;
  saveLanguages(a, b);
  closePicker();
  if (changed) {
    // Tear down so a new session is created with new instructions
    teardownSession();
  }
});

// ---------- Toast ----------

let toastTimer = null;
function showToast(message, isError = false) {
  el.toast.textContent = message;
  el.toast.classList.toggle('error', isError);
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 3500);
}

// ---------- Realtime session (WebRTC to OpenAI) ----------

async function ensureSession() {
  if (state.pc && state.dc?.readyState === 'open') return;
  if (state.connecting) {
    // Wait until the in-flight connect resolves
    while (state.connecting) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (state.pc && state.dc?.readyState === 'open') return;
  }
  state.connecting = true;
  setStatus('Connecting…');

  try {
    // 1. Get ephemeral token from our backend.
    const tokenResp = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        languageA: state.languages.languageA,
        languageB: state.languages.languageB,
      }),
    });
    if (!tokenResp.ok) {
      const text = await tokenResp.text();
      throw new Error(`Failed to get session token: ${tokenResp.status} ${text}`);
    }
    const { client_secret, model } = await tokenResp.json();
    state.sessionConfig = { client_secret, model };

    // 2. Get the mic (lazy — first time only).
    if (!state.micStream) {
      state.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    }

    // 3. Open RTCPeerConnection + data channel + audio track.
    const pc = new RTCPeerConnection();
    state.pc = pc;

    pc.ontrack = (e) => {
      el.remoteAudio.srcObject = e.streams[0];
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        teardownSession();
      }
    };

    const dc = pc.createDataChannel('oai-events');
    state.dc = dc;
    dc.onmessage = (evt) => handleRealtimeEvent(JSON.parse(evt.data));
    dc.onclose = () => {
      if (state.dc === dc) state.dc = null;
    };

    state.micSender = pc.addTrack(state.micStream.getAudioTracks()[0], state.micStream);

    // 4. SDP offer/answer dance.
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdpResp = await fetch(
      `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(model)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${client_secret}`,
          'Content-Type': 'application/sdp',
        },
        body: offer.sdp,
      }
    );
    if (!sdpResp.ok) {
      const text = await sdpResp.text();
      throw new Error(`Realtime SDP exchange failed: ${sdpResp.status} ${text}`);
    }
    const answerSdp = await sdpResp.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    // Wait for the data channel to open
    await new Promise((resolve, reject) => {
      if (dc.readyState === 'open') return resolve();
      dc.onopen = resolve;
      setTimeout(() => reject(new Error('Data channel open timed out')), 8000);
    });

    setStatus('Tap or hold to translate');
  } catch (err) {
    console.error(err);
    teardownSession();
    showToast(err.message || 'Failed to connect', true);
    setStatus('Tap or hold to translate');
    throw err;
  } finally {
    state.connecting = false;
  }
}

function teardownSession() {
  try {
    state.dc?.close();
  } catch {}
  try {
    state.pc?.close();
  } catch {}
  state.dc = null;
  state.pc = null;
  state.micSender = null;
  setMicEnabled(false);
}

function setMicEnabled(enabled) {
  if (!state.micStream) return;
  for (const track of state.micStream.getAudioTracks()) {
    track.enabled = enabled;
  }
}

function sendEvent(event) {
  if (state.dc?.readyState === 'open') {
    state.dc.send(JSON.stringify(event));
  } else {
    console.warn('Tried to send event with closed data channel:', event);
  }
}

// ---------- Button state machine ----------

function setStatus(text) {
  el.status.textContent = text;
}

function setButtonState(s) {
  state.btnState = s;
  el.talkBtn.dataset.state =
    s === 'recording' ? 'recording'
      : s === 'committed' ? 'processing'
      : s === 'playing' ? 'playing'
      : '';
}

function startRecordingUI() {
  setButtonState('recording');
  setStatus('Listening…');
  state.turnStartedAt = performance.now();
  el.timer.hidden = false;
  el.timer.textContent = '0.0s';
  state.timerInterval = setInterval(() => {
    const s = (performance.now() - state.turnStartedAt) / 1000;
    el.timer.textContent = `${s.toFixed(1)}s`;
  }, 100);
  // Create a placeholder turn that we'll fill in as data comes back.
  state.currentTurnEl = appendTurnPlaceholder();
}

function stopRecordingUI() {
  el.timer.hidden = true;
  clearInterval(state.timerInterval);
  state.timerInterval = null;
}

async function beginPress() {
  if (!state.languages) {
    openPicker(true);
    return;
  }
  if (state.btnState === 'committed') {
    // Mid-response — ignore further presses.
    return;
  }
  if (state.btnState === 'recording') {
    // Click-toggle stop path (handled in onPointerUp); ignore re-press here.
    return;
  }

  state.pressStartedAt = performance.now();

  try {
    await ensureSession();
  } catch {
    return;
  }

  // Start sending audio.
  setMicEnabled(true);
  startRecordingUI();
  setButtonState('recording');
}

function endPress() {
  if (state.btnState !== 'recording') return;
  const heldFor = performance.now() - state.pressStartedAt;
  if (heldFor < HOLD_THRESHOLD_MS) {
    // Treat as a tap that toggled recording on — stay recording until next tap.
    setStatus('Recording — tap again when done');
    return;
  }
  commitTurn();
}

function tapToggleStop() {
  if (state.btnState !== 'recording') return;
  commitTurn();
}

function commitTurn() {
  const duration = performance.now() - state.turnStartedAt;
  stopRecordingUI();
  setMicEnabled(false);

  if (duration < 350) {
    // Too short to be real speech; bail out without sending a response request.
    setButtonState('idle');
    setStatus('Too short — try again');
    if (state.currentTurnEl) {
      state.currentTurnEl.remove();
      state.currentTurnEl = null;
    }
    sendEvent({ type: 'input_audio_buffer.clear' });
    return;
  }

  setButtonState('committed');
  setStatus('Translating…');

  sendEvent({ type: 'input_audio_buffer.commit' });
  sendEvent({
    type: 'response.create',
    response: {
      modalities: ['audio', 'text'],
    },
  });
}

// Pointer events handle mouse, touch, and pen uniformly.
el.talkBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (state.btnState === 'recording') {
    // Pointer-down while already recording = the user is clicking to stop.
    tapToggleStop();
  } else {
    beginPress();
  }
});

el.talkBtn.addEventListener('pointerup', (e) => {
  e.preventDefault();
  endPress();
});

el.talkBtn.addEventListener('pointercancel', () => {
  if (state.btnState === 'recording') {
    // Abandon the turn without sending.
    stopRecordingUI();
    setMicEnabled(false);
    if (state.currentTurnEl) {
      state.currentTurnEl.remove();
      state.currentTurnEl = null;
    }
    sendEvent({ type: 'input_audio_buffer.clear' });
    setButtonState('idle');
    setStatus('Tap or hold to translate');
  }
});

// Spacebar = press-to-talk for keyboard users.
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && !isTextInputFocused()) {
    e.preventDefault();
    beginPress();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && !isTextInputFocused()) {
    e.preventDefault();
    endPress();
  }
});

function isTextInputFocused() {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT');
}

// ---------- Transcript rendering ----------

function appendTurnPlaceholder() {
  const wrap = document.createElement('div');
  wrap.className = 'turn placeholder';
  wrap.innerHTML = `
    <div class="meta"><span>Turn</span><span class="meta-state">recording…</span></div>
    <div class="src" data-src>…</div>
    <div class="dst" data-dst>…</div>
  `;
  el.transcript.appendChild(wrap);
  wrap.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return wrap;
}

function setTurnSource(turnEl, text) {
  if (!turnEl) return;
  const node = turnEl.querySelector('[data-src]');
  if (node) node.textContent = text || '…';
}

function appendTurnTranslationDelta(turnEl, delta) {
  if (!turnEl) return;
  turnEl.classList.remove('placeholder');
  const node = turnEl.querySelector('[data-dst]');
  if (!node) return;
  if (node.textContent === '…') node.textContent = '';
  node.textContent += delta;
}

function setTurnMeta(turnEl, text) {
  if (!turnEl) return;
  const node = turnEl.querySelector('.meta-state');
  if (node) node.textContent = text;
}

// ---------- Realtime event handling ----------

function handleRealtimeEvent(event) {
  switch (event.type) {
    case 'conversation.item.input_audio_transcription.completed':
      setTurnSource(state.currentTurnEl, event.transcript);
      break;

    case 'conversation.item.input_audio_transcription.failed':
      setTurnSource(state.currentTurnEl, '(could not transcribe)');
      break;

    case 'response.created':
      state.pendingResponseId = event.response?.id || null;
      setTurnMeta(state.currentTurnEl, 'translating');
      break;

    case 'response.audio_transcript.delta':
      appendTurnTranslationDelta(state.currentTurnEl, event.delta || '');
      break;

    case 'response.audio_transcript.done':
      // Final translated text already accumulated via deltas.
      setTurnMeta(state.currentTurnEl, 'translated');
      break;

    case 'response.audio.delta':
      // Audio playback is handled by the WebRTC remote track; no work needed.
      setButtonState('playing');
      setStatus('Speaking…');
      break;

    case 'response.done':
      state.pendingResponseId = null;
      state.currentTurnEl = null;
      setButtonState('idle');
      setStatus('Tap or hold to translate');
      break;

    case 'error':
      console.error('Realtime error:', event);
      showToast(event.error?.message || 'Realtime error', true);
      setButtonState('idle');
      setStatus('Tap or hold to translate');
      break;

    default:
      // Useful while iterating; harmless in prod.
      // console.debug('event:', event.type, event);
      break;
  }
}

// ---------- Boot ----------

updateLangLabel();
if (!state.languages) {
  openPicker(true);
}
