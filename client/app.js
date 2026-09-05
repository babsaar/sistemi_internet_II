/**
 * Client web mobile — cattura la fotocamera e la invia via WebRTC
 * al bridge WebRTC→NDI, attraverso il signaling server.
 *
 * L'avvio è diviso in due fasi indipendenti: se la connessione di rete
 * fallisce, la fotocamera resta attiva e l'anteprima continua a funzionare,
 * così è evidente che il problema è la rete e non il dispositivo.
 *
 * Protocollo di signaling (JSON su WebSocket):
 *   → { type: "join",      room, role }
 *   → { type: "offer",     room, sdp }
 *   → { type: "candidate", room, candidate }
 *   ← { type: "joined",    room, role, peerPresent }
 *   ← { type: "peer-joined" }
 *   ← { type: "answer",    sdp }
 *   ← { type: "candidate", candidate }
 *   ← { type: "peer-left" }
 *   ← { type: "error",     message }
 */

const els = {
  status: document.getElementById("status"),
  statusLabel: document.getElementById("statusLabel"),
  preview: document.getElementById("preview"),
  viewfinder: document.getElementById("viewfinder"),
  tallyBtn: document.getElementById("tallyBtn"),
  tallyLabel: document.getElementById("tallyLabel"),
  switchBtn: document.getElementById("switchBtn"),
  roomLabel: document.getElementById("roomLabel"),
  quality: document.getElementById("quality"),
  statsReadout: document.getElementById("statsReadout"),
  logOutput: document.getElementById("logOutput"),
};

let ws = null;
let pc = null;
// Server ICE consegnati dal signaling server al momento del join.
// Tenerli lì invece che in config.js evita di pubblicare le credenziali
// TURN in un repository statico e pubblico.
let serverIceServers = null;
let onJoined = null;
let wakeLock = null;
let statsTimer = null;
let reconnectAttempts = 0;
let currentQuality = null;
let localStream = null;
let currentFacingMode = "environment";
let isStopping = false;
let isLive = false;

// La stanza può arrivare da un QR code (?room=1234, vedi host.html):
// se presente in URL, sovrascrive il valore di default in config.js.
const roomId = new URLSearchParams(location.search).get("room") || APP_CONFIG.roomId;
els.roomLabel.textContent = roomId;

currentQuality = APP_CONFIG.defaultQuality || "medium";
for (const btn of document.querySelectorAll("#quality button")) {
  btn.classList.toggle("is-active", btn.dataset.preset === currentQuality);
}

function log(...args) {
  const line = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  console.log("[client]", line);
  els.logOutput.textContent += line + "\n";
  els.logOutput.scrollTop = els.logOutput.scrollHeight;
}

function setStatus(state, label) {
  els.status.dataset.state = state;
  els.statusLabel.textContent = label;
}

function resolveSignalingUrl() {
  if (APP_CONFIG.signalingUrl) return APP_CONFIG.signalingUrl;

  // Senza signalingUrl esplicito l'indirizzo viene dedotto dall'host corrente.
  // Ha senso solo in sviluppo locale: su un hosting statico (GitHub Pages)
  // non esiste alcun WebSocket da contattare, quindi conviene dirlo subito
  // invece di lasciar fallire la connessione con un errore generico.
  const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname) ||
                  /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(location.hostname);

  if (!isLocal) {
    const err = new Error("Signaling server non configurato");
    err.code = "SIGNALING_NOT_CONFIGURED";
    throw err;
  }

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

/**
 * Aggiorna l'anteprima in base alla fotocamera in uso: quella frontale
 * viene mostrata specchiata (vedi style.css). Non altera il flusso inviato.
 */
function updateFacingIndicator() {
  els.viewfinder.dataset.facing = currentFacingMode;
}

/**
 * Adatta il mirino alle proporzioni reali del fotogramma catturato.
 * Con proporzioni fisse l'anteprima ritaglierebbe l'immagine, mostrando
 * qualcosa di diverso da ciò che viene effettivamente trasmesso.
 */
function matchViewfinderToVideo() {
  const { videoWidth: w, videoHeight: h } = els.preview;
  if (w && h) els.viewfinder.style.aspectRatio = `${w} / ${h}`;
}

