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
import websockets
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
        log.info("Sorgente NDI pubblicata con il nome '%s'", name)

    def send(self, image, fps_num=30, fps_den=1):
        """image: array numpy BGRA di forma (altezza, larghezza, 4)."""
        self.frame.data = image
        self.frame.FourCC = self.ndi.FOURCC_VIDEO_TYPE_BGRX
        self.frame.frame_rate_N = fps_num
        self.frame.frame_rate_D = fps_den
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

        image = frame.to_ndarray(format="bgra")

        if stats["frames"] == 0:
            # Il conteggio parte dal primo fotogramma: includere l'attesa
            # della connessione falserebbe la misura dei fotogrammi al secondo.
            stats["first_frame_at"] = time.monotonic()
            last_report = stats["first_frame_at"]
            log.info("Primo fotogramma: %dx%d", image.shape[1], image.shape[0])

        stats["frames"] += 1
        stats["width"], stats["height"] = image.shape[1], image.shape[0]

        output.send(np.ascontiguousarray(image))

        now = time.monotonic()
        if now - last_report >= 5.0:
            elapsed = max(now - stats["first_frame_at"], 1e-6)
            log.info("Ricevuti %d fotogrammi (%.1f al secondo), risoluzione %dx%d",
                     stats["frames"], stats["frames"] / elapsed, stats["width"], stats["height"])
            last_report = now


# --------------------------------------------------------------------------
# Sessione: signaling + connessione WebRTC
# --------------------------------------------------------------------------

async def run_session(args, output):
    ice_servers = [RTCIceServer(urls=[u]) for u in args.stun]
    if args.turn:
        ice_servers.append(RTCIceServer(
            urls=[args.turn], username=args.turn_user, credential=args.turn_password))

    pc = RTCPeerConnection(RTCConfiguration(iceServers=ice_servers))
    stats = {"frames": 0, "width": 0, "height": 0,
             "started": time.monotonic(), "first_frame_at": None}
    finished = asyncio.Event()

    @pc.on("track")
    def on_track(track):
        if track.kind == "video":
            asyncio.ensure_future(consume_track(track, output, stats))

    @pc.on("connectionstatechange")
    async def on_state_change():
        log.info("Stato della connessione: %s", pc.connectionState)
        if pc.connectionState in ("failed", "closed", "disconnected"):
            finished.set()

    log.info("Connessione al signaling server: %s", args.signaling)

    async with websockets.connect(args.signaling, origin=args.origin) as ws:
        await ws.send(json.dumps({"type": "join", "room": args.room, "role": "bridge"}))
        log.info("Entrato nella stanza %s in attesa del telefono…", args.room)

        async def read_signaling():
            async for raw in ws:
                msg = json.loads(raw)
                kind = msg.get("type")

                if kind == "joined":
                    log.info("Join confermato (telefono già presente: %s)",
                             "sì" if msg.get("peerPresent") else "no")

                elif kind == "peer-joined":
                    log.info("Il telefono si è collegato.")

                elif kind == "offer":
                    log.info("Offerta ricevuta dal telefono, preparo la risposta.")
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
            except (OSError, websockets.exceptions.WebSocketException) as err:
                log.warning("Signaling non raggiungibile (%s).", err)

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
    p.add_argument("--dry-run", action="store_true",
                   help="Non pubblica su NDI: utile per verificare signaling e WebRTC")
    p.add_argument("--once", action="store_true",
                   help="Termina dopo una sessione invece di restare in attesa")
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
