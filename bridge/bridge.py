#!/usr/bin/env python3
"""
Bridge WebRTC → NDI.

Si comporta come secondo peer WebRTC: riceve il flusso video dal telefono
attraverso il signaling server, lo decodifica e lo ripubblica come sorgente
NDI sulla rete locale, dove TouchDesigner la legge con l'operatore NDI In TOP.

Deve girare sulla stessa macchina (o rete locale) di TouchDesigner, perché
NDI non attraversa Internet. Si collega in uscita al signaling server,
quindi non richiede porte aperte né configurazione del router.

Uso tipico:
    python bridge.py --signaling wss://mio-signaling.onrender.com/ws --room 1234

Per provare la catena senza NDI installato (stampa le statistiche a video):
    python bridge.py --signaling ... --room 1234 --dry-run
"""

import argparse
import asyncio
import json
import logging
import sys
import time

import numpy as np
import ssl
import websockets
from collections import deque
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCConfiguration, RTCIceServer
from aiortc.sdp import candidate_from_sdp

log = logging.getLogger("bridge")


# --------------------------------------------------------------------------
# Uscita NDI
# --------------------------------------------------------------------------

class NdiOutput:
    """
    Pubblica i fotogrammi come sorgente NDI.

    L'import di NDIlib avviene qui e non in cima al file, così il bridge
    resta avviabile in modalità --dry-run su macchine senza SDK NDI
    (utile per verificare signaling e WebRTC separatamente).
    """

    def __init__(self, name):
        try:
            import NDIlib as ndi
        except ImportError:
            raise SystemExit(
                "Modulo NDIlib non trovato.\n"
                "  Installalo con:  pip install ndi-python\n"
                "  Su Mac Intel serve la versione compatibile:  pip install 'ndi-python==5.1.1.1'\n"
                "  È inoltre necessario l'NDI SDK: https://ndi.video/for-developers/ndi-sdk/\n"
                "  Per provare il resto della catena senza NDI, usa --dry-run."
            )

        self.ndi = ndi
        if not ndi.initialize():
            raise SystemExit("Inizializzazione NDI fallita.")

        settings = ndi.SendCreate()
        settings.ndi_name = name
        self.sender = ndi.send_create(settings)
        if self.sender is None:
            raise SystemExit("Creazione della sorgente NDI fallita.")

        self.frame = ndi.VideoFrameV2()

        # L'invio NDI è asincrono: la libreria continua a leggere la memoria
        # del fotogramma dopo il ritorno della chiamata. Senza trattenere un
        # riferimento, Python libererebbe l'array mentre NDI lo sta ancora
        # usando, con il risultato di un'immagine congelata o corrotta.
        # Manteniamo quindi in vita gli ultimi fotogrammi inviati.
        self._in_flight = deque(maxlen=3)

        log.info("Sorgente NDI pubblicata con il nome '%s'", name)

    def send(self, image, fps_num=30, fps_den=1):
        """image: array numpy BGRA di forma (altezza, larghezza, 4)."""
        self._in_flight.append(image)          # vedi commento nel costruttore

        height, width = image.shape[0], image.shape[1]
        self.frame.data = image
        self.frame.FourCC = self.ndi.FOURCC_VIDEO_TYPE_BGRX
        self.frame.frame_rate_N = fps_num
        self.frame.frame_rate_D = fps_den

        # Alcune versioni dei binding ricavano queste informazioni dall'array,
        # altre no: le impostiamo se disponibili, senza dare per scontato che
        # gli attributi esistano.
        for attr, value in (("xres", width), ("yres", height),
                            ("line_stride_in_bytes", width * 4)):
            try:
                setattr(self.frame, attr, value)
            except AttributeError:
                pass

        self.ndi.send_send_video_v2(self.sender, self.frame)

    def close(self):
        try:
            self.ndi.send_destroy(self.sender)
            self.ndi.destroy()
        except Exception:
            pass


class DryRunOutput:
    """Sostituto di NdiOutput per le prove: non pubblica nulla, conta i fotogrammi."""

    def __init__(self, name):
        log.info("Modalità --dry-run: nessuna pubblicazione NDI (nome previsto: '%s')", name)

    def send(self, image, fps_num=30, fps_den=1):
        pass

    def close(self):
        pass


# --------------------------------------------------------------------------
# Ricezione del flusso video
# --------------------------------------------------------------------------