/**
 * Legge periodicamente le statistiche della connessione.
 * Servono a capire cosa succede prima di una caduta: un calo del bitrate
 * indica congestione, la perdita di pacchetti una rete instabile, un
 * bitrate che va a zero una sospensione della pagina.
 */
function startStats() {
  stopStats();
  let lastBytes = 0;
  let lastAt = 0;

  statsTimer = setInterval(async () => {
    if (!pc) return;
    const report = await pc.getStats();
    let bytes = 0, lost = 0, w = 0, h = 0, fps = 0;

    report.forEach(entry => {
      if (entry.type === "outbound-rtp" && entry.kind === "video") {
        bytes = entry.bytesSent || 0;
        w = entry.frameWidth || 0;
        h = entry.frameHeight || 0;
        fps = entry.framesPerSecond || 0;
      }
      if (entry.type === "remote-inbound-rtp" && entry.kind === "video") {
        lost = entry.packetsLost || 0;
      }
    });

    const now = Date.now();
    if (lastAt) {
      const kbps = Math.round(((bytes - lastBytes) * 8) / (now - lastAt));
      els.statsReadout.textContent = `${w}×${h} · ${Math.round(fps)}fps · ${kbps} kbps`;
      if (kbps === 0) log("Nessun dato inviato nell'ultimo intervallo.");
      if (lost > 0) log(`Pacchetti persi finora: ${lost}`);
    }
    lastBytes = bytes;
    lastAt = now;
  }, 5000);
}

function stopStats() {
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
  els.statsReadout.textContent = "—";
}

/**
 * Ripristina la connessione senza rifare tutto da capo.
 * Un ICE restart rinegozia solo il percorso di rete mantenendo la
 * fotocamera attiva e la sessione aperta: è il rimedio corretto quando
 * si cambia rete o il percorso corrente smette di funzionare.
 */
async function restartIce() {
  if (!pc || isStopping) return;

  if (reconnectAttempts >= APP_CONFIG.maxReconnectAttempts) {
    log("Tentativi di ripristino esauriti.");
    setStatus("error", "connessione persa");
    return;
  }

  reconnectAttempts += 1;
  const delay = Math.min(1000 * 2 ** (reconnectAttempts - 1), 8000);
  log(`Tentativo di ripristino ${reconnectAttempts} fra ${delay} ms…`);
  setStatus("connecting", "ripristino connessione…");

  await new Promise(r => setTimeout(r, delay));
  if (!pc || isStopping) return;

  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    send({ type: "offer", room: roomId, sdp: offer });
    log("Nuova offerta inviata per il ripristino.");
  } catch (err) {
    log("Ripristino fallito:", err.message);
  }
}

function setLive(live) {
  isLive = live;
  els.tallyBtn.dataset.live = String(live);
  els.tallyLabel.textContent = live ? "INTERROMPI" : "AVVIA";
}

async function toggle() {
  if (isLive) {
    stop();
  } else {
    await start();
  }
}

async function start() {
  els.tallyBtn.disabled = true;
  isStopping = false;

  // Fase 1 — fotocamera. Se fallisce qui, non c'è niente da trasmettere.
  try {
    setStatus("connecting", "accesso alla fotocamera…");
    localStream = await openCamera(currentFacingMode);
    els.preview.srcObject = localStream;
    els.viewfinder.classList.add("is-active");
    updateFacingIndicator();
    setLive(true);
    startStats();
    acquireWakeLock();
    els.switchBtn.hidden = false;
    log("Fotocamera attiva:", describeTrack(localStream));
  } catch (err) {
    log("Errore fotocamera:", err.name || "", err.message || String(err));
    setStatus("error", cameraError(err));
    cleanup();
    els.tallyBtn.disabled = false;
    return;
  } finally {
    els.tallyBtn.disabled = false;
  }

  // Fase 2 — connessione. Un fallimento qui NON deve spegnere la fotocamera:
  // l'anteprima resta attiva e l'utente vede che la cattura funziona,
  // mentre lo stato segnala il problema di connessione.
  try {
    setStatus("connecting", "connessione al signaling…");
    await connectSignaling();
    await createPeerConnectionAndOffer();
  } catch (err) {
    if (err.code === "SIGNALING_NOT_CONFIGURED") {
      log("La fotocamera funziona regolarmente.");
      log("Manca però l'indirizzo del signaling server: impostare");
      log("signalingUrl in config.js (es. wss://mio-signaling.onrender.com/ws).");
      setStatus("error", "signaling non configurato");
    } else {
      log("Errore di connessione:", err.message || String(err));
      setStatus("error", "signaling non raggiungibile");
    }
    closeConnection();
  }
}

