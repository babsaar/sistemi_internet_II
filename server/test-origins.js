/**
 * Verifica il filtro ALLOWED_ORIGINS.
 * Uso: ALLOWED_ORIGINS="https://esempio.github.io" node signaling-server.js
 *      poi: node test-origins.js
 */

const WebSocket = require("ws");

const bad = new WebSocket("ws://localhost:8080/ws", {
  origin: "https://sito-malevolo.example",
});

bad.on("message", (m) => console.log("  messaggio ricevuto:", m.toString()));

bad.on("close", () => {
  console.log("  OK   origine non ammessa: connessione chiusa dal server");

  const good = new WebSocket("ws://localhost:8080/ws", {
    origin: "https://esempio.github.io",
  });
  good.on("open", () => good.send(JSON.stringify({ type: "join", room: "1", role: "client" })));
  good.on("message", (m) => {
    const msg = JSON.parse(m);
    console.log(msg.type === "joined"
      ? "  OK   origine ammessa: join accettato"
      : "  FAIL risposta inattesa: " + m.toString());
    process.exit(msg.type === "joined" ? 0 : 1);
  });
  setTimeout(() => { console.log("  FAIL timeout"); process.exit(1); }, 3000);
});
