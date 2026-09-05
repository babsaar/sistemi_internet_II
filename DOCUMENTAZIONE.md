# Streaming video mobile → TouchDesigner

Documentazione operativa del progetto.
Esame: **Sistemi Internet e Mobile II** — progetto individuale.

Questo documento descrive il progetto passaggio per passaggio: cosa fa, come è
costruito, come eseguirlo, cosa è già stato realizzato e cosa resta da fare.
È pensato per essere letto dall'inizio alla fine da chi non conosce il progetto.

---

## 1. Cosa fa il progetto

Permette a un **telefono qualsiasi**, tramite una semplice pagina web (senza
installare nessuna app), di inviare in tempo reale il video della propria
fotocamera dentro **TouchDesigner**, dove può essere manipolato con gli
strumenti nativi del software.

### Il problema che risolve

Normalmente una sorgente video in TouchDesigner deve essere collegata
fisicamente al computer (webcam USB, capture card). Questo limita l'uso in
contesti dove servirebbe una telecamera libera di muoversi: una performance,
un'installazione, una camera in mano a chi si muove sul palco.

### Il flusso dal punto di vista dell'utente

1. Su un monitor/laptop è aperta una pagina che mostra un **QR code** e un
   codice stanza di 4 cifre.
2. L'utente inquadra il QR con l'app Fotocamera del telefono e tocca il link
   che compare.
3. Si apre la pagina del client nel browser del telefono, già associata alla
   stanza corretta.
4. Il browser chiede il permesso di accedere alla fotocamera; l'utente lo
   concede.
5. L'utente tocca il pulsante rosso: il video parte e compare in TouchDesigner.

> **Nota importante sul QR code.** Il QR *non* serve a dare accesso alla
> fotocamera: serve solo ad aprire l'indirizzo giusto senza doverlo digitare a
> mano sul telefono. Il permesso della fotocamera viene chiesto dal browser
> dopo l'apertura della pagina, come sempre.

---

## 2. Architettura

Il sistema è composto da cinque parti. Il concetto centrale è la **separazione
tra canale di segnalazione e canale media**: i due peer si "presentano"
attraverso il signaling server, ma il video poi viaggia direttamente tra loro.

```
   TELEFONO                SIGNALING SERVER              TUO COMPUTER
  ┌──────────┐              ┌──────────────┐          ┌──────────────────┐
  │ Client   │─── join ────▶│  Stanze,     │◀── join ─│ Bridge           │
  │ web      │◀── SDP/ICE ─▶│  inoltro     │◀─SDP/ICE▶│ WebRTC → NDI     │
  │(fotocam.)│              │  messaggi    │          └────────┬─────────┘
  └────┬─────┘              └──────────────┘                   │ NDI
       │                                                       ▼
       │                   ┌──────────────┐          ┌──────────────────┐
       │                   │ STUN / TURN  │          │  TouchDesigner   │
       │                   │ (NAT)        │          │  (NDI In TOP)    │
       │                   └──────────────┘          └──────────────────┘
       │                                                       ▲
       └───────── flusso video WebRTC (diretto o via TURN) ────┘
```

### I cinque componenti

| Componente | Dove gira | Ruolo | Stato |
|---|---|---|---|
| **Client web** | Browser del telefono | Cattura la fotocamera e invia il video via WebRTC | ✅ Fatto |
| **Pagina QR (host)** | Browser di un laptop/monitor | Genera codice stanza e QR per collegare il telefono | ✅ Fatto |
| **Signaling server** | Servizio online (o locale) | Inoltra offerte/risposte SDP e candidati ICE tra i peer | ✅ Fatto |
| **STUN / TURN** | Server pubblico | Attraversamento NAT; fa da relay se la connessione diretta non è possibile | ⬜ Da configurare |
| **Bridge WebRTC → NDI** | Tuo computer, accanto a TD | Riceve il video WebRTC e lo ripubblica come sorgente NDI | ✅ Fatto |

### Perché serve un bridge

TouchDesigner non parla WebRTC. Parla però NDI, un protocollo video molto
diffuso in ambito broadcast/creativo, che TD legge nativamente con l'operatore
**NDI In TOP**. Il bridge fa da traduttore: si comporta come secondo peer
WebRTC, decodifica i frame ricevuti e li ripubblica come sorgente NDI sulla
rete locale.

