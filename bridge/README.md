# Bridge WebRTC → NDI

Riceve il flusso video dal telefono e lo ripubblica come sorgente NDI, che
TouchDesigner legge con l'operatore **NDI In TOP**.

Deve girare sulla stessa macchina (o rete locale) di TouchDesigner, perché NDI
non attraversa Internet. Si collega **in uscita** al signaling server: non
richiede porte aperte né configurazione del router.

---

## Installazione su macOS Intel

Su Mac Intel c'è un vincolo importante: `ndi-python` pubblica binari per
x86_64 solo fino alla versione **5.1.1.1** (marzo 2022), che supporta al
massimo **Python 3.10**. Tutto il resto discende da lì.

### 1. NDI SDK

Scarica e installa l'SDK da <https://ndi.video/for-developers/ndi-sdk/>.
Su macOS si installa in `/Library/NDI SDK for Apple`.

### 2. Python 3.10

Se non ce l'hai, la via più pulita è Homebrew:

```bash
brew install python@3.10
```

Verifica: `python3.10 --version`

### 3. Ambiente virtuale e dipendenze

```bash
cd bridge
python3.10 -m venv venv
source venv/bin/activate
pip install -r requirements-intel.txt
```

Controlla che i binding NDI si carichino:

```bash
python -c "import NDIlib; print('NDI disponibile')"
```

---

## Installazione su Apple Silicon, Windows, Linux

Stessi passaggi, ma con Python 3.10–3.14 e:

```bash
pip install -r requirements.txt
```

---

## Uso

```bash
python bridge.py \
  --signaling wss://signaling-jesse-sistemi.onrender.com/ws \
  --room 1234 \
  --ndi-name "Camera Mobile"
```

Il codice stanza è quello mostrato dalla pagina QR: **deve coincidere**,
altrimenti telefono e bridge finiscono in stanze diverse e non si trovano.

Quando il collegamento riesce, nel log compare il primo fotogramma con la sua
risoluzione, e in TouchDesigner la sorgente appare nel menu *Source* dell'NDI
In TOP.

### Opzioni principali

| Opzione | Descrizione |
|---|---|
| `--signaling` | URL del signaling server (`wss://…/ws`). Obbligatorio. |
| `--room` | Codice stanza mostrato dalla pagina QR. Obbligatorio. |
| `--ndi-name` | Nome della sorgente visibile in TouchDesigner. Default: `Camera Mobile`. |
| `--origin` | Origine dichiarata al signaling server; deve rientrare fra quelle ammesse da `ALLOWED_ORIGINS`. |
| `--turn`, `--turn-user`, `--turn-password` | Server TURN, necessario quando telefono e computer sono su reti diverse. |
| `--dry-run` | Non pubblica su NDI: verifica solo signaling e WebRTC. |
| `--once` | Termina dopo una sessione invece di restare in attesa. |
| `--verbose` | Log dettagliato, utile per diagnosticare la negoziazione ICE. |

---

## Prova senza telefono

Per verificare la catena signaling → WebRTC → bridge senza dispositivi reali,
`fake_client.py` simula un telefono inviando un video sintetico.

In tre terminali distinti:

```bash
# 1 — signaling server (dalla cartella server/)
npm start

# 2 — bridge, senza pubblicazione NDI
python bridge.py --signaling ws://localhost:8080/ws --room 1234 --dry-run

# 3 — telefono simulato
python fake_client.py --signaling ws://localhost:8080/ws --room 1234 --seconds 10
```

Nel log del bridge devi vedere `Primo fotogramma: 640x360` e poi il conteggio
dei fotogrammi al secondo, intorno a 26–30.

Togliendo `--dry-run` la stessa prova pubblica davvero su NDI: è il modo più
rapido per verificare che TouchDesigner veda la sorgente, senza coinvolgere il
telefono.

---

## Problemi noti

**Crash alla chiusura su Apple Silicon.** Le versioni 6.3.2.x di `ndi-python`
hanno una segnalazione aperta: il wheel arm64 va in errore durante la chiusura
di Python. È un problema all'uscita, non durante l'esecuzione; compilando la
libreria dai sorgenti non si presenta. Non riguarda i Mac Intel.

**`ModuleNotFoundError: NDIlib`.** L'SDK NDI non è installato, oppure stai
usando una versione di Python per cui non esistono i binari (su Intel serve
Python 3.10 con `ndi-python==5.1.1.1`).

**La sorgente non compare in TouchDesigner.** NDI individua le sorgenti via
mDNS: bridge e TouchDesigner devono stare sulla stessa rete locale. Se il
bridge gira sulla stessa macchina di TD, verifica che il firewall di macOS non
blocchi Python.

**Il bridge resta in attesa del telefono.** Controlla che il codice stanza sia
identico a quello della pagina QR, e che `--origin` rientri fra le origini
ammesse dal signaling server.

**Errore di origine non ammessa.** Il valore di `--origin` deve combaciare
esattamente con uno di quelli in `ALLOWED_ORIGINS` sul signaling server.