def choose_target(width, height, requested):
    """
    Determina la risoluzione fissa da pubblicare su NDI.

    WebRTC adatta di continuo la dimensione del video alla banda: per NDI
    questo è un problema, perché a ogni cambio TouchDesigner deve ricostruire
    la texture e l'immagine si blocca. Pubblichiamo quindi sempre alla stessa
    risoluzione, scalando i fotogrammi in ingresso.
    """
    if requested and requested.lower() != "auto":
        w, h = requested.lower().split("x")
        return int(w), int(h)
    # In automatico: 720p nell'orientamento del primo fotogramma ricevuto.
    return (720, 1280) if height >= width else (1280, 720)


def fit_frame(frame, target_w, target_h):
    """
    Scala il fotogramma dentro le dimensioni di destinazione mantenendo le
    proporzioni, completando con nero le bande eventualmente mancanti.
    Restituisce un array BGRA contiguo, pronto per NDI.
    """
    src_w, src_h = frame.width, frame.height
    ratio = min(target_w / src_w, target_h / src_h)
    new_w = max(2, int(src_w * ratio) & ~1)      # dimensioni pari: swscale le preferisce
    new_h = max(2, int(src_h * ratio) & ~1)

    scaled = frame.reformat(width=new_w, height=new_h, format="bgra").to_ndarray()

    if new_w == target_w and new_h == target_h:
        return np.ascontiguousarray(scaled)

    canvas = np.zeros((target_h, target_w, 4), dtype=np.uint8)
    canvas[:, :, 3] = 255
    top = (target_h - new_h) // 2
    left = (target_w - new_w) // 2
    canvas[top:top + new_h, left:left + new_w] = scaled
    return canvas


async def consume_track(track, output, stats):
    """
    Legge i fotogrammi dalla traccia WebRTC e li inoltra all'uscita.

    Ogni fotogramma viene convertito in BGRA, il formato che corrisponde
    al FourCC BGRX usato da NDI.
    """
    log.info("Traccia video ricevuta, inizio inoltro dei fotogrammi.")
    last_report = time.monotonic()

    while True:
        try:
            frame = await track.recv()
        except Exception as err:
            log.info("Traccia terminata (%s).", type(err).__name__)
            return

        if stats["target"] is None:
            stats["target"] = choose_target(frame.width, frame.height, stats["requested"])
            log.info("Risoluzione di pubblicazione NDI fissata a %dx%d",
                     stats["target"][0], stats["target"][1])

        target_w, target_h = stats["target"]
        image = fit_frame(frame, target_w, target_h)

        # La dimensione in ingresso cambia di continuo per adattamento alla
        # banda: la registriamo solo per diagnosi, l'uscita resta costante.
        if (frame.width, frame.height) != stats.get("last_source"):
            stats["last_source"] = (frame.width, frame.height)
            log.debug("Dimensione in ingresso: %dx%d", frame.width, frame.height)

        if stats["frames"] == 0:
            # Il conteggio parte dal primo fotogramma: includere l'attesa
            # della connessione falserebbe la misura dei fotogrammi al secondo.
            stats["first_frame_at"] = time.monotonic()
            last_report = stats["first_frame_at"]
            log.info("Primo fotogramma ricevuto a %dx%d, pubblicato a %dx%d",
                     frame.width, frame.height, image.shape[1], image.shape[0])

        stats["frames"] += 1
        stats["width"], stats["height"] = image.shape[1], image.shape[0]

        output.send(image)

        now = time.monotonic()
        if now - last_report >= 5.0:
            elapsed = max(now - stats["first_frame_at"], 1e-6)
            log.info("Ricevuti %d fotogrammi (%.1f al secondo), risoluzione %dx%d",
                     stats["frames"], stats["frames"] / elapsed, stats["width"], stats["height"])
            last_report = now


# --------------------------------------------------------------------------
# Sessione: signaling + connessione WebRTC
# --------------------------------------------------------------------------

def tls_options(url, insecure):
    """
    Opzioni TLS per il collegamento al signaling.

    In modalità locale il server usa un certificato autofirmato: il browser
    permette di accettarlo manualmente, Python no. Con --insecure la verifica
    viene disattivata, cosa accettabile solo perché il server è la propria
    macchina in rete locale.

    Restituisce un dizionario da espandere nella chiamata: passare ssl=None
    a un indirizzo wss:// verrebbe rifiutato dalla libreria, quindi quando
    non serve nulla l'argomento va omesso del tutto.
    """
    if not url.startswith("wss://") or not insecure:
        return {}
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return {"ssl": ctx}