Poiché NDI funziona solo in rete locale, il bridge **deve** stare sulla stessa
macchina (o rete) di TouchDesigner.

### Perché servono STUN e TURN

Quando telefono e computer non sono sulla stessa rete, la connessione diretta è
ostacolata da router e NAT. Il protocollo ICE usa:

- **STUN** per scoprire l'indirizzo pubblico di ciascun peer (basta per molti casi);
- **TURN** per fare da relay del traffico video quando la connessione diretta
  non si stabilisce comunque.

Con il telefono su rete dati e il computer dietro il NAT di casa o
dell'università, STUN da solo spesso non basta: **il TURN non è opzionale**.

---

## 3. Struttura dei file

```
progetto/
├── client/                     ← pagine statiche (pubblicabili su GitHub Pages)
│   ├── index.html              pagina del telefono (mirino + pulsante)
│   ├── host.html               pagina con il QR code
│   ├── style.css               stile di entrambe le pagine
│   ├── app.js                  logica del client: camera, WebRTC, signaling
│   ├── host.js                 generazione codice stanza e QR
│   ├── config.js               ⚙️ configurazione da adattare
│   ├── serve-dev.js            server HTTPS locale per le prove
│   └── vendor/
│       └── qrcode.min.js       libreria QR (MIT, inclusa localmente)
│
├── server/                     ← signaling server (pubblicato su Render)
│   ├── signaling-server.js     il server
│   ├── test-signaling.js       test automatici dell'inoltro messaggi
│   ├── test-origins.js         test del filtro sulle origini
│   └── package.json
│
└── bridge/                     ← bridge WebRTC → NDI (gira accanto a TouchDesigner)
    ├── bridge.py               il bridge
    ├── fake_client.py          telefono simulato, per le prove senza dispositivo
    ├── requirements-intel.txt  ⚙️ dipendenze per macOS Intel
    ├── requirements.txt        dipendenze per Apple Silicon / Windows / Linux
    └── README.md               guida all'installazione del bridge
```

---

## 4. Il client web (telefono)

### Come funziona

Usa due API standard del browser:

- **`getUserMedia`** per accedere alla fotocamera e ottenere il flusso video;
- **`RTCPeerConnection`** per instaurare la connessione WebRTC e inviare il flusso.

### Requisito fondamentale: HTTPS

I browser mobile **negano l'accesso alla fotocamera su connessioni non sicure**.
L'unica eccezione è `localhost`, che però non si applica quando il telefono
raggiunge il computer tramite indirizzo di rete locale.

Conseguenze pratiche:
- in rete locale serve un certificato (anche autofirmato, vedi §8);
- pubblicando su GitHub Pages il problema scompare, perché fornisce HTTPS valido.

### L'interfaccia

Estetica ispirata ai monitor di segnale da regia video:

- **Mirino** con angoli da viewfinder, che diventano verdi a stream attivo.
- **Tally button**: un unico pulsante circolare che passa da pallino rosso
  ("AVVIA") a quadrato con anello acceso ("INTERROMPI"), come le tally light
  degli studi televisivi.
- **Indicatore di stato** in alto a destra, in monospace: pallino grigio
  (inattivo), ambra (connessione in corso), verde pulsante (in diretta), rosso
  (errore).
- **Icona di inversione fotocamera** (anteriore/posteriore) sul mirino, visibile
  solo a stream attivo. Usa `replaceTrack`, quindi cambia camera **senza**
  rinegoziare la connessione WebRTC.
- **Registro eventi** espandibile in fondo: utilissimo in fase di debug, mostra
  ogni passaggio della negoziazione.

### Il codice stanza

Il client legge il parametro `?room=` dall'URL (quello inserito nel QR). Se
assente, usa il valore di default in `config.js`. Il codice serve al signaling
server per accoppiare il telefono giusto al bridge giusto — utile se in futuro
si vorranno più telefoni contemporaneamente.

### Configurazione (`config.js`)