function describeTrack(stream) {
  const s = stream.getVideoTracks()[0]?.getSettings?.() || {};
  return `${s.width || "?"}×${s.height || "?"} @ ${s.frameRate || "?"}fps`;
}

function cameraError(err) {
  switch (err && err.name) {
    case "NotAllowedError":
      return "permesso fotocamera negato";
    case "NotFoundError":
      return "nessuna fotocamera trovata";
    case "NotReadableError":
      return "fotocamera occupata da un'altra app";
    case "OverconstrainedError":
      return "risoluzione non supportata";
    default:
      return "errore fotocamera";
  }
}

function qualityConstraints() {
  return APP_CONFIG.qualityPresets[currentQuality] || {};
}

async function openCamera(facingMode) {
  const constraints = {
    audio: false,
    video: { ...qualityConstraints(), facingMode: { ideal: facingMode } },
  };
  return navigator.mediaDevices.getUserMedia(constraints);
}

/**
 * Cambia risoluzione senza rinegoziare: applyConstraints agisce sulla
 * traccia già in uso, quindi la connessione WebRTC resta attiva.
 */
async function applyQuality(preset) {
  currentQuality = preset;
  for (const btn of els.quality.querySelectorAll("button")) {
    btn.classList.toggle("is-active", btn.dataset.preset === preset);
  }

  const track = localStream && localStream.getVideoTracks()[0];
  if (!track) return;

  try {
    await track.applyConstraints(qualityConstraints());
    const s = track.getSettings();
    log(`Qualità impostata su ${preset}: ${s.width}x${s.height}`);
    matchViewfinderToVideo();
  } catch (err) {
    log("Cambio di qualità rifiutato dal dispositivo:", err.message);
  }
}

/**
 * Impedisce il blocco automatico dello schermo durante la trasmissione.
 * Senza, il sistema sospende la pagina dopo pochi minuti e il flusso
 * si interrompe: è la causa più comune di cadute a intervallo regolare.
 */
async function acquireWakeLock() {
  if (!APP_CONFIG.keepScreenAwake || !("wakeLock" in navigator)) {
    if (APP_CONFIG.keepScreenAwake) {
      log("Wake Lock non supportato: lo schermo potrebbe spegnersi e interrompere il flusso.");
    }
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    log("Schermo mantenuto acceso durante la trasmissione.");
    wakeLock.addEventListener("release", () => log("Wake Lock rilasciato."));
  } catch (err) {
    log("Wake Lock non ottenuto:", err.message);
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

function connectSignaling() {
  return new Promise((resolve, reject) => {
    const url = resolveSignalingUrl();
    log("Connessione al signaling server:", url);
    ws = new WebSocket(url);

    let opened = false;

    // La promessa si risolve alla conferma di join, non all'apertura del
    // socket: il messaggio "joined" può contenere i server ICE, che servono
    // prima di creare la RTCPeerConnection.
    const timer = setTimeout(
      () => reject(new Error("Il signaling server non ha confermato l'ingresso")), 15000);

    onJoined = () => { clearTimeout(timer); resolve(); };

    ws.onopen = () => {
      opened = true;
      send({ type: "join", room: roomId, role: "client" });
    };

    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Impossibile raggiungere il signaling server"));
    };

    ws.onclose = () => {
      // Solo una connessione che era stata stabilita può dirsi "persa":
      // altrimenti il messaggio sovrascriverebbe l'errore più preciso
      // già mostrato da chi ha chiamato questa funzione.
      if (!isStopping && opened) {
        log("Connessione al signaling server chiusa inaspettatamente");
        setStatus("error", "connessione persa");
      }
    };

    ws.onmessage = (event) => handleSignalingMessage(JSON.parse(event.data));
  });
}

function send(message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

async function createPeerConnectionAndOffer() {
  // I server consegnati dal signaling hanno la precedenza su config.js.
  const iceServers = serverIceServers || APP_CONFIG.iceServers;
  pc = new RTCPeerConnection({ iceServers });

  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      send({ type: "candidate", room: roomId, candidate: event.candidate });
    }
  };

  pc.oniceconnectionstatechange = () => {
    const state = pc.iceConnectionState;
    log("Stato connessione ICE:", state);

    if (state === "connected" || state === "completed") {
      reconnectAttempts = 0;          // il percorso funziona: azzera i tentativi
      setStatus("connected", "in diretta");
    } else if (state === "disconnected") {
      // Spesso transitorio: WebRTC può recuperare da solo. Si concede
      // qualche secondo prima di forzare un ripristino.
      setStatus("connecting", "connessione instabile…");
      setTimeout(() => {
        if (pc && pc.iceConnectionState === "disconnected") restartIce();
      }, 4000);
    } else if (state === "failed") {
      restartIce();
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ type: "offer", room: roomId, sdp: offer });
  log("Offerta SDP inviata, in attesa del bridge…");
}