def ice_servers_from_args(args):
    """Server ICE indicati a riga di comando."""
    servers = [RTCIceServer(urls=[u]) for u in args.stun]
    if args.turn:
        servers.append(RTCIceServer(
            urls=[args.turn], username=args.turn_user, credential=args.turn_password))
    return servers


def ice_servers_from_signaling(entries):
    """
    Converte l'elenco consegnato dal signaling server, nello stesso formato
    usato dai browser: [{urls, username?, credential?}, …].
    """
    servers = []
    for entry in entries or []:
        urls = entry.get("urls") or entry.get("url")
        if not urls:
            continue
        servers.append(RTCIceServer(
            urls=urls,
            username=entry.get("username"),
            credential=entry.get("credential")))
    return servers


async def run_session(args, output):
    stats = {"frames": 0, "width": 0, "height": 0,
             "started": time.monotonic(), "first_frame_at": None,
             "target": None, "requested": args.ndi_resolution, "last_source": None}
    finished = asyncio.Event()
    pc = None

    def create_peer_connection(ice_servers):
        nonlocal pc
        pc = RTCPeerConnection(RTCConfiguration(iceServers=ice_servers))

        @pc.on("track")
        def on_track(track):
            if track.kind == "video":
                asyncio.ensure_future(consume_track(track, output, stats))

        @pc.on("connectionstatechange")
        async def on_state_change():
            state = pc.connectionState
            log.info("Stato della connessione: %s", state)
            # "disconnected" è spesso transitorio e il client può tentare un
            # ICE restart: chiudere qui la sessione impedirebbe il ripristino.
            if state in ("failed", "closed"):
                finished.set()
            elif state == "disconnected":
                log.info("Interruzione temporanea; in attesa di un eventuale ripristino.")

        return pc

    log.info("Connessione al signaling server: %s", args.signaling)

    # open_timeout generoso: sui piani gratuiti il servizio va in sospensione
    # dopo un periodo di inattività e il primo collegamento deve attendere
    # il risveglio, che può richiedere un minuto abbondante.
    async with websockets.connect(args.signaling, origin=args.origin,
                                  open_timeout=args.connect_timeout,
                                  **tls_options(args.signaling, args.insecure)) as ws:
        await ws.send(json.dumps({"type": "join", "room": args.room, "role": "bridge"}))
        log.info("Entrato nella stanza %s in attesa del telefono…", args.room)

        async def read_signaling():
            async for raw in ws:
                msg = json.loads(raw)
                kind = msg.get("type")

                if kind == "joined":
                    log.info("Join confermato (telefono già presente: %s)",
                             "sì" if msg.get("peerPresent") else "no")
                    # I server ICE del signaling hanno la precedenza, a meno
                    # che non ne sia stato indicato uno esplicitamente.
                    from_signaling = ice_servers_from_signaling(msg.get("iceServers"))
                    if from_signaling and not args.turn:
                        log.info("Server ICE ricevuti dal signaling: %d", len(from_signaling))
                        create_peer_connection(from_signaling)
                    else:
                        create_peer_connection(ice_servers_from_args(args))

                elif kind == "peer-joined":
                    log.info("Il telefono si è collegato.")

                elif kind == "offer":
                    if pc is None:
                        create_peer_connection(ice_servers_from_args(args))
                    # Una seconda offerta sulla stessa sessione è una
                    # rinegoziazione (tipicamente un ICE restart del client).
                    log.info("Offerta ricevuta dal telefono, preparo la risposta."
                             if pc.remoteDescription is None
                             else "Nuova offerta ricevuta: rinegoziazione in corso.")
                    await pc.setRemoteDescription(
                        RTCSessionDescription(sdp=msg["sdp"]["sdp"], type=msg["sdp"]["type"]))
                    answer = await pc.createAnswer()
                    await pc.setLocalDescription(answer)
                    # aiortc raccoglie i candidati prima di completare
                    # setLocalDescription: sono già inclusi nella risposta,
                    # quindi non serve inviarli separatamente.
                    await ws.send(json.dumps({
                        "type": "answer",
                        "room": args.room,
                        "sdp": {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type},
                    }))
                    log.info("Risposta inviata.")

                elif kind == "candidate":
                    if pc is None:
                        continue
                    cand = msg.get("candidate") or {}
                    raw_cand = cand.get("candidate")
                    if not raw_cand:
                        continue
                    try:
                        ice = candidate_from_sdp(raw_cand.split(":", 1)[1])
                        ice.sdpMid = cand.get("sdpMid")
                        ice.sdpMLineIndex = cand.get("sdpMLineIndex")
                        await pc.addIceCandidate(ice)
                    except Exception as err:
                        log.debug("Candidato ICE scartato: %s", err)

                elif kind == "peer-left":
                    # Il canale di segnalazione si è chiuso. A connessione già
                    # stabilita il video viaggia direttamente fra i due peer e
                    # il signaling non serve più: chiudere qui interromperebbe
                    # una trasmissione perfettamente funzionante.
                    if pc is not None and pc.connectionState == "connected":
                        log.info("Canale di segnalazione chiuso, ma il flusso video "
                                 "prosegue: la sessione resta attiva.")
                    else:
                        log.info("Il telefono si è disconnesso.")
                        finished.set()
                        return

                elif kind == "error":
                    log.error("Errore dal signaling server: %s", msg.get("message"))
                    finished.set()
                    return

        reader = asyncio.ensure_future(read_signaling())
        try:
            await finished.wait()
        finally:
            reader.cancel()
            if pc is not None:
                await pc.close()

    if stats["frames"]:
        elapsed = max(time.monotonic() - stats["first_frame_at"], 1e-6)
        log.info("Sessione conclusa: %d fotogrammi in %.1f secondi (%.1f al secondo).",
                 stats["frames"], elapsed, stats["frames"] / elapsed)
    else:
        log.info("Sessione conclusa senza aver ricevuto fotogrammi.")
    return stats