| Parametro | A cosa serve |
|---|---|
| `signalingUrl` | Indirizzo del signaling server. **Obbligatorio** su GitHub Pages (es. `wss://mio-signaling.onrender.com/ws`). Se `null`, viene derivato dall'host corrente: va bene solo in locale. |
| `roomId` | Codice stanza di default, usato se l'URL non contiene `?room=`. |
| `iceServers` | Server STUN/TURN. Va inserito qui il proprio TURN con credenziali. |
| `videoConstraints` | Risoluzione e frame rate massimi, per contenere banda e latenza su rete mobile. |

---

## 5. La pagina QR (host)

Da tenere aperta su un laptop o monitor accanto al setup. A ogni apertura:

1. genera un codice stanza casuale di 4 cifre;
2. costruisce l'URL del client con quel codice;
3. disegna il QR code corrispondente;
4. mostra l'URL per esteso sotto il QR, così è sempre verificabile a occhio.

### Due accortezze implementate

**Non punta mai a `localhost`.** Se apri la pagina su `https://localhost:8443`,
il QR conterrebbe `localhost` — che per il telefono significa "il telefono
stesso", e non funzionerebbe. La pagina interroga quindi il server di sviluppo
(endpoint `/_lan`) per ottenere l'indirizzo di rete del computer, e usa quello.
Se non riesce, mostra un avviso giallo esplicito.

**Dice cosa non va.** Se la libreria QR non viene trovata, o se la pagina è
stata aperta con doppio clic (`file://`) invece che tramite il server, al posto
di un riquadro bianco muto compare un messaggio che spiega il problema.

---

## 6. Il signaling server

### Cosa fa e cosa non fa

**Non vede mai il video.** Si limita a inoltrare i messaggi di segnalazione tra
i due peer di una stessa stanza. Il video viaggia per un'altra strada
(direttamente tra i peer, o via TURN).

### Concetto di stanza e ruoli

Ogni stanza contiene al massimo due peer, distinti per ruolo:

- **`client`** — il telefono, sorgente video: invia l'offerta SDP;
- **`bridge`** — il servizio locale che converte in NDI: invia la risposta.

Chiunque si colleghi dichiara stanza e ruolo con un messaggio `join`.

### Protocollo dei messaggi (JSON su WebSocket)

**Inviati dai peer al server:**

| Messaggio | Contenuto | Significato |
|---|---|---|
| `join` | `room`, `role` | Entra nella stanza con un ruolo |
| `offer` | `room`, `sdp` | Offerta SDP (dal client) |
| `answer` | `room`, `sdp` | Risposta SDP (dal bridge) |
| `candidate` | `room`, `candidate` | Candidato ICE |

**Inviati dal server ai peer:**

| Messaggio | Contenuto | Significato |
|---|---|---|
| `joined` | `room`, `role`, `peerPresent` | Join confermato; dice se l'altro peer c'è già |
| `peer-joined` | — | L'altro peer si è appena collegato |
| `peer-left` | — | L'altro peer si è disconnesso |
| `error` | `message` | Errore (stanza mancante, ruolo non valido, origine non ammessa…) |

`offer`, `answer` e `candidate` vengono recapitati all'altro peer **così come
sono**, senza modifiche.

### Quattro scelte progettuali importanti

**1. Buffering dei messaggi.** Il client invia l'offerta SDP subito dopo il
join. Se il bridge si collega per secondo, senza buffering l'offerta andrebbe
perduta e la connessione non partirebbe mai. Il server la mette quindi in coda
(massimo 60 messaggi per peer) e la recapita appena il destinatario arriva.

**2. Heartbeat ogni 30 secondi.** I proxy dei servizi di hosting chiudono le
connessioni WebSocket inattive. Durante la negoziazione ICE ci sono pause di
silenzio sufficienti a far cadere la connessione. Un ping periodico le mantiene
aperte e individua i socket morti.

**3. Un solo peer per ruolo, con sostituzione.** Se ricarichi la pagina sul
telefono, la vecchia connessione viene chiusa e la nuova prende il suo posto.
Senza questo, la stanza risulterebbe occupata e resteresti bloccato fuori.

**4. Filtro sulle origini.** La variabile d'ambiente `ALLOWED_ORIGINS` limita
chi può collegarsi. In produzione va impostata al proprio dominio GitHub Pages,
per evitare che chiunque possa agganciarsi al proprio bridge. È la misura
minima di sicurezza per un sistema che trasmette video su Internet.

### Variabili d'ambiente

