/**
 * Client web mobile — cattura la fotocamera e la invia via WebRTC
 * al bridge WebRTC→NDI, attraverso il signaling server.
 *
 * Protocollo di signaling (JSON su WebSocket):
 *   → { type: "join",      room }
 *   → { type: "offer",     room, sdp }
 *   → { type: "candidate", room, candidate }
 *   ← { type: "answer",    sdp }
 *   ← { type: "candidate", candidate }
 *   ← { type: "peer-left" }
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
  logOutput: document.getElementById("logOutput"),
};

let ws = null;
let pc = null;
let localStream = null;
let currentFacingMode = "environment";
let isStopping = false;
let isLive = false;

// La stanza può arrivare da un QR code (?room=1234, vedi host.html):
// se presente in URL, sovrascrive il valore di default in config.js.
const roomId = new URLSearchParams(location.search).get("room") || APP_CONFIG.roomId;
els.roomLabel.textContent = roomId;

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
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
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

  try {
    setStatus("connecting", "accesso alla fotocamera…");
    localStream = await openCamera(currentFacingMode);

    els.preview.srcObject = localStream;
    els.viewfinder.classList.add("is-active");

    setStatus("connecting", "connessione al signaling…");
    await connectSignaling();

    await createPeerConnectionAndOffer();

    setLive(true);
    els.switchBtn.hidden = false;
  } catch (err) {
    log("Errore in avvio:", err.message || String(err));
    setStatus("error", humanizeError(err));
    cleanup();
  } finally {
    els.tallyBtn.disabled = false;
  }
}

function humanizeError(err) {
  if (err && err.name === "NotAllowedError") return "permesso fotocamera negato";
  if (err && err.name === "NotFoundError") return "nessuna fotocamera trovata";
  return "errore di connessione";
}

async function openCamera(facingMode) {
  const constraints = {
    audio: false,
    video: { ...APP_CONFIG.videoConstraints, facingMode: { ideal: facingMode } },
  };
  return navigator.mediaDevices.getUserMedia(constraints);
}

function connectSignaling() {
  return new Promise((resolve, reject) => {
    const url = resolveSignalingUrl();
    log("Connessione al signaling server:", url);
    ws = new WebSocket(url);

    ws.onopen = () => {
      send({ type: "join", room: roomId, role: "client" });
      resolve();
    };

    ws.onerror = () => reject(new Error("Impossibile raggiungere il signaling server"));

    ws.onclose = () => {
      if (!isStopping) {
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
  pc = new RTCPeerConnection({ iceServers: APP_CONFIG.iceServers });

  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      send({ type: "candidate", room: roomId, candidate: event.candidate });
    }
  };

  pc.oniceconnectionstatechange = () => {
    log("Stato connessione ICE:", pc.iceConnectionState);
    if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
      setStatus("connected", "in diretta");
    } else if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
      setStatus("error", "connessione interrotta");
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
      if (!msg.peerPresent) setStatus("connecting", "in attesa del bridge…");
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
}

function stop() {
  isStopping = true;
  cleanup();
  setLive(false);
  setStatus("idle", "non connesso");
  els.switchBtn.hidden = true;
  els.viewfinder.classList.remove("is-active");
}

function cleanup() {
  if (pc) {
    pc.close();
    pc = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
}

els.tallyBtn.addEventListener("click", () => toggle().catch(err => log("Errore:", err.message)));
els.switchBtn.addEventListener("click", () => switchCamera().catch(err => log("Errore cambio camera:", err.message)));

window.addEventListener("beforeunload", () => { isStopping = true; cleanup(); });

if (!navigator.mediaDevices || !window.RTCPeerConnection) {
  setStatus("error", "browser non supportato");
  els.tallyBtn.disabled = true;
  log("Questo browser non supporta getUserMedia o WebRTC.");
}
