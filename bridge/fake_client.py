#!/usr/bin/env python3
"""
Client finto: simula il telefono inviando un video sintetico.

Serve a verificare l'intera catena (signaling → WebRTC → bridge) senza
un telefono reale. Il video generato è una barra che scorre su fondo
colorato, così è evidente a colpo d'occhio se i fotogrammi scorrono.

Uso:
    python fake_client.py --signaling ws://localhost:8080/ws --room 1234 --seconds 10
"""

import argparse
import asyncio
import fractions
import json
import logging

import numpy as np
import websockets
from av import VideoFrame
from aiortc import RTCPeerConnection, RTCConfiguration, RTCIceServer, RTCSessionDescription
from aiortc.mediastreams import MediaStreamTrack
from aiortc.sdp import candidate_from_sdp

log = logging.getLogger("fake-client")


class SyntheticVideoTrack(MediaStreamTrack):
    """Genera un video sintetico a 30 fotogrammi al secondo."""

    kind = "video"

    def __init__(self, width=640, height=360, fps=30):
        super().__init__()
        self.width, self.height, self.fps = width, height, fps
        self.counter = 0

    async def recv(self):
        pts = self.counter
        await asyncio.sleep(1 / self.fps)

        img = np.zeros((self.height, self.width, 3), dtype=np.uint8)
        img[:, :, 1] = 90                                    # fondo verde scuro
        x = int((self.counter * 6) % self.width)             # barra che scorre
        img[:, max(0, x - 20):x, :] = 255

        frame = VideoFrame.from_ndarray(img, format="rgb24")
        frame.pts = pts
        frame.time_base = fractions.Fraction(1, self.fps)
        self.counter += 1
        return frame


async def run(args):
    pc = RTCPeerConnection(RTCConfiguration(
        iceServers=[RTCIceServer(urls=["stun:stun.l.google.com:19302"])]))
    pc.addTrack(SyntheticVideoTrack())

    async with websockets.connect(args.signaling, origin=args.origin) as ws:
        await ws.send(json.dumps({"type": "join", "room": args.room, "role": "client"}))
        log.info("Entrato nella stanza %s", args.room)

        offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        await ws.send(json.dumps({
            "type": "offer", "room": args.room,
            "sdp": {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type},
        }))
        log.info("Offerta inviata, attendo la risposta del bridge…")

        connected = asyncio.Event()

        @pc.on("connectionstatechange")
        async def on_change():
            log.info("Stato della connessione: %s", pc.connectionState)
            if pc.connectionState == "connected":
                connected.set()

        async def read():
            async for raw in ws:
                msg = json.loads(raw)
                if msg.get("type") == "answer":
                    log.info("Risposta ricevuta dal bridge.")
                    await pc.setRemoteDescription(RTCSessionDescription(
                        sdp=msg["sdp"]["sdp"], type=msg["sdp"]["type"]))
                elif msg.get("type") == "candidate":
                    cand = msg.get("candidate") or {}
                    if cand.get("candidate"):
                        try:
                            ice = candidate_from_sdp(cand["candidate"].split(":", 1)[1])
                            ice.sdpMid = cand.get("sdpMid")
                            ice.sdpMLineIndex = cand.get("sdpMLineIndex")
                            await pc.addIceCandidate(ice)
                        except Exception:
                            pass
                elif msg.get("type") == "error":
                    log.error("Errore dal signaling: %s", msg.get("message"))
                    return

        reader = asyncio.ensure_future(read())
        try:
            await asyncio.wait_for(connected.wait(), timeout=args.timeout)
            log.info("Connessione stabilita, trasmetto per %d secondi.", args.seconds)
            await asyncio.sleep(args.seconds)
        except asyncio.TimeoutError:
            log.error("Connessione non stabilita entro %d secondi.", args.timeout)
            return 1
        finally:
            reader.cancel()
            await pc.close()
    return 0


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Client finto per provare il bridge")
    p.add_argument("--signaling", required=True)
    p.add_argument("--room", required=True)
    p.add_argument("--origin", default="https://babsaar.github.io")
    p.add_argument("--seconds", type=int, default=8)
    p.add_argument("--timeout", type=int, default=20)
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  [client] %(message)s",
                        datefmt="%H:%M:%S")
    raise SystemExit(asyncio.run(run(args)))