| Variabile | Descrizione |
|---|---|
| `PORT` | Porta di ascolto. Impostata automaticamente dai servizi di hosting. Default: 8080. |
| `ALLOWED_ORIGINS` | Origini ammesse, separate da virgola. Se assente, accetta tutte (solo per sviluppo). |

### Endpoint HTTP

- `GET /health` (e `GET /`) → risposta JSON con stato, numero di stanze attive
  e uptime. Serve ai servizi di hosting per verificare che il servizio sia vivo,
  ed è comodo per controllare a mano che sia raggiungibile.
- WebSocket sul percorso `/ws`.

---

## 7. Il bridge WebRTC → NDI

È il traduttore fra due mondi: riceve WebRTC (protocollo web) e produce NDI
(protocollo video professionale). Gira sulla stessa macchina di TouchDesigner,
perché NDI non attraversa Internet.

### Come funziona

1. Si collega **in uscita** al signaling server ed entra nella stanza con
   ruolo `bridge`. Essendo lui a iniziare la connessione, non servono porte
   aperte né configurazione del router.
2. Alla ricezione dell'offerta SDP del telefono, crea una `RTCPeerConnection`
   con aiortc, imposta la descrizione remota, genera la risposta e la rimanda
   indietro.
3. Quando arriva la traccia video, legge i fotogrammi in un ciclo, li converte
   in **BGRA** (il formato che corrisponde al FourCC `BGRX` usato da NDI) e li
   passa alla libreria NDI.
4. TouchDesigner vede la sorgente comparire nel menu *Source* dell'NDI In TOP.

### Perché aiortc invece di Node.js

Il client e il signaling server sono in JavaScript, quindi la scelta naturale
sarebbe stata Node.js anche qui. Il problema è che le librerie WebRTC per Node
(`wrtc`, `mediasoup`) hanno un supporto irregolare su macOS, specialmente per
le architetture meno recenti. `aiortc` è invece un'implementazione WebRTC in
Python matura e multipiattaforma, e i binding NDI per Python esistono e sono
mantenuti. Il costo è avere due linguaggi nel progetto; il beneficio è che il
componente più delicato gira davvero.

### Nota sui candidati ICE

Il client del browser usa il *trickle ICE*: invia i candidati man mano che li
scopre, in messaggi separati. aiortc non lo fa: raccoglie tutti i candidati
prima di completare `setLocalDescription`, per cui sono già contenuti nella
risposta SDP. Il bridge quindi **riceve** candidati separati dal telefono ma
non ne **invia**. È una differenza di comportamento legittima fra le due
implementazioni, e non impedisce la connessione.

### Vincoli su macOS Intel

Questa è la parte più insidiosa e vale la pena documentarla, perché non è
evidente prima di sbatterci contro.

I binding `ndi-python` pubblicano binari precompilati per macOS x86_64 solo
fino alla versione **5.1.1.1** (marzo 2022), che supporta al massimo
**Python 3.10**. Da questo vincolo iniziale discende tutto il resto:

| Pacchetto | Vincolo su Mac Intel | Motivo |
|---|---|---|
| `ndi-python` | `==5.1.1.1` | Ultima versione con binari x86_64 |
| Python | `3.10` | Massima versione supportata da ndi-python 5.1.1.1 |
| `numpy` | `<2` | ndi-python è compilato contro numpy 1.x |
| `cryptography` | `<49` | Dalla 49 non pubblica più binari per macOS Intel |
| `aiortc` | `1.15.0` | Compatibile con Python 3.10 e Intel |

Su Apple Silicon nulla di tutto questo si applica: si usa `requirements.txt`
con le versioni recenti.

### Modalità di prova

Il bridge ha due strumenti pensati per isolare i guasti:

- `--dry-run` esegue tutto tranne la pubblicazione NDI. Se funziona in dry-run
  ma non senza, il problema è nella parte NDI e non nella rete.
- `fake_client.py` simula il telefono inviando un video sintetico (una barra
  bianca che scorre su fondo verde). Permette di provare la catena senza
  dispositivi reali, e di distinguere un problema del telefono da uno del
  sistema.

La sequenza di verifica consigliata è: prima `--dry-run` con il client
simulato, poi senza `--dry-run` sempre col client simulato (verifica NDI in
TouchDesigner), e solo alla fine il telefono vero.

