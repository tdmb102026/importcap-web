// Servidor de Importcap para Railway.
// Muestra la web (los mismos archivos que publica Netlify) y guarda los pedidos
// y comprobantes de Deuna que llegan de los formularios, sin depender de Netlify.
//
// Variables en Railway:
//   PORT          la pone Railway sola
//   ADMIN_CLAVE   contraseña para ver los pedidos en /admin (usuario: importcap)
//   DATA_DIR      carpeta del volumen donde se guardan los pedidos (por defecto ./data)

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const DATA = process.env.DATA_DIR || path.join(ROOT, "data");
const FILES = path.join(DATA, "comprobantes");
const DB = path.join(DATA, "pedidos.jsonl");
const CLAVE = process.env.ADMIN_CLAVE || "";
fs.mkdirSync(FILES, { recursive: true });

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

/* ---------- formularios (mismo formato que Netlify Forms) ---------- */
const upload = multer({
  storage: multer.diskStorage({
    destination: FILES,
    filename: (req, f, cb) => cb(null, Date.now() + "-" + crypto.randomBytes(4).toString("hex") + (path.extname(f.originalname).toLowerCase().replace(/[^.a-z0-9]/g, "") || ".jpg"))
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 40 },
  fileFilter: (req, f, cb) => cb(null, /^image\//.test(f.mimetype) || f.mimetype === "application/pdf")
});

function guardar(reg) {
  fs.appendFileSync(DB, JSON.stringify(reg) + "\n");
}

app.post("/", express.urlencoded({ extended: false, limit: "50kb" }), upload.single("captura"), (req, res) => {
  const b = req.body || {};
  if (!b["form-name"]) return res.status(400).send("Falta form-name");
  if (b["bot-field"]) return res.status(200).send("ok"); // trampa para robots
  const datos = {};
  for (const [k, v] of Object.entries(b)) if (k !== "bot-field") datos[k] = String(v).slice(0, 1000);
  guardar({
    id: crypto.randomUUID(),
    fecha: new Date().toISOString(),
    formulario: b["form-name"],
    datos,
    archivo: req.file ? req.file.filename : null
  });
  res.status(200).send("ok");
});

/* ---------- panel de pedidos ---------- */
function auth(req, res, next) {
  if (!CLAVE) return res.status(503).send("Configura ADMIN_CLAVE en Railway para ver los pedidos.");
  const [tipo, val] = (req.headers.authorization || "").split(" ");
  const [u, p] = tipo === "Basic" ? Buffer.from(val || "", "base64").toString().split(":") : [];
  const ok = u === "importcap" && p && p.length === CLAVE.length && crypto.timingSafeEqual(Buffer.from(p), Buffer.from(CLAVE));
  if (ok) return next();
  res.set("WWW-Authenticate", 'Basic realm="Pedidos Importcap"').status(401).send("Clave requerida");
}

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function leer() {
  if (!fs.existsSync(DB)) return [];
  return fs.readFileSync(DB, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

app.get("/admin/comprobante/:f", auth, (req, res) => {
  const f = path.basename(req.params.f);
  res.sendFile(path.join(FILES, f), err => err && res.status(404).end());
});

app.get("/admin/pedidos.csv", auth, (req, res) => {
  const rows = leer().filter(r => r.formulario === "pedido-excavadora");
  const cols = ["fecha", "codigo", "nombre", "telefono", "provincia", "ciudad", "direccion", "cantidad", "total", "pago", "a_pagar_ahora", "tarjeta_regalo", "notas", "origen"];
  const csv = [cols.join(",")].concat(rows.map(r => cols.map(c => '"' + String(c === "fecha" ? r.fecha : r.datos[c] ?? "").replace(/"/g, '""') + '"').join(","))).join("\n");
  res.type("text/csv").set("Content-Disposition", "attachment; filename=pedidos-importcap.csv").send("﻿" + csv);
});

app.get("/admin", auth, (req, res) => {
  const regs = leer();
  const comp = {};
  regs.filter(r => r.formulario === "comprobante").forEach(r => { (comp[r.datos.codigo] ||= []).push(r); });
  const pedidos = regs.filter(r => r.formulario === "pedido-excavadora").reverse();
  const fmt = iso => new Date(iso).toLocaleString("es-EC", { timeZone: "America/Guayaquil", dateStyle: "short", timeStyle: "short" });
  const filas = pedidos.map(r => {
    const d = r.datos, cs = comp[d.codigo] || [];
    const tel = String(d.telefono || "").replace(/\D/g, "").replace(/^0/, "593");
    const comps = cs.map(c => c.archivo ? `<a href="/admin/comprobante/${esc(c.archivo)}" target="_blank">ver captura</a>` : "").join(" ");
    return `<tr><td>${esc(fmt(r.fecha))}<br><b>${esc(d.codigo)}</b></td><td><b>${esc(d.nombre)}</b><br><a href="https://wa.me/${esc(tel)}" target="_blank">${esc(d.telefono)}</a></td><td>${esc(d.direccion)}<br>${esc(d.ciudad)}, ${esc(d.provincia)}${d.tarjeta_regalo ? `<br>🎁 ${esc(d.tarjeta_regalo)}` : ""}${d.notas ? `<br>📝 ${esc(d.notas)}` : ""}</td><td>${esc(d.cantidad)} × excavadora<br><b>${esc(d.total)}</b></td><td>${esc(d.pago)}<br>Ahora: ${esc(d.a_pagar_ahora)}<br>${comps || '<span class="no">sin comprobante</span>'}</td><td class="o">${esc(d.origen)}</td></tr>`;
  }).join("");
  const sueltos = regs.filter(r => r.formulario === "comprobante" && !pedidos.some(p => p.datos.codigo === r.datos.codigo));
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Pedidos · Importcap</title>
<style>body{font:15px system-ui,sans-serif;margin:0;background:#0c1a10;color:#f4f1e8}header{padding:16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px}h1{margin:0;font-size:20px}a{color:#d2ff3c}.wrap{overflow-x:auto;padding:0 16px 30px}table{border-collapse:collapse;width:100%;min-width:900px}td,th{border-bottom:1px solid #2a4433;padding:10px;text-align:left;vertical-align:top}th{color:#b9c2b5;font-size:12px;text-transform:uppercase}.no{color:#ff8a7a}.o{font-size:12px;color:#b9c2b5;max-width:180px}.btn{background:#d2ff3c;color:#14200b;border-radius:10px;padding:8px 12px;text-decoration:none;font-weight:700}</style></head><body>
<header><h1>Pedidos de la excavadora (${pedidos.length})</h1><a class="btn" href="/admin/pedidos.csv">Descargar Excel (CSV)</a></header>
<div class="wrap"><table><thead><tr><th>Fecha / código</th><th>Cliente</th><th>Dirección</th><th>Pedido</th><th>Pago</th><th>Anuncio</th></tr></thead><tbody>${filas || '<tr><td colspan="6">Todavía no hay pedidos.</td></tr>'}</tbody></table>
${sueltos.length ? `<h2 style="font-size:16px">Comprobantes sin pedido</h2>` + sueltos.map(s => `<p>${esc(fmt(s.fecha))} · ${esc(s.datos.codigo)} · ${esc(s.datos.nombre)} · <a href="/admin/comprobante/${esc(s.archivo)}" target="_blank">ver</a></p>`).join("") : ""}
</div></body></html>`);
});

/* ---------- web estática: solo las carpetas públicas ---------- */
const est = { maxAge: "1h", extensions: ["html"] };
app.use("/img", express.static(path.join(ROOT, "img"), est));
app.use("/excavadora", express.static(path.join(ROOT, "excavadora"), est));
for (const f of ["index.html", "robots.txt", "sitemap.xml"]) app.get("/" + f, (req, res) => res.sendFile(path.join(ROOT, f)));
app.get("/", (req, res) => res.sendFile(path.join(ROOT, "index.html")));
app.use((req, res) => res.status(404).sendFile(path.join(ROOT, "index.html")));

app.use((err, req, res, next) => { console.error(err); res.status(400).send("No se pudo procesar"); });

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Importcap escuchando en", port, "datos en", DATA));
