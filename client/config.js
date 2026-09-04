// Configurazione del client — adattare questi valori al proprio ambiente
// prima del deploy in produzione.
const APP_CONFIG = {
  // Indirizzo del signaling server. In produzione deve essere wss:// (WebSocket sicuro).
  // Se non specificato, viene derivato automaticamente dall'host corrente
  // (utile quando client e signaling server sono serviti dallo stesso dominio).
  signalingUrl:"wss://signaling-jesse-sistemi.onrender.com/ws"
  //wss://mio-dominio.example/ws"

  // Identificativo di stanza/sessione di default: permette al signaling server
  // di instradare correttamente offerta/risposta verso il bridge corretto,
  // utile se più client si collegano contemporaneamente.
  // Viene sovrascritto automaticamente se il client è aperto tramite il QR
  // generato da host.html (parametro ?room= nell'URL).
  roomId: "default",

  // Server STUN/TURN per l'attraversamento NAT (vedi sezione 2.3/4.3 della documentazione).
  // Sostituire con le proprie credenziali TURN in produzione.
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    // { urls: "turn:mio-turn.example:3478", username: "utente", credential: "password" },
  ],

  // Vincoli di cattura video: risoluzione massima e frame rate,
  // per contenere banda e latenza su rete mobile.
  videoConstraints: {
    width: { ideal: 1280, max: 1920 },
    height: { ideal: 720, max: 1080 },
    frameRate: { ideal: 30, max: 30 },
  },
};