---

## 8. Come eseguire il progetto in locale

### Prerequisiti

- **Node.js** versione 18 o superiore (`node --version` per verificare).
- **openssl** per generare il certificato (già presente su macOS e Linux).

### Passo 1 — Avviare il signaling server

```bash
cd server
npm install
npm start
```

Deve comparire `Signaling server in ascolto sulla porta 8080`.
Verifica aprendo `http://localhost:8080/health`: deve rispondere con un JSON.

### Passo 2 — Eseguire i test automatici

In un **secondo terminale**, con il server ancora attivo:

```bash
cd server
npm test
```

Devono comparire 14 controlli tutti `OK` e il messaggio finale
`Tutti i controlli superati.`

Per provare anche il filtro sulle origini, riavvia il server così:

```bash
ALLOWED_ORIGINS="https://esempio.github.io" npm start
```

e in un altro terminale: `node test-origins.js`

### Passo 3 — Generare il certificato per il client

```bash
cd client
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout certs/dev-key.pem -out certs/dev-cert.pem \
  -days 365 -subj "/CN=localhost"
```

### Passo 4 — Avviare il client

```bash
cd client
node serve-dev.js
```

Il terminale stampa due indirizzi: uno per il computer e uno con l'IP di rete
locale, da usare dal telefono. **Annota il secondo.**

### Passo 5 — Aprire la pagina QR

Sul computer apri l'indirizzo stampato. Il browser avvisa che il certificato non
è attendibile: procedi comunque (su Chrome: *Avanzate → Procedi*).

Devi vedere il QR, il codice stanza, e sotto l'URL per esteso. **Controlla che
l'URL inizi con `https://192.168.…` e non con `https://localhost`.**

### Passo 6 — Collegare il telefono

Telefono e computer sulla **stessa rete WiFi**. Inquadra il QR con l'app
Fotocamera, tocca il link, accetta l'avviso sul certificato. Su iOS Safari
l'avviso è più insistente: *Mostra dettagli → Visita questo sito web*.

### Passo 7 — Avviare il bridge

