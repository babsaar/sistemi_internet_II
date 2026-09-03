# Streaming video mobile → TouchDesigner

Trasforma un telefono qualsiasi in una **sorgente video wireless per
TouchDesigner**, tramite una pagina web e senza installare alcuna app.

Progetto d'esame per **Sistemi Internet e Mobile II**.

---

## Come funziona

Il telefono apre una pagina web (inquadrando un QR code), concede il permesso
alla fotocamera e trasmette il video via **WebRTC**. Un bridge sul computer
riceve il flusso e lo ripubblica come sorgente **NDI**, che TouchDesigner legge
nativamente con l'operatore *NDI In TOP*.

Il sistema è progettato per funzionare **anche da reti diverse**, non solo in
LAN: questo richiede signaling, attraversamento NAT e server TURN.

📖 **[Documentazione completa passo per passo →](DOCUMENTAZIONE.md)**

Documentazione tecnica in formato paper: [italiano](docs/documentazione_progetto_IT.pdf) · [inglese](docs/project_documentation_EN.pdf)

---

## Struttura

```
client/     Pagine statiche: client mobile + pagina QR (pubblicate su GitHub Pages)
server/     Signaling server Node.js (da pubblicare su un servizio di hosting)
docs/       Documentazione tecnica in PDF
```

---

## Avvio rapido in locale

**1. Signaling server**

```bash
cd server
npm install
npm start          # in ascolto sulla porta 8080
npm test           # in un secondo terminale: 14 controlli automatici
```

**2. Client**

```bash
cd client
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout certs/dev-key.pem -out certs/dev-cert.pem \
  -days 365 -subj "/CN=localhost"
node serve-dev.js
```

Apri l'indirizzo stampato nel terminale, inquadra il QR con il telefono
(collegato alla stessa rete WiFi) e avvia la trasmissione.

> Il certificato autofirmato è necessario perché i browser mobile negano
> l'accesso alla fotocamera su connessioni non sicure. Pubblicando su GitHub
> Pages il problema non si pone.

---

## Stato

| Componente | Stato |
|---|---|
| Client web mobile | ✅ Completato |
| Pagina QR | ✅ Completata |
| Signaling server | ✅ Completato e testato |
| Server STUN/TURN | ⬜ Da configurare |
| Bridge WebRTC → NDI | ⬜ Da sviluppare |

---

## Licenza

MIT. Include [QRCode.js](https://github.com/davidshimjs/qrcodejs) (MIT).
