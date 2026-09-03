/**
 * Signaling server per lo streaming video mobile → TouchDesigner.
 *
 * Non elabora mai il flusso video: si limita a inoltrare i messaggi di
 * segnalazione (offerte/risposte SDP, candidati ICE) tra i due peer di una
 * stessa stanza, secondo il paradigma WebRTC.
 *
 * Ruoli in una stanza:
 *   - "client": il telefono, sorgente video (invia l'offerta)
 *   - "bridge": il servizio locale che converte in NDI (invia la risposta)
 *
 * Protocollo (JSON su WebSocket):
 *   → { type: "join",      room, role }
 *   → { type: "offer",     room, sdp }
 *   → { type: "answer",    room, sdp }
 *   → { type: "candidate", room, candidate }
 *   ← { type: "joined",    room, role, peerPresent }
 *   ← { type: "peer-joined" }
 *   ← { type: "peer-left" }
 *   ← { type: "error",     message }
 *   (offer/answer/candidate vengono recapitati all'altro peer così come sono)
 *
 * Variabili d'ambiente:
 *   PORT              porta di ascolto (impostata automaticamente da Render)
 *   ALLOWED_ORIGINS   elenco separato da virgole di origini ammesse;
 *                     se assente, ogni origine è accettata (solo per sviluppo)
 */

const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const HEARTBEAT_MS = 30000;   // intervallo dei ping di keep-alive
const MAX_QUEUE = 60;         // messaggi massimi in attesa per peer
const VALID_ROLES = ["client", "bridge"];
const RELAY_TYPES = ["offer", "answer", "candidate"];

/**
 * Stato in memoria: una stanza contiene al massimo un client e un bridge.
 * rooms: Map<roomId, { client: ws|null, bridge: ws|null,
 *                      queue: { client: [], bridge: [] } }>
 */
const rooms = new Map();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { client: null, bridge: null, queue: { client: [], bridge: [] } });
  }
  return rooms.get(roomId);
}

function otherRole(role) {
  return role === "client" ? "bridge" : "client";
}

function sendTo(ws, message) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
    return true;
  }
  return false;
}

/**
 * Recapita un messaggio all'altro peer della stanza. Se il destinatario non
 * è ancora collegato il messaggio viene messo in coda: il client invia
 * l'offerta subito dopo il join, quindi senza buffering andrebbe perduta
 * ogni volta che il bridge si collega per secondo.
 */
function relay(roomId, fromRole, message) {
  const room = getRoom(roomId);
  const targetRole = otherRole(fromRole);
  const target = room[targetRole];

  if (sendTo(target, message)) return;

  const queue = room.queue[targetRole];
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push(message);
  log(`stanza ${roomId}: ${message.type} in coda per ${targetRole} (${queue.length})`);
}

function flushQueue(roomId, role) {
  const room = getRoom(roomId);
  const queue = room.queue[role];
  if (!queue.length) return;

  log(`stanza ${roomId}: recapito ${queue.length} messaggi in coda a ${role}`);
  while (queue.length) sendTo(room[role], queue.shift());
}

function handleJoin(ws, msg) {
  const roomId = String(msg.room || "").trim();
  const role = msg.role || "client";

  if (!roomId) {
    return sendTo(ws, { type: "error", message: "Identificativo stanza mancante" });
  }
  if (!VALID_ROLES.includes(role)) {
    return sendTo(ws, { type: "error", message: `Ruolo non valido: ${role}` });
  }

  const room = getRoom(roomId);

  // Un solo peer per ruolo: il nuovo arrivato sostituisce il precedente,
  // così un telefono che ricarica la pagina non resta bloccato fuori.
  if (room[role] && room[role] !== ws) {
    log(`stanza ${roomId}: ${role} sostituito da una nuova connessione`);
    sendTo(room[role], { type: "error", message: "Sostituito da una nuova connessione" });
    room[role].close();
  }

  room[role] = ws;
  ws.roomId = roomId;
  ws.role = role;

  const peer = room[otherRole(role)];
  const peerPresent = !!(peer && peer.readyState === peer.OPEN);

  sendTo(ws, { type: "joined", room: roomId, role, peerPresent });
  if (peerPresent) sendTo(peer, { type: "peer-joined" });

  log(`stanza ${roomId}: ${role} collegato (altro peer presente: ${peerPresent})`);
  flushQueue(roomId, role);
}

function handleMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return sendTo(ws, { type: "error", message: "JSON non valido" });
  }

  if (msg.type === "join") return handleJoin(ws, msg);

  if (!ws.roomId) {
    return sendTo(ws, { type: "error", message: "Inviare prima un messaggio join" });
  }

  if (RELAY_TYPES.includes(msg.type)) {
    return relay(ws.roomId, ws.role, msg);
  }

  sendTo(ws, { type: "error", message: `Tipo di messaggio non gestito: ${msg.type}` });
}

function handleClose(ws) {
  if (!ws.roomId) return;

  const room = rooms.get(ws.roomId);
  if (!room) return;

  if (room[ws.role] === ws) room[ws.role] = null;

  const peer = room[otherRole(ws.role)];
  sendTo(peer, { type: "peer-left" });
  log(`stanza ${ws.roomId}: ${ws.role} disconnesso`);

  // Stanza vuota: liberiamo la memoria, code comprese.
  if (!room.client && !room.bridge) {
    rooms.delete(ws.roomId);
    log(`stanza ${ws.roomId}: rimossa`);
  }
}

// --- Server HTTP: health check e punto di aggancio del WebSocket ---

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      status: "ok",
      rooms: rooms.size,
      uptime: Math.round(process.uptime()),
    }));
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const origin = req.headers.origin;

  if (ALLOWED_ORIGINS.length && origin && !ALLOWED_ORIGINS.includes(origin)) {
    log(`connessione rifiutata, origine non ammessa: ${origin}`);
    sendTo(ws, { type: "error", message: "Origine non ammessa" });
    return ws.close();
  }

  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", (raw) => handleMessage(ws, raw));
  ws.on("close", () => handleClose(ws));
  ws.on("error", (err) => log("errore socket:", err.message));
});

// I proxy dei servizi di hosting chiudono le connessioni inattive:
// un ping periodico le mantiene aperte e individua i socket morti.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      log("connessione senza risposta, chiusura");
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, () => {
  log(`Signaling server in ascolto sulla porta ${PORT}`);
  log(`  health check:  http://localhost:${PORT}/health`);
  log(`  WebSocket:     ws://localhost:${PORT}/ws`);
  log(ALLOWED_ORIGINS.length
    ? `  origini ammesse: ${ALLOWED_ORIGINS.join(", ")}`
    : "  origini ammesse: tutte (impostare ALLOWED_ORIGINS in produzione)");
});

// Chiusura ordinata: i servizi di hosting inviano SIGTERM al riavvio.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    log(`ricevuto ${signal}, chiusura in corso`);
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.close(1001, "Server in arresto");
    server.close(() => process.exit(0));
  });
}
