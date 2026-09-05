// Configurazione del client — adattare questi valori al proprio ambiente
// prima del deploy in produzione.
const APP_CONFIG = {
  // Indirizzo del signaling server. In produzione deve essere wss:// (WebSocket sicuro).
  // Se non specificato, viene derivato automaticamente dall'host corrente
  // (utile quando client e signaling server sono serviti dallo stesso dominio).
  signalingUrl: "wss://signaling-jesse-sistemi.onrender.com/ws", // es. "wss://mio-dominio.example/ws"

  // Identificativo di stanza/sessione di default: permette al signaling server
  // di instradare correttamente offerta/risposta verso il bridge corretto,
  // utile se più client si collegano contemporaneamente.
  // Viene sovrascritto automaticamente se il client è aperto tramite il QR
  // generato da host.html (parametro ?room= nell'URL).
  roomId: "default",

  // Server STUN/TURN di ripiego, usati solo se il signaling server non ne
  // consegna al momento del join. Non inserire qui credenziali TURN: questo
  // file è pubblicato su un repository statico e pubblico, quindi sarebbero
  // leggibili da chiunque. Le credenziali vanno nella variabile d'ambiente
  // ICE_SERVERS del signaling server.
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    // { urls: "turn:mio-turn.example:3478", username: "utente", credential: "password" },
  ],

  // Livelli di qualità selezionabili dall'interfaccia. Una risoluzione più
  // bassa richiede meno banda ed è più stabile su rete mobile.
  qualityPresets: {
    low:    { width: { ideal: 960 },  height: { ideal: 540 },  frameRate: { ideal: 30, max: 30 } },
    medium: { width: { ideal: 1280 }, height: { ideal: 720 },  frameRate: { ideal: 30, max: 30 } },
    high:   { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } },
  },

  // Livello usato all'avvio.
  defaultQuality: "medium",

  // Mantiene lo schermo acceso durante la trasmissione: senza, il blocco
  // automatico sospende la pagina e il flusso si interrompe.
  keepScreenAwake: true,

  // Tentativi di ripristino della connessione prima di arrendersi.
  maxReconnectAttempts: 5,
};
