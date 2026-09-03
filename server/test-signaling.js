/**
 * Verifica il signaling server simulando i due peer.
 * Uso: avviare il server, poi `node test-signaling.js`
 */

const WebSocket = require("ws");

const URL = process.env.URL || "ws://localhost:8080/ws";
let failures = 0;

function check(label, condition) {
  console.log(`${condition ? "  OK  " : " FAIL "} ${label}`);
  if (!condition) failures++;
}

function connect() {
  const ws = new WebSocket(URL);
  ws.received = [];
  ws.on("message", (raw) => ws.received.push(JSON.parse(raw)));
  return new Promise((resolve) => ws.on("open", () => resolve(ws)));
}

const send = (ws, msg) => ws.send(JSON.stringify(msg));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const seen = (ws, type) => ws.received.some(m => m.type === type);
const find = (ws, type) => ws.received.find(m => m.type === type);

async function main() {
  console.log("\n--- Caso 1: il bridge si collega per secondo (offerta in coda) ---");
  const client = await connect();
  send(client, { type: "join", room: "1234", role: "client" });
  await wait(120);
  check("il client riceve la conferma di join", seen(client, "joined"));
  check("nessun peer presente all'inizio", find(client, "joined").peerPresent === false);

  // Il client invia l'offerta subito, prima che il bridge esista:
  // il server deve metterla in coda e non perderla.
  send(client, { type: "offer", room: "1234", sdp: { type: "offer", sdp: "FINTA-OFFERTA" } });
  await wait(120);

  const bridge = await connect();
  send(bridge, { type: "join", room: "1234", role: "bridge" });
  await wait(250);

  check("il bridge riceve l'offerta messa in coda", seen(bridge, "offer"));
  check("l'SDP arriva integro", find(bridge, "offer")?.sdp?.sdp === "FINTA-OFFERTA");
  check("il client è avvisato dell'arrivo del bridge", seen(client, "peer-joined"));
  check("il bridge vede il peer già presente", find(bridge, "joined").peerPresent === true);

  console.log("\n--- Caso 2: inoltro di risposta e candidati ICE ---");
  send(bridge, { type: "answer", room: "1234", sdp: { type: "answer", sdp: "FINTA-RISPOSTA" } });
  send(bridge, { type: "candidate", room: "1234", candidate: { candidate: "cand-bridge" } });
  send(client, { type: "candidate", room: "1234", candidate: { candidate: "cand-client" } });
  await wait(250);

  check("il client riceve la risposta", find(client, "answer")?.sdp?.sdp === "FINTA-RISPOSTA");
  check("il client riceve il candidato del bridge", find(client, "candidate")?.candidate?.candidate === "cand-bridge");
  check("il bridge riceve il candidato del client", find(bridge, "candidate")?.candidate?.candidate === "cand-client");

  console.log("\n--- Caso 3: isolamento tra stanze diverse ---");
  const intruso = await connect();
  send(intruso, { type: "join", room: "9999", role: "client" });
  await wait(120);
  send(intruso, { type: "offer", room: "9999", sdp: { type: "offer", sdp: "ALTRA-STANZA" } });
  await wait(250);

  const offerteAlBridge = bridge.received.filter(m => m.type === "offer");
  check("l'offerta di un'altra stanza non raggiunge il bridge",
        offerteAlBridge.every(m => m.sdp.sdp !== "ALTRA-STANZA"));

  console.log("\n--- Caso 4: notifica di disconnessione ---");
  client.close();
  await wait(250);
  check("il bridge è avvisato dell'uscita del client", seen(bridge, "peer-left"));

  console.log("\n--- Caso 5: messaggi non validi ---");
  const grezzo = await connect();
  grezzo.send("questo non è JSON");
  await wait(120);
  check("il JSON non valido produce un errore", seen(grezzo, "error"));

  const senzaJoin = await connect();
  send(senzaJoin, { type: "offer", room: "1234", sdp: {} });
  await wait(120);
  check("un'offerta senza join precedente è respinta", seen(senzaJoin, "error"));

  const senzaStanza = await connect();
  send(senzaStanza, { type: "join", role: "client" });
  await wait(120);
  check("un join senza stanza è respinto", seen(senzaStanza, "error"));

  for (const ws of [bridge, intruso, grezzo, senzaJoin, senzaStanza]) ws.close();
  await wait(200);

  console.log(failures === 0
    ? "\nTutti i controlli superati.\n"
    : `\n${failures} controlli falliti.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