In un terzo terminale, dalla cartella `bridge/` (vedi il suo README per
l'installazione delle dipendenze):

```bash
source venv/bin/activate
python bridge.py --signaling ws://localhost:8080/ws --room XXXX
```

Il codice stanza deve essere **lo stesso** mostrato dalla pagina QR.

### Passo 8 — Collegare TouchDesigner

Crea un **NDI In TOP** e seleziona nel parametro *Source* la sorgente
pubblicata dal bridge (di default `Camera Mobile`). Verifica che il parametro
*Active* sia attivo.

### Passo 9 — Avviare la trasmissione

Sul telefono, tocca il pulsante rosso e concedi il permesso della fotocamera.
Lo stato deve passare a `in diretta` in verde, e l'immagine comparire
nell'NDI In TOP.

---

## 9. Problemi frequenti

| Sintomo | Causa | Soluzione |
|---|---|---|
| Il browser non chiede il permesso fotocamera | Pagina non servita in HTTPS | Verifica che l'indirizzo inizi con `https://` |
| La pagina QR mostra un riquadro bianco | Libreria `qrcode.min.js` non trovata | Deve stare in `vendor/` o accanto a `host.html` |
| La pagina QR dice "aperta dal disco" | Aperta con doppio clic (`file://`) | Avvia `node serve-dev.js` e usa l'indirizzo `https://` |
| Il QR non funziona dal telefono | L'URL nel QR contiene `localhost` | Riavvia `serve-dev.js` e ricarica; controlla l'URL sotto il QR |
| Il telefono non raggiunge la pagina | Firewall del computer | Impostazioni → Rete → Firewall: consenti le connessioni per Node |
| Il telefono non raggiunge la pagina | Isolamento client sulla rete WiFi (comune nelle reti universitarie) | Usa l'hotspot del telefono e collegaci il computer |
| Stato bloccato su "in attesa del bridge" | Il bridge non è in esecuzione, o è in una stanza diversa | Verifica che il codice stanza passato a `bridge.py` sia identico a quello della pagina QR |
| "signaling non configurato" sul telefono | `signalingUrl` non impostato in `config.js` | Inserire l'indirizzo `wss://…/ws` del signaling server |
| Il bridge termina con timeout all'avvio | Servizio di hosting sospeso per inattività | Aprire `/health` nel browser per risvegliarlo; il bridge riprova comunque da solo |
| `ModuleNotFoundError: NDIlib` | NDI SDK assente, o versione di Python senza binari | Su Mac Intel servono Python 3.10 e `ndi-python==5.1.1.1` |
| La sorgente NDI non compare in TouchDesigner | Firewall di macOS, o bridge su rete diversa | Consentire le connessioni per Python; NDI si annuncia via mDNS in rete locale |
| Il bridge riceve "Origine non ammessa" | `--origin` non incluso in `ALLOWED_ORIGINS` | Allineare i due valori sul servizio di hosting |
| Immagine a scatti o molto in ritardo | Banda insufficiente o relay TURN sovraccarico | Abbassa risoluzione/frame rate in `config.js` |

---

## 10. Pubblicazione online

Pubblicare risolve in un colpo il problema del certificato, l'isolamento della
rete WiFi e il firewall — e consente l'uso da qualsiasi rete.

### Come si ridistribuiscono i pezzi

- **Client + pagina QR → GitHub Pages.** Solo file statici, HTTPS valido
  incluso, gratuito.
- **Signaling server → servizio di hosting** con supporto WebSocket. Render ha
  un piano gratuito permanente; nota che sospende il servizio dopo 15 minuti di
  inattività, con circa un minuto di attesa alla prima richiesta successiva
  (per una demo, apri la pagina un minuto prima per "svegliarlo").
- **Bridge + TouchDesigner → restano sul tuo computer**, obbligatoriamente,
  perché NDI funziona solo in rete locale.

### Il vantaggio non ovvio

Il bridge **si collega in uscita** al signaling server. Non serve aprire porte
sul router, né configurare il NAT, né disattivare firewall. Questo elimina la
classe di problemi più fastidiosa.

### Modifiche necessarie prima di pubblicare

1. In `config.js`, impostare `signalingUrl` all'indirizzo del signaling server
   pubblicato (schema `wss://`, non `ws://`).
2. Sul servizio di hosting, impostare `ALLOWED_ORIGINS` al proprio dominio
   GitHub Pages.
3. Inserire in `iceServers` un server TURN con credenziali valide.

---

## 11. Stato del progetto e prossimi passi

### Completato

- Client web mobile: cattura fotocamera, WebRTC, inversione camera con
  anteprima specchiata, mirino adattato alle proporzioni reali del fotogramma.
- Pagina QR con generazione codice stanza.
- Server HTTPS locale per le prove in rete locale.
- Signaling server: stanze, ruoli, inoltro, buffering, heartbeat, filtro origini.
- Test automatici del signaling server (14 controlli).
- Bridge WebRTC → NDI in Python, con modalità di prova senza NDI e telefono
  simulato per le verifiche.
- **Pubblicazione**: client su GitHub Pages, signaling server su Render.
- **Verifica end-to-end riuscita**: video della fotocamera del telefono
  ricevuto dentro TouchDesigner attraverso Internet.
- Documentazione tecnica in italiano e inglese (PDF).

### Da fare

1. **Server TURN**: necessario perché la connessione funzioni anche con
   telefono e computer su reti diverse (es. telefono su rete dati). Con
   entrambi sulla stessa WiFi il solo STUN è sufficiente.
2. **Misure di latenza** per la parte di analisi della relazione.

### Possibili estensioni

- Canale dati per controllare da telefono i parametri di TouchDesigner.
- Più telefoni contemporaneamente, con più sorgenti NDI in parallelo.
- Riconnessione automatica alla caduta della rete mobile.

---

## 12. Riferimenti

- W3C — *WebRTC: Real-Time Communication in Browsers* (specifica ufficiale)
- IETF RFC 8445 — *Interactive Connectivity Establishment (ICE)*
- IETF RFC 5389 — *Session Traversal Utilities for NAT (STUN)*
- IETF RFC 5766 — *Traversal Using Relays around NAT (TURN)*
- NewTek/Vizrt — documentazione del protocollo NDI
- Derivative — documentazione TouchDesigner, operatore NDI In TOP
- coturn — progetto open source per server STUN/TURN
- QRCode.js — libreria QR usata nella pagina host (licenza MIT)
