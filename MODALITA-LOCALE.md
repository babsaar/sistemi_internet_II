# Modalità locale (solo rete locale)

In questa modalità il sistema funziona **senza Internet**: un unico server sul
tuo Mac serve sia le pagine del client sia il signaling, e il telefono si
collega direttamente via WiFi.

## Cosa cambia rispetto alla modalità online

| | Online | Locale |
|---|---|---|
| Pagine del client | GitHub Pages | Server locale |
| Signaling | Render | Stesso server locale |
| Certificato | Valido, nessun avviso | Autofirmato, avviso da accettare |
| Server TURN | Necessario per reti diverse | Non serve |
| Attesa al risveglio | Fino a un minuto | Nessuna |
| Telefono | Qualsiasi rete | Stessa WiFi del Mac |

Il vantaggio principale non è la velocità ma la **riduzione dei componenti**:
niente servizi esterni da svegliare, niente dipendenza dalla connessione
Internet, un solo processo da avviare.

---

## Preparazione (una volta sola)

### 1. Certificato

I browser mobile negano l'accesso alla fotocamera su connessioni non sicure,
quindi serve HTTPS anche in rete locale.

```bash
cd server
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout certs/dev-key.pem -out certs/dev-cert.pem \
  -days 365 -subj "/CN=localhost"
```

### 2. Configurazione del client

Nessuna modifica: `client/config.js` resta quello della modalità online.
Quando la pagina viene servita dal server del Mac, il client se ne accorge
(il server locale espone l'endpoint `/_lan`) e usa lo stesso server come
signaling, ignorando l'indirizzo di Render.

---

## Avvio

### 1. Server (pagine + signaling)

```bash
cd server
STATIC_DIR=../client \
TLS_CERT=certs/dev-cert.pem \
TLS_KEY=certs/dev-key.pem \
node signaling-server.js
```

Il terminale stampa gli indirizzi da usare, incluso quello di rete locale per
il telefono. Annotalo.

### 2. Bridge

In un secondo terminale, con il codice stanza mostrato dalla pagina QR:

```bash
cd bridge
source venv/bin/activate
python bridge.py --signaling wss://localhost:8080/ws --room XXXX --insecure --ndi-resolution 540x960
```

Come in modalità online, `--ndi-resolution` va fatto coincidere con la
qualità scelta sul telefono (540p → `540x960`).

L'opzione **`--insecure` è necessaria**: il certificato è autofirmato e, a
differenza del browser, Python non permette di accettarlo manualmente. È
accettabile perché il server è la tua stessa macchina in rete locale.

### 3. TouchDesigner

Crea un NDI In TOP e seleziona la sorgente `Camera Mobile`.

### 4. Telefono

Sulla **stessa rete WiFi** del Mac, inquadra il QR mostrato dalla pagina.
Accetta l'avviso sul certificato (su iOS Safari: *Mostra dettagli → Visita
questo sito web*), poi avvia la trasmissione.

---

## Prova senza telefono

```bash
python fake_client.py --signaling wss://localhost:8080/ws --room XXXX \
  --seconds 10 --insecure
```

---

## Problemi frequenti

| Sintomo | Causa | Soluzione |
|---|---|---|
| `CERTIFICATE_VERIFY_FAILED` nel bridge | Certificato autofirmato | Aggiungere `--insecure` |
| Il browser non chiede la fotocamera | Server avviato senza TLS | Impostare `TLS_CERT` e `TLS_KEY` |
| Il telefono non raggiunge il Mac | Isolamento client sulla rete WiFi | Usare l'hotspot del telefono e collegarci il Mac |
| Il telefono non raggiunge il Mac | Firewall di macOS | Consentire le connessioni in entrata per Node |
| Il QR contiene `localhost` | Pagina aperta su localhost | Il server espone `/_lan` e la pagina lo usa; verificare l'URL sotto il QR |
| Fotocamera ok ma "connessione persa" subito | Safari rifiuta il WebSocket col certificato autofirmato | Installare il certificato sul telefono come profilo e abilitarne l'attendibilità completa |

---

## Tornare alla modalità online

Non c'è niente da cambiare: basta aprire la pagina da GitHub Pages invece che
dal Mac e lanciare il bridge verso Render. Le due modalità condividono lo
stesso codice e lo stesso `config.js`: cambia solo da dove arriva la pagina.