async function handleSignalingMessage(msg) {
  switch (msg.type) {
    case "joined":
      log(`Stanza ${msg.room} — bridge già presente: ${msg.peerPresent ? "sì" : "no"}`);
      if (Array.isArray(msg.iceServers) && msg.iceServers.length) {
        serverIceServers = msg.iceServers;
        log(`Server ICE ricevuti dal signaling: ${msg.iceServers.length}`);
      }
      if (!msg.peerPresent) setStatus("connecting", "in attesa del bridge…");
      if (onJoined) { onJoined(); onJoined = null; }
      break;
    case "peer-joined":
      log("Il bridge si è collegato");
      break;
    case "answer":
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      log("Risposta SDP ricevuta dal bridge");
      break;
    case "candidate":
      try {
        await pc.addIceCandidate(msg.candidate);
      } catch (err) {
        log("Candidato ICE scartato:", err.message);
      }
      break;
    case "peer-left":
      log("Il bridge si è disconnesso");
      setStatus("error", "bridge disconnesso");
      break;
    case "error":
      log("Errore dal signaling server:", msg.message);
      setStatus("error", msg.message.toLowerCase());
      break;
    default:
      log("Messaggio di signaling non gestito:", msg.type);
  }
}

async function switchCamera() {
  currentFacingMode = currentFacingMode === "environment" ? "user" : "environment";
  log("Cambio fotocamera:", currentFacingMode);

  const oldTrack = localStream.getVideoTracks()[0];
  const newStream = await openCamera(currentFacingMode);
  const newTrack = newStream.getVideoTracks()[0];

  const sender = pc && pc.getSenders().find(s => s.track && s.track.kind === "video");
  if (sender) await sender.replaceTrack(newTrack);

  oldTrack.stop();
  localStream.removeTrack(oldTrack);
  localStream.addTrack(newTrack);
  els.preview.srcObject = localStream;
  updateFacingIndicator();
}

function stop() {
  isStopping = true;
  reconnectAttempts = 0;
  stopStats();
  releaseWakeLock();
  cleanup();
  setLive(false);
  setStatus("idle", "non connesso");
  els.switchBtn.hidden = true;
  els.viewfinder.classList.remove("is-active");
  delete els.viewfinder.dataset.facing;
  els.viewfinder.style.removeProperty("aspect-ratio");
}

/** Chiude solo la parte di rete, lasciando la fotocamera attiva. */
function closeConnection() {
  if (pc) {
    pc.close();
    pc = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
}

function cleanup() {
  closeConnection();
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
}

els.preview.addEventListener("loadedmetadata", matchViewfinderToVideo);
els.preview.addEventListener("resize", matchViewfinderToVideo);

// iOS rilascia il wake lock quando la pagina passa in secondo piano:
// va richiesto di nuovo al ritorno, altrimenti lo schermo torna a spegnersi.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && isLive && !wakeLock) {
    acquireWakeLock();
  }
});

els.quality.addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-preset]");
  if (btn) applyQuality(btn.dataset.preset).catch(err => log("Errore:", err.message));
});

els.tallyBtn.addEventListener("click", () => toggle().catch(err => log("Errore:", err.message)));
els.switchBtn.addEventListener("click", () => switchCamera().catch(err => log("Errore cambio camera:", err.message)));

window.addEventListener("beforeunload", () => { isStopping = true; cleanup(); });

if (!navigator.mediaDevices || !window.RTCPeerConnection) {
  setStatus("error", "browser non supportato");
  els.tallyBtn.disabled = true;
  log("Questo browser non supporta getUserMedia o WebRTC.");
}
