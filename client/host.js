/**
 * Pagina da mostrare su un monitor/laptop accanto al setup.
 * Genera un codice stanza casuale e un QR code che punta a index.html
 * con quel codice, così il telefono si collega alla sessione corretta
 * semplicemente inquadrando lo schermo.
 */

const qrBox = document.getElementById("qr");

function showError(message) {
  qrBox.innerHTML =
    '<p style="color:#0a0b0e;font-family:var(--font-mono);font-size:12px;' +
    'line-height:1.6;padding:14px;margin:0;text-align:left">' + message + "</p>";
}

// La libreria QR può trovarsi in vendor/ oppure accanto a questa pagina,
// a seconda di come sono stati copiati i file: proviamo entrambi i percorsi.
function loadQrLibrary() {
  if (typeof QRCode !== "undefined") return Promise.resolve();

  const candidates = ["vendor/qrcode.min.js", "qrcode.min.js"];

  return candidates.reduce(
    (chain, src) =>
      chain.catch(
        () =>
          new Promise((resolve, reject) => {
            const tag = document.createElement("script");
            tag.src = src;
            tag.onload = () => (typeof QRCode !== "undefined" ? resolve() : reject());
            tag.onerror = reject;
            document.head.appendChild(tag);
          })
      ),
    Promise.reject()
  );
}

/**
 * Determina l'indirizzo da inserire nel QR.
 *
 * Se la pagina è aperta su localhost, il QR non può contenere "localhost":
 * per il telefono significherebbe il telefono stesso. Chiediamo quindi al
 * server di sviluppo l'indirizzo di rete locale del computer.
 */
async function resolveClientBase() {
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
  if (!isLocal) return { url: new URL("index.html", location.href), warning: null };

  try {
    const res = await fetch("/_lan");
    const { addresses, port } = await res.json();
    if (!addresses || !addresses.length) throw new Error("nessun indirizzo");

    const base = new URL(location.href);
    base.hostname = addresses[0];
    base.port = port;
    return {
      url: new URL("index.html", base),
      warning: addresses.length > 1
        ? "Il computer ha più indirizzi di rete: se il telefono non si collega, prova gli altri elencati nel terminale."
        : null,
    };
  } catch (err) {
    return {
      url: new URL("index.html", location.href),
      warning: "Attenzione: il QR punta a localhost e non funzionerà dal telefono. Apri questa pagina usando l'indirizzo di rete mostrato nel terminale.",
    };
  }
}

async function render() {
  const roomCode = String(Math.floor(1000 + Math.random() * 9000));

  const { url: clientUrl, warning } = await resolveClientBase();
  clientUrl.searchParams.set("room", roomCode);

  document.getElementById("roomCode").textContent = roomCode;
  document.getElementById("urlOut").textContent = clientUrl.toString();

  if (warning) {
    const note = document.createElement("p");
    note.className = "host__warning";
    note.textContent = warning;
    document.querySelector(".host").insertBefore(note, document.getElementById("urlOut"));
  }

  qrBox.innerHTML = "";
  new QRCode(qrBox, {
    text: clientUrl.toString(),
    width: 264,
    height: 264,
    colorDark: "#0a0b0e",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M,
  });
}

if (location.protocol === "file:") {
  showError(
    "Questa pagina è stata aperta direttamente dal disco.<br><br>" +
      "Avvia il server con <b>node serve-dev.js</b> e apri l'indirizzo " +
      "https:// che compare nel terminale."
  );
} else {
  loadQrLibrary().then(render).catch(() => {
    showError(
      "Libreria QR non trovata.<br><br>" +
        "Il file <b>qrcode.min.js</b> deve trovarsi nella cartella " +
        "<b>vendor/</b> accanto a host.html, oppure direttamente " +
        "nella stessa cartella."
    );
  });
}
