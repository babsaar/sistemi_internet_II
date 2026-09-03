/**
 * Server statico HTTPS per le prove in rete locale.
 *
 * Serve la cartella del client su HTTPS con un certificato autofirmato:
 * necessario perché i browser mobile negano getUserMedia su connessioni
 * non sicure quando la pagina è raggiunta tramite IP di rete locale.
 *
 * Uso:
 *   node serve-dev.js            (porta 8443 di default)
 *   PORT=9443 node serve-dev.js
 *
 * Richiede i file certs/dev-cert.pem e certs/dev-key.pem
 * (vedi README-prova.md per generarli).
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = process.env.PORT || 8443;
const ROOT = __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const options = {
  cert: fs.readFileSync(path.join(ROOT, "certs", "dev-cert.pem")),
  key: fs.readFileSync(path.join(ROOT, "certs", "dev-key.pem")),
};

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === "IPv4" && !net.internal) out.push(net.address);
    }
  }
  return out;
}

const server = https.createServer(options, (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, "https://localhost").pathname);

  // Endpoint di servizio: comunica alla pagina QR l'indirizzo di rete locale
  // del computer, così il QR non punta mai a "localhost" (che sul telefono
  // significherebbe il telefono stesso).
  if (urlPath === "/_lan") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ addresses: localAddresses(), port: PORT }));
  }

  let filePath = path.join(ROOT, urlPath === "/" ? "/host.html" : urlPath);

  // Impedisce l'uscita dalla cartella servita
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("403");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("File non trovato: " + urlPath);
    }
    const type = MIME[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log("\nServer di prova attivo.\n");
  console.log(`  Su questo computer:  https://localhost:${PORT}/host.html`);
  for (const addr of localAddresses()) {
    console.log(`  Dal telefono:        https://${addr}:${PORT}/host.html`);
  }
  console.log("\nIl certificato è autofirmato: il browser mostrerà un avviso");
  console.log("di sicurezza da accettare manualmente la prima volta.\n");
});