async def main_loop(args):
    output = DryRunOutput(args.ndi_name) if args.dry_run else NdiOutput(args.ndi_name)
    try:
        while True:
            try:
                await run_session(args, output)
            except (OSError, asyncio.TimeoutError,
                    websockets.exceptions.WebSocketException) as err:
                detail = str(err) or type(err).__name__
                log.warning("Signaling non raggiungibile: %s", detail)
                if isinstance(err, asyncio.TimeoutError):
                    log.warning("Se il servizio è ospitato su un piano gratuito potrebbe "
                                "essere sospeso: il risveglio richiede fino a un minuto.")
                elif "CERTIFICATE_VERIFY_FAILED" in detail:
                    log.warning("Certificato non verificabile: in modalità locale "
                                "aggiungere l'opzione --insecure.")

            if args.once:
                return
            log.info("Nuovo tentativo tra %d secondi…", args.retry)
            await asyncio.sleep(args.retry)
    finally:
        output.close()


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Bridge WebRTC → NDI per TouchDesigner")
    p.add_argument("--signaling", required=True,
                   help="URL del signaling server, es. wss://mio-signaling.onrender.com/ws")
    p.add_argument("--room", required=True,
                   help="Codice stanza mostrato dalla pagina QR")
    p.add_argument("--ndi-name", default="Camera Mobile",
                   help="Nome della sorgente NDI visibile in TouchDesigner")
    p.add_argument("--origin", default="https://babsaar.github.io",
                   help="Origine dichiarata al signaling server (deve essere fra quelle ammesse)")
    p.add_argument("--stun", nargs="*", default=["stun:stun.l.google.com:19302"],
                   help="Server STUN")
    p.add_argument("--turn", help="URL del server TURN, es. turn:host:3478")
    p.add_argument("--turn-user", help="Utente TURN")
    p.add_argument("--turn-password", help="Password TURN")
    p.add_argument("--ndi-resolution", default="auto",
                   help="Risoluzione fissa pubblicata su NDI, es. 1280x720. "
                        "Con 'auto' usa 720p nell'orientamento del primo fotogramma.")
    p.add_argument("--insecure", action="store_true",
                   help="Accetta certificati TLS autofirmati: serve in modalità "
                        "locale, dove il server usa un certificato di sviluppo.")
    p.add_argument("--dry-run", action="store_true",
                   help="Non pubblica su NDI: utile per verificare signaling e WebRTC")
    p.add_argument("--once", action="store_true",
                   help="Termina dopo una sessione invece di restare in attesa")
    p.add_argument("--connect-timeout", type=int, default=90,
                   help="Secondi di attesa per l'handshake WebSocket (default: 90)")
    p.add_argument("--retry", type=int, default=5,
                   help="Secondi di attesa prima di ricollegarsi (default: 5)")
    p.add_argument("--verbose", action="store_true", help="Log dettagliato")
    return p.parse_args(argv)


if __name__ == "__main__":
    args = parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
    try:
        asyncio.run(main_loop(args))
    except KeyboardInterrupt:
        log.info("Interrotto.")
        sys.exit(0)
