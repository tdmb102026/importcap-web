// Servidor de Importcap para Railway.
// Muestra la web (los mismos archivos que publica Netlify) y guarda los pedidos
// y comprobantes de Deuna que llegan de los formularios, sin depender de Netlify.
//
// La app de pedidos (/admin) se instala en el celular y avisa con una notificación cada pedido nuevo.
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
const webpush = require("web-push");

const ROOT = __dirname;
const DATA = process.env.DATA_DIR || path.join(ROOT, "data");
const FILES = path.join(DATA, "comprobantes");
const DB = path.join(DATA, "pedidos.jsonl");
const CLAVE = process.env.ADMIN_CLAVE || "";
fs.mkdirSync(FILES, { recursive: true });

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

/* ---------- notificaciones al celular (Web Push) ---------- */
// Las llaves se crean solas la primera vez y quedan guardadas en el volumen.
const VAPID_F = path.join(DATA, "vapid.json"), SUBS_F = path.join(DATA, "suscripciones.json"), EST_F = path.join(DATA, "estados.json");
const leerJSON = (f, def) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return def; } };
const vapid = leerJSON(VAPID_F, null) || (() => { const k = webpush.generateVAPIDKeys(); fs.writeFileSync(VAPID_F, JSON.stringify(k)); return k; })();
webpush.setVapidDetails("https://importcap.squadraec.com", vapid.publicKey, vapid.privateKey);

async function avisar(msg) {
  const subs = leerJSON(SUBS_F, []);
  if (!subs.length) return;
  const vivas = [];
  await Promise.all(subs.map(s => webpush.sendNotification(s, JSON.stringify(msg), { TTL: 86400, urgency: "high" })
    .then(() => vivas.push(s))
    .catch(e => { if (e.statusCode !== 404 && e.statusCode !== 410) { vivas.push(s); console.error("push", e.statusCode || e.message); } })));
  fs.writeFileSync(SUBS_F, JSON.stringify(vivas));
}

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
  let pedido = null;
  if (b["form-name"] === "pago-iniciado") {
    const regs = leer();
    // un aviso por pedido y forma de pago, aunque toque el botón varias veces
    if (regs.some(r => r.formulario === "pago-iniciado" && r.datos.codigo === datos.codigo && r.datos.via === datos.via)) return res.status(200).send("ok");
    pedido = regs.find(r => r.formulario === "pedido-excavadora" && r.datos.codigo === datos.codigo);
    if (!pedido) return res.status(200).send("ok");
  }
  guardar({
    id: crypto.randomUUID(),
    fecha: new Date().toISOString(),
    formulario: b["form-name"],
    datos,
    archivo: req.file ? req.file.filename : null
  });
  res.status(200).send("ok");
  if (b["form-name"] === "pedido-excavadora") // aviso con sonido: confirmó pero aún no paga
    avisar({ title: `📝 ${datos.codigo || ""}: confirmó un pedido, aún sin pagar`, body: `${datos.nombre || ""} · ${datos.productos || ""} · ${datos.total || ""} · ${datos.ciudad || ""}`, tag: datos.codigo, url: "/admin#" + (datos.codigo || "") }).catch(() => {});
  else if (pedido) {
    const p = pedido.datos, como = datos.via === "transferencia" ? "dice que ya transfirió" : "tocó Pagar con Deuna";
    avisar({ title: `🛒 Pedido ${p.codigo}: ${como}`, body: `${p.nombre || ""} · ${p.productos || ""} · ${p.total || ""}\nA pagar ahora: ${p.a_pagar_ahora || ""} · ${p.ciudad || ""}`, tag: p.codigo, url: "/admin#" + p.codigo }).catch(() => {});
  }
  else if (b["form-name"] === "resena")
    avisar({ title: `⭐ Nueva reseña (${datos.estrellas || "?"} estrellas)`, body: `${datos.nombre || ""}: ${(datos.texto || "").slice(0, 90)}`, url: "/admin#resenas" }).catch(() => {});
  else if (b["form-name"] === "comprobante")
    avisar({ title: `💸 Comprobante ${datos.codigo || ""}`, body: `${datos.nombre || ""} subió la captura del pago`, tag: "c" + datos.codigo, url: "/admin#" + (datos.codigo || "") }).catch(() => {});
});

/* ---------- acceso al panel ---------- */
// Entra con la clave (ADMIN_CLAVE) una vez y el celular queda con la sesión abierta.
const SESION = CLAVE ? crypto.createHmac("sha256", CLAVE).update("panel-importcap").digest("hex") : "";
const cookie = req => Object.fromEntries((req.headers.cookie || "").split(";").map(c => c.trim().split("=")).filter(x => x[0]));
const igual = (a, b) => typeof a === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
function auth(req, res, next) {
  if (!CLAVE) return res.status(503).send("Configura ADMIN_CLAVE en Railway para ver los pedidos.");
  if (igual(cookie(req).ic_panel, SESION)) return next();
  const [tipo, val] = (req.headers.authorization || "").split(" ");
  const [u, p] = tipo === "Basic" ? Buffer.from(val || "", "base64").toString().split(":") : [];
  if (u === "importcap" && igual(p, CLAVE)) return next();
  if (req.method === "GET" && req.accepts("html") && !req.path.startsWith("/admin/api")) return res.redirect("/admin/entrar");
  res.status(401).send("Clave requerida");
}

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const CABEZA = t => `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex">
<title>${t}</title><link rel="manifest" href="/admin/manifest.webmanifest"><meta name="theme-color" content="#0c1a10"><link rel="apple-touch-icon" href="/admin/icon-192.png"><meta name="apple-mobile-web-app-capable" content="yes">
<style>*{box-sizing:border-box}body{font:15px/1.4 system-ui,sans-serif;margin:0;background:#0c1a10;color:#f4f1e8;padding-bottom:env(safe-area-inset-bottom)}a{color:#d2ff3c}
header{position:sticky;top:0;background:#0c1a10;padding:10px 10px 8px;border-bottom:1px solid #2a4433;z-index:2}h1{margin:0 0 8px;font-size:20px}
.btns{display:flex;gap:8px;flex-wrap:wrap}.btn{background:#d2ff3c;color:#14200b;border:0;border-radius:10px;padding:9px 12px;text-decoration:none;font:700 14px system-ui;cursor:pointer}.btn.s{background:#1b3022;color:#f4f1e8;border:1px solid #2a4433}
.tit{display:flex;align-items:center;gap:6px;margin-bottom:8px}.tit h1{margin:0 auto 0 0;font-size:18px}.mini{font:600 11px system-ui;padding:4px 8px;border:1px solid #2a4433;border-radius:20px;text-decoration:none;color:#f4f1e8}
header .btns{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}header .btns .btn{padding:7px 2px;font-size:12px;text-align:center;border-radius:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}header .btns .btn[hidden]{display:none}
.f{display:grid;grid-template-columns:repeat(5,1fr);gap:5px;margin-top:6px}.f button{padding:5px 2px!important;font-size:11.5px!important;background:#14281a;color:#b9c2b5;border:1px solid #2a4433;border-radius:20px;padding:6px 12px;font:600 13px system-ui;white-space:nowrap}.f button.on{background:#d2ff3c;color:#14200b;border-color:#d2ff3c}
main{padding:12px;display:grid;gap:12px;max-width:760px;margin:auto}main>.tabla{max-width:none}
.tabla{overflow-x:auto;margin:0 -12px;padding:0 12px}table{border-collapse:collapse;width:100%;min-width:980px}td,th{border-bottom:1px solid #2a4433;padding:10px;text-align:left;vertical-align:top}th{color:#b9c2b5;font-size:12px;text-transform:uppercase}
tr:target{background:#1b3022}.o{font-size:12px;color:#b9c2b5;max-width:180px}.nw{white-space:nowrap}.wab{display:flex;gap:6px;margin-top:8px}.wab .btn{padding:6px 8px;font-size:12px;white-space:nowrap}.nw select{flex:none;width:120px}.card{max-width:760px;width:100%;background:#14281a;border:1px solid #2a4433;border-radius:14px;padding:14px}.card:target{outline:2px solid #d2ff3c}
.top{display:flex;justify-content:space-between;gap:8px;align-items:baseline}.code{font-weight:800;color:#d2ff3c}.muted{color:#b9c2b5;font-size:13px}.tot{font-size:18px;font-weight:800}
.row{margin-top:8px}.acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.acts a,.acts button{flex:1 1 100px;text-align:center}.acts select{flex:1 1 140px}.acts .del{flex:0 0 52px}
textarea{font-family:inherit}
.est{display:inline-block;border-radius:20px;padding:2px 10px;font-size:12px;font-weight:700}.e-nuevo{background:#ffcf5a;color:#2a1c00}.e-pagado{background:#5ad2ff;color:#00222e}.e-despachado{background:#d2ff3c;color:#14200b}.e-cancelado{background:#55625a;color:#f4f1e8}
.no{color:#ff8a7a}.ok-t{color:#d2ff3c;font-weight:700}select{background:#0c1a10;color:#f4f1e8;border:1px solid #2a4433;border-radius:10px;padding:8px;font:600 14px system-ui;flex:1}
.aviso{background:#1b3022;border:1px dashed #d2ff3c;border-radius:10px;padding:6px 10px;font-size:12px;margin:8px 12px;max-width:760px}@media(min-width:800px){.aviso{margin:12px auto}}</style></head><body>`;

app.get("/admin/entrar", (req, res) => res.send(CABEZA("Entrar · Pedidos") + `<main style="max-width:380px;padding-top:15vh"><img src="/admin/icon-192.png" width="72" height="72" alt="" style="border-radius:50%"><h1>Pedidos Importcap</h1>
<form method="post" action="/admin/entrar" class="card"><label>Clave<br><input name="clave" type="password" autocomplete="current-password" required style="width:100%;margin:8px 0 12px;padding:12px;border-radius:10px;border:1px solid #2a4433;background:#0c1a10;color:#f4f1e8;font-size:16px"></label>
${req.query.mal ? '<p class="no">Clave incorrecta.</p>' : ""}<button class="btn" style="width:100%;padding:12px">Entrar</button></form></main></body></html>`));
app.post("/admin/entrar", express.urlencoded({ extended: false, limit: "2kb" }), (req, res) => {
  if (!CLAVE || !igual((req.body || {}).clave, CLAVE)) return setTimeout(() => res.redirect("/admin/entrar?mal=1"), 800);
  res.set("Set-Cookie", `ic_panel=${SESION}; Path=/admin; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`).redirect("/admin");
});
app.get("/admin/salir", (req, res) => res.set("Set-Cookie", "ic_panel=; Path=/admin; Max-Age=0").redirect("/admin/entrar"));

// archivos de la app (sin clave: no tienen datos)
for (const f of ["sw.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"])
  app.get("/admin/" + f, (req, res) => { res.set("Cache-Control", "no-cache"); if (f === "sw.js") res.set("Service-Worker-Allowed", "/admin"); res.sendFile(path.join(ROOT, "admin", f)); });

function leer() {
  if (!fs.existsSync(DB)) return [];
  return fs.readFileSync(DB, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

app.get("/admin/api/push-key", auth, (req, res) => res.json({ key: vapid.publicKey }));
app.post("/admin/api/suscribir", auth, express.json({ limit: "10kb" }), (req, res) => {
  const s = req.body;
  if (!s || typeof s.endpoint !== "string" || !/^https:\/\//.test(s.endpoint) || !s.keys) return res.status(400).send("mal");
  const subs = leerJSON(SUBS_F, []).filter(x => x.endpoint !== s.endpoint);
  subs.push({ endpoint: s.endpoint, keys: { p256dh: String(s.keys.p256dh), auth: String(s.keys.auth) } });
  fs.writeFileSync(SUBS_F, JSON.stringify(subs.slice(-20)));
  res.json({ ok: true });
});
app.get("/admin/api/resumen", auth, (req, res) => {
  res.set("Cache-Control", "no-store").json({ n: leer().length, subs: leerJSON(SUBS_F, []).length });
});
app.post("/admin/api/probar", auth, (req, res) => { avisar({ title: "🔔 Notificaciones activadas", body: "Así te avisaremos cada pedido nuevo.", url: "/admin" }).finally(() => res.json({ ok: true })); });
const ESTADOS = ["nuevo", "pagado", "despachado", "cancelado"];
// enlaces de cobro de Deuna por monto, editables desde el panel
const ENL_F = path.join(DATA, "enlaces.json"), MONTOS = ["5", "45", "50", "90", "95", "185"], VIGENCIA_DIAS = 30;
// montos que se muestran en el panel: los fijos más cualquier otro que fer haya agregado
const montosPanel = e => [...new Set(MONTOS.concat(Object.keys(e)))].sort((a, b) => a - b);
const NOTA_MONTO = { "5": "reserva contra entrega", "45": "volqueta, bulldozer o tractor", "50": "excavadora", "90": "dos de $45", "95": "excavadora + uno de $45", "135": "los tres de $45", "140": "excavadora + dos de $45", "185": "combo de los 4" };
// la primera vez arranca con los enlaces que fer mandó el 12 de noviembre
if (!fs.existsSync(ENL_F)) fs.writeFileSync(ENL_F, JSON.stringify({
  "5": { url: "https://pagar.deuna.app/H92p/U2FsdGVkX1+znLHfONc/b3rlDu3w20x6Wrj5UXo3JWvhNKzmTvATNoakXBscTqWzb0Dv1qmDEQi3HCtjjdL4Il6F2EtB1LRmCWzskEVdTTv3/7VsRIOfaFCec11WV7lBCE5Nok/T0K9LdMS3JHS13w==", fecha: "2026-11-13T00:20:00Z" },
  "45": { url: "https://pagar.deuna.app/H92p/U2FsdGVkX188AwmzjN8DClNQD8pemTQkTtrY0Ivk5/f7HO9TYb/v4HAKTUluyASIU2N8fmF9V0w0UdV7wj8A4OcCqY7DGLWd5ztGMpyDXEkpNQ6pp9Q414AbVS0/1oCwjZfVA5S4KPm7Bb/GsDeHdA==", fecha: "2026-11-13T01:04:00Z" },
  "50": { url: "https://pagar.deuna.app/H92p/U2FsdGVkX1+sbLWtaJ61ov9SUfUinkel8/++9D50lLDWUIBy3YUiHLleIgsBWHDldYPD2qPea+MaEo7DajONopyEHTpuYhaD6zYLP6n0J0oZVT6+iL9jewysnIMn2b/nHOUtE8ihasmR6idncD1STg==", fecha: "2026-11-13T00:20:00Z" }
}));
app.get("/api/enlaces", (req, res) => {
  const e = leerJSON(ENL_F, {}), out = {};
  for (const [m, x] of Object.entries(e)) if (x.url && Date.now() - Date.parse(x.fecha) < VIGENCIA_DIAS * 864e5) out[m] = x.url;
  res.set("Cache-Control", "no-store").json(out);
});
// aviso al celular 2 días antes de que venza un enlace
function revisarVencimientos() {
  const e = leerJSON(ENL_F, {}); let cambio = false;
  for (const [m, x] of Object.entries(e)) {
    const falta = Date.parse(x.fecha) + VIGENCIA_DIAS * 864e5 - Date.now();
    if (falta < 2 * 864e5 && !x.avisado) {
      x.avisado = true; cambio = true;
      avisar({ title: `⏳ El enlace de Deuna de $${m} ${falta > 0 ? "vence en " + Math.ceil(falta / 36e5) + " horas" : "ya venció"}`, body: "Crea uno nuevo en Deuna y pégalo en el panel (💳 Enlaces).", tag: "enl" + m, url: "/admin#enlaces" }).catch(() => {});
    }
  }
  if (cambio) fs.writeFileSync(ENL_F, JSON.stringify(e));
}
setInterval(revisarVencimientos, 60 * 60 * 1000); setTimeout(revisarVencimientos, 60 * 1000);

app.post("/admin/enlaces", auth, express.urlencoded({ extended: false, limit: "10kb" }), (req, res) => {
  const e = leerJSON(ENL_F, {});
  const b = req.body || {};
  const nuevo = String(b.otroMonto || "").replace(",", ".").trim();
  if (/^\d{1,4}(\.\d{1,2})?$/.test(nuevo) && +nuevo > 0) b["m" + String(+nuevo)] = b.otro;
  for (const m of montosPanel(e).concat(String(+nuevo || ""))) {
    if (!m) continue;
    const v = String(b["m" + m] || "").trim();
    if (!v) continue;
    if (v === "-") { delete e[m]; continue; }
    const url = (v.match(/https:\/\/pagar\.deuna\.app\/\S+/) || [])[0];
    if (url && (!e[m] || e[m].url !== url)) e[m] = { url, fecha: new Date().toISOString() };
  }
  fs.writeFileSync(ENL_F, JSON.stringify(e)); res.redirect("/admin?enlaces=ok");
});

// reseñas que dejan los clientes: se publican solo cuando fer las aprueba en el panel
const APR_F = path.join(DATA, "resenas-aprobadas.json");
function resenasPublicas() {
  const apr = new Set(leerJSON(APR_F, [])), bor = new Set(leerJSON(BOR_F, []));
  return leer().filter(r => r.formulario === "resena" && apr.has(r.id) && !bor.has(r.id)).reverse();
}
app.get("/api/resenas", (req, res) => {
  res.set("Cache-Control", "no-cache").json(resenasPublicas().map(r => ({
    nombre: r.datos.nombre, ciudad: r.datos.ciudad, titulo: r.datos.titulo, texto: r.datos.texto,
    estrellas: Math.min(5, Math.max(1, parseInt(r.datos.estrellas) || 5)),
    fecha: new Date(r.fecha).toLocaleDateString("es-EC", { timeZone: "America/Guayaquil" }),
    foto: r.archivo ? "/resena-foto/" + r.archivo : null
  })));
});
app.get("/resena-foto/:f", (req, res) => {
  const f = path.basename(req.params.f);
  if (!resenasPublicas().some(r => r.archivo === f)) return res.status(404).end();
  res.set("Cache-Control", "public, max-age=86400").sendFile(path.join(FILES, f), err => err && res.status(404).end());
});
app.post("/admin/api/aprobar", auth, express.json({ limit: "2kb" }), (req, res) => {
  const { id, quitar } = req.body || {};
  if (typeof id !== "string" || id.length > 60) return res.status(400).send("mal");
  const a = new Set(leerJSON(APR_F, [])); quitar ? a.delete(id) : a.add(id);
  fs.writeFileSync(APR_F, JSON.stringify([...a])); res.json({ ok: true });
});
function resenasHTML(regs, bor, fmt) {
  const apr = new Set(leerJSON(APR_F, []));
  const l = regs.filter(r => r.formulario === "resena" && !bor.has(r.id)).reverse();
  if (!l.length) return "";
  return `<div class="card" id="resenas"><b>⭐ Reseñas de clientes (${l.length})</b><p class="muted" style="margin:4px 0 0">Solo aparecen en la página las que apruebas.</p>` + l.map(r => {
    const d = r.datos, ok = apr.has(r.id), n = Math.min(5, Math.max(1, parseInt(d.estrellas) || 5));
    return `<div class="row" style="border-top:1px solid #2a4433;padding-top:10px"><span style="color:#ffc93c">${"★".repeat(n)}${"☆".repeat(5 - n)}</span> <b>${esc(d.nombre)}</b> <span class="muted">${esc(d.ciudad)} · ${esc(fmt(r.fecha))}</span>${ok ? ' <span class="est e-despachado">publicada</span>' : ' <span class="est e-nuevo">por aprobar</span>'}
${d.titulo ? `<div><b>${esc(d.titulo)}</b></div>` : ""}<div>${esc(d.texto)}</div>${r.archivo ? `<a href="/admin/comprobante/${esc(r.archivo)}" target="_blank">📷 ver foto</a>` : ""}
<div class="acts"><button class="btn${ok ? " s" : ""}" data-apr="${esc(r.id)}"${ok ? ' data-quitar="1"' : ""}>${ok ? "Ocultar" : "✓ Publicar"}</button><button class="btn s del" data-del="${esc(r.id)}" aria-label="Eliminar">🗑️</button></div></div>`;
  }).join("") + `</div>`;
}

// "eliminar" manda el pedido a la papelera (se puede recuperar); no se borra del archivo.
const BOR_F = path.join(DATA, "eliminados.json");
app.post("/admin/api/eliminar", auth, express.json({ limit: "2kb" }), (req, res) => {
  const { id, volver } = req.body || {};
  if (typeof id !== "string" || id.length > 60) return res.status(400).send("mal");
  const b = new Set(leerJSON(BOR_F, [])); volver ? b.delete(id) : b.add(id);
  fs.writeFileSync(BOR_F, JSON.stringify([...b])); res.json({ ok: true });
});
app.post("/admin/api/estado", auth, express.json({ limit: "2kb" }), (req, res) => {
  const { codigo, estado } = req.body || {};
  if (!codigo || !ESTADOS.includes(estado)) return res.status(400).send("mal");
  const e = leerJSON(EST_F, {}); e[String(codigo).slice(0, 40)] = estado; fs.writeFileSync(EST_F, JSON.stringify(e));
  res.json({ ok: true });
});

app.get("/admin/comprobante/:f", auth, (req, res) => {
  const f = path.basename(req.params.f);
  res.sendFile(path.join(FILES, f), err => err && res.status(404).end());
});

app.get("/admin/pedidos.csv", auth, (req, res) => {
  const bor = new Set(leerJSON(BOR_F, []));
  const rows = leer().filter(r => r.formulario === "pedido-excavadora" && !bor.has(r.id)), est = leerJSON(EST_F, {});
  const cols = ["fecha", "estado", "codigo", "nombre", "cedula", "telefono", "ciudad", "direccion", "ubicacion", "productos", "cantidad", "total", "pago", "a_pagar_ahora", "provincia", "tarjeta_regalo", "notas", "origen"];
  const val = (r, c) => c === "fecha" ? r.fecha : c === "estado" ? est[r.datos.codigo] || "nuevo" : r.datos[c] ?? "";
  const csv = [cols.join(",")].concat(rows.map(r => cols.map(c => '"' + String(val(r, c)).replace(/"/g, '""') + '"').join(","))).join("\n");
  res.type("text/csv").set("Content-Disposition", "attachment; filename=pedidos-importcap.csv").send("﻿" + csv);
});

function enlacesHTML() {
  const e = leerJSON(ENL_F, {});
  const fila = m => { const x = e[m]; const dias = x ? Math.floor((Date.now() - Date.parse(x.fecha)) / 864e5) : null;
    const vence = x ? new Date(Date.parse(x.fecha) + VIGENCIA_DIAS * 864e5).toISOString() : "";
    const estado = !x ? `<span class="no">falta pegar el enlace. Mientras tanto, quien pague $${m} verá el enlace general de Deuna y tendrá que escribir $${m} a mano</span>` : `<span class="cd" data-vence="${vence}">⏳</span>`;
    return `<label class="row" style="display:block"><b>$${m}</b> ${NOTA_MONTO[m] ? "(" + NOTA_MONTO[m] + ")" : ""} · ${estado}${x ? ' <span class="muted" style="font-size:12px">· escribe - para quitarlo</span>' : ""}
<textarea name="m${m}" rows="2" placeholder="Pega aquí el mensaje o enlace de Deuna de $${m}" style="width:100%;margin-top:6px;padding:10px;border-radius:10px;border:1px solid #2a4433;background:#0c1a10;color:#f4f1e8;font-size:15px"></textarea></label>`; };
  // ventana plegada: solo se abre al tocarla, o sola si algún enlace de $5, $45 o $50 falta o vence en menos de 3 días
  const urgente = ["5", "45", "50"].some(m => !e[m] || Date.parse(e[m].fecha) + VIGENCIA_DIAS * 864e5 - Date.now() < 3 * 864e5);
  return `<details class="card" id="enlaces"${urgente ? " open" : ""}><summary style="cursor:pointer;font-weight:700">💳 Enlaces de cobro Deuna ${urgente ? '<span class="no">· revisa, hay uno por vencer o sin poner</span>' : '<span class="muted" style="font-weight:400">· toca para actualizar</span>'}</summary><form method="post" action="/admin/enlaces"><p class="muted" style="margin:4px 0 0">Pega el mensaje completo que te da Deuna, yo saco el enlace. Deja vacío para no cambiarlo. Se dejan de usar a los ${VIGENCIA_DIAS} días.</p>
${montosPanel(e).map(fila).join("")}
<label class="row" style="display:block"><b>➕ Otro monto</b> <span class="muted">(por ejemplo 135 o 140 para pedidos de 3 o 4 juguetes)</span>
<input name="otroMonto" inputmode="decimal" placeholder="Monto, ej. 135" style="width:100%;margin-top:6px;padding:10px;border-radius:10px;border:1px solid #2a4433;background:#0c1a10;color:#f4f1e8;font-size:15px">
<textarea name="otro" rows="2" placeholder="Pega aquí el mensaje o enlace de Deuna de ese monto" style="width:100%;margin-top:6px;padding:10px;border-radius:10px;border:1px solid #2a4433;background:#0c1a10;color:#f4f1e8;font-size:15px"></textarea></label>
<p class="muted" style="margin:8px 0 0">Si un cliente pide un monto que no tiene enlace, la página le muestra el enlace general de Deuna y le dice qué monto escribir, junto con la transferencia.</p><button class="btn" style="width:100%;margin-top:12px;padding:12px">Guardar enlaces</button></form></details>`;
}

app.get("/admin", auth, (req, res) => {
  const regs = leer(), est = leerJSON(EST_F, {}), bor = new Set(leerJSON(BOR_F, []));
  const comp = {}, intento = {};
  regs.filter(r => r.formulario === "pago-iniciado").forEach(r => { (intento[r.datos.codigo] ||= []).push(r.datos.via); });
  regs.filter(r => r.formulario === "comprobante").forEach(r => { (comp[r.datos.codigo] ||= []).push(r); });
  const todos = regs.filter(r => r.formulario === "pedido-excavadora").reverse();
  const pedidos = todos.filter(r => !bor.has(r.id)), papelera = todos.filter(r => bor.has(r.id));
  const fmt = iso => new Date(iso).toLocaleString("es-EC", { timeZone: "America/Guayaquil", dateStyle: "short", timeStyle: "short" });
  const tarjetas = todos.map(r => {
    const d = r.datos, cs = comp[d.codigo] || [], borrado = bor.has(r.id), e = borrado ? "papelera" : est[d.codigo] || "nuevo";
    const tel = String(d.telefono || "").replace(/\D/g, "").replace(/^0/, "593");
    // mensajes de WhatsApp listos: un toque abre el chat del cliente con el texto escrito
    const nom = String(d.nombre || "").trim().split(/\s+/)[0] || "";
    const contra = /contra/i.test(d.pago || "");
    const msgRecibido = `Hola ${nom} 👋, somos Importcap. Recibimos tu pedido ${d.codigo}: ${d.productos || d.cantidad + " × excavadora"}, total ${d.total}.\n\n` +
      (cs.some(c => c.archivo) ? "Ya tenemos tu comprobante, lo estamos revisando." : `Para empezar a despacharlo, envíanos por aquí la foto del comprobante de ${d.a_pagar_ahora || "tu pago"}${contra ? " (la reserva; el resto lo pagas al recibir)" : ""}.`);
    const msgAprobado = `Hola ${nom} ✅, tu pago del pedido ${d.codigo} fue aprobado. Ya estamos preparando tu envío y te avisamos por aquí cuando salga, con el número de guía. ¡Gracias por confiar en Importcap!`;
    const wa = t => `https://wa.me/${tel}?text=${encodeURIComponent(t)}`;
    const comps = cs.filter(c => c.archivo).map((c, i) => `<a href="/admin/comprobante/${esc(c.archivo)}" target="_blank">🧾 comprobante${cs.length > 1 ? " " + (i + 1) : ""}</a>`).join("<br>");
    const maps = /^https:\/\//.test(d.ubicacion || "") ? `<br><a href="${esc(d.ubicacion)}" target="_blank">📍 ver en Maps</a>` : d.ubicacion ? `<br>📍 ${esc(d.ubicacion)}` : "";
    const accion = borrado ? `<button class="btn s" data-del="${esc(r.id)}" data-volver="1">↩️ Recuperar</button>`
      : `<select data-c="${esc(d.codigo)}">${ESTADOS.map(x => `<option${x === e ? " selected" : ""}>${x}</option>`).join("")}</select> <button data-del="${esc(r.id)}" class="btn s del" aria-label="Eliminar">🗑️</button>`;
    return `<tr id="${esc(d.codigo)}" data-e="${e}"${borrado ? " hidden" : ""}><td>${esc(fmt(r.fecha))}<br><b class="code">${esc(d.codigo)}</b><br><span class="est e-${e}">${e}</span></td>
<td><b>${esc(d.nombre)}</b>${d.cedula ? `<br><span class="muted">CI ${esc(d.cedula)}</span>` : ""}<br><a href="https://wa.me/${esc(tel)}" target="_blank">${esc(d.telefono)}</a><div class="wab"><a class="btn s" href="${esc(wa(msgRecibido))}" target="_blank">📲 Recibido</a><a class="btn s" href="${esc(wa(msgAprobado))}" target="_blank" data-aprobar="${esc(d.codigo)}">✅ Aprobado</a></div></td>
<td>${esc(d.direccion)}<br>${esc(d.ciudad)}${d.provincia ? ", " + esc(d.provincia) : ""}${maps}${d.notas ? `<br>📝 ${esc(d.notas)}` : ""}</td>
<td>${esc(d.productos || d.cantidad + " × excavadora")}<br><b>${esc(d.total)}</b></td>
<td>${esc(d.pago)}<br>Ahora: ${esc(d.a_pagar_ahora)}<br>${(intento[d.codigo] || []).map(v => `<span class="ok-t">👉 ${v === "transferencia" ? "dice que transfirió" : "tocó Pagar con Deuna"}</span><br>`).join("")}${comps || '<span class="no">sin comprobante</span>'}</td>
<td class="nw">${accion}</td><td class="o">${esc(d.origen)}</td></tr>`;
  }).join("");
  const sueltos = regs.filter(r => r.formulario === "comprobante" && !bor.has(r.id) && !todos.some(p => p.datos.codigo === r.datos.codigo));
  const cuenta = x => pedidos.filter(r => (est[r.datos.codigo] || "nuevo") === x).length;
  res.set("Cache-Control", "no-store").send(CABEZA(`Pedidos (${pedidos.length}) · Importcap`) + `
<header><div class="tit"><h1>Pedidos (${pedidos.length})</h1><a class="mini" href="/excavadora/" target="_blank">🛒 Ventas</a><a class="mini" href="/" target="_blank">🏠 Importcap</a></div><div class="btns"><button class="btn" id="noti" hidden>🔔 Activar avisos</button><button class="btn s" id="probar" hidden>🔔 Probar</button><button class="btn s" id="inst" hidden>📲 Instalar</button><a class="btn s" href="/admin">↻ Actualizar</a><a class="btn s" href="#resenas">⭐ Reseñas</a><a class="btn s" href="#enlaces">💳 Enlaces</a><a class="btn s" href="/admin/pedidos.csv">Excel</a><a class="btn s" href="/admin/salir">Salir</a></div>
<div class="f" id="f"><button class="on" data-f="">Todos</button>${ESTADOS.map(x => `<button data-f="${x}">${({ nuevo: "Nuevos", pagado: "Pagados", despachado: "Enviados", cancelado: "Cancel." })[x]} ${cuenta(x)}</button>`).join("")}${papelera.length ? `<button data-f="papelera">🗑️ papelera (${papelera.length})</button>` : ""}</div></header>
<div id="pushInfo" hidden style="display:flex;gap:8px;align-items:center;margin:6px 12px 0;font-size:12px;color:#b9c2b5"><span id="pushTxt" style="flex:1"></span><button type="button" id="pushX" aria-label="Cerrar" style="background:none;border:0;color:#b9c2b5;font-size:16px;cursor:pointer;padding:2px 6px">✕</button></div>
<div class="aviso" id="ios" hidden>En iPhone: toca <b>Compartir</b> → <b>Agregar a pantalla de inicio</b>, abre la app desde ahí y luego activa las notificaciones.</div>
<main style="max-width:none">${req.query.enlaces ? '<div class="card" id="guardado" style="border-color:#d2ff3c;padding:10px 14px">✓ Enlaces guardados. La página ya usa los nuevos.</div>' : ""}<div class="tabla"><table><thead><tr><th>Fecha / código</th><th>Cliente</th><th>Dirección</th><th>Pedido</th><th>Pago</th><th>Estado</th><th>Anuncio</th></tr></thead><tbody>${tarjetas || '<tr><td colspan="7">Todavía no hay pedidos.</td></tr>'}</tbody></table></div>
${resenasHTML(regs, bor, fmt)}
${enlacesHTML()}
${sueltos.length ? `<div class="card"><b>Comprobantes sin pedido</b><p class="muted" style="margin:4px 0 0">Capturas que llegaron con un código que no está en la lista. Bórralas con 🗑️ si no sirven.</p>` + sueltos.map(s => `<div class="row">${esc(fmt(s.fecha))} · ${esc(s.datos.codigo)} · ${esc(s.datos.nombre)} · <a href="/admin/comprobante/${esc(s.archivo)}" target="_blank">ver</a> <button data-del="${esc(s.id)}" class="btn s del" aria-label="Borrar">🗑️</button></div>`).join("") + `</div>` : ""}</main>
<script>
const $ = s => document.querySelector(s);
document.querySelectorAll("select[data-c]").forEach(s => s.onchange = async () => {
  const r = await fetch("/admin/api/estado", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ codigo: s.dataset.c, estado: s.value }) });
  if (r.ok) { const c = s.closest("tr"); c.dataset.e = s.value; const b = c.querySelector(".est"); b.className = "est e-" + s.value; b.textContent = s.value; } else alert("No se pudo guardar");
});
$("#f").onclick = e => { const b = e.target.closest("button"); if (!b) return; document.querySelectorAll("#f button").forEach(x => x.classList.toggle("on", x === b));
  document.querySelectorAll("tr[data-e]").forEach(c => c.hidden = b.dataset.f ? c.dataset.e !== b.dataset.f : c.dataset.e === "papelera"); };
function cuentaAtras() {
  document.querySelectorAll(".cd[data-vence]").forEach(el => {
    const ms = Date.parse(el.dataset.vence) - Date.now();
    if (ms <= 0) { el.className = "cd no"; el.textContent = "⛔ vencido, pon uno nuevo"; return; }
    const d = Math.floor(ms / 864e5), h = Math.floor(ms % 864e5 / 36e5), m = Math.floor(ms % 36e5 / 6e4);
    el.className = "cd " + (ms < 3 * 864e5 ? "no" : "ok-t");
    el.textContent = "⏳ vence en " + d + " d " + h + " h " + m + " min";
  });
}
cuentaAtras(); setInterval(cuentaAtras, 30000);
document.querySelectorAll("[data-apr]").forEach(b => b.onclick = async () => {
  const r = await fetch("/admin/api/aprobar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: b.dataset.apr, quitar: !!b.dataset.quitar }) });
  if (r.ok) location.reload(); else alert("No se pudo");
});
document.querySelectorAll("[data-aprobar]").forEach(a => a.addEventListener("click", () => {
  const s = document.querySelector('select[data-c="' + a.dataset.aprobar + '"]');
  if (s && s.value === "nuevo") { s.value = "pagado"; s.dispatchEvent(new Event("change")); }
}));
document.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
  const volver = !!b.dataset.volver;
  if (!volver && !confirm("¿Eliminar? Queda en la papelera por si te equivocas.")) return;
  const r = await fetch("/admin/api/eliminar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: b.dataset.del, volver }) });
  if (r.ok) location.reload(); else alert("No se pudo");
});
let ev; addEventListener("beforeinstallprompt", e => { e.preventDefault(); ev = e; $("#inst").hidden = false; });
$("#inst").onclick = async () => { if (!ev) return; ev.prompt(); await ev.userChoice; $("#inst").hidden = true; };
const ios = /iphone|ipad/i.test(navigator.userAgent), solo = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
if (ios && !solo) $("#ios").hidden = false;
const b64 = s => { const p = "=".repeat((4 - s.length % 4) % 4), r = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from([...r].map(c => c.charCodeAt(0))); };
async function activar() {
  const reg = await navigator.serviceWorker.ready;
  if ((await Notification.requestPermission()) !== "granted") { alert("Permite las notificaciones en los ajustes del navegador para recibir avisos."); return; }
  const { key } = await (await fetch("/admin/api/push-key")).json();
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
  await fetch("/admin/api/suscribir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sub) });
  await fetch("/admin/api/probar", { method: "POST" });
  $("#noti").textContent = "🔔 Avisos ✓"; $("#noti").classList.add("s");
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/admin/sw.js", { scope: "/admin" }).then(async reg => {
  if (!("PushManager" in window)) return;
  $("#noti").hidden = false; $("#noti").onclick = () => activar().catch(e => alert("No se pudo activar: " + e.message));
  const s = await reg.pushManager.getSubscription();
  if (s && Notification.permission === "granted") { $("#noti").textContent = "🔔 Avisos ✓"; $("#noti").classList.add("s");
    fetch("/admin/api/suscribir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s) }); }
});
/* con el panel abierto: revisa cada 20 s y suena si llega algo nuevo */
let ctxA, ultimo = null;
const pita = () => { try { ctxA = ctxA || new (window.AudioContext || window.webkitAudioContext)(); [0, .25, .5].forEach(t => { const o = ctxA.createOscillator(), g = ctxA.createGain(); o.frequency.value = 880; o.connect(g); g.connect(ctxA.destination); g.gain.setValueAtTime(.4, ctxA.currentTime + t); g.gain.exponentialRampToValueAtTime(.001, ctxA.currentTime + t + .2); o.start(ctxA.currentTime + t); o.stop(ctxA.currentTime + t + .22); }); } catch {} };
document.addEventListener("pointerdown", () => { try { ctxA = ctxA || new (window.AudioContext || window.webkitAudioContext)(); ctxA.resume(); } catch {} }, { once: true });
async function revisa() {
  try {
    const j = await (await fetch("/admin/api/resumen")).json();
    const info = $("#pushInfo");
    if (ultimo !== null && j.n > ultimo) { pita(); if (navigator.vibrate) navigator.vibrate([200, 100, 200]); setTimeout(() => location.reload(), 1500); }
    ultimo = j.n;
    const cerrado = localStorage.getItem("ic_pushX");
    if (Notification.permission === "granted" && j.subs) { $("#probar").hidden = false; info.hidden = cerrado === "ok"; $("#pushTxt").textContent = "🔔 Avisos activos en " + j.subs + " celular" + (j.subs > 1 ? "es" : ""); info.dataset.k = "ok"; }
    else if (Notification.permission === "denied") { info.hidden = cerrado === "no"; $("#pushTxt").textContent = "🔕 Notificaciones bloqueadas: candado junto a la dirección → Permisos → Notificaciones"; info.dataset.k = "no"; }
  } catch {}
}
revisa(); setInterval(revisa, 20000);
const abreEnl = () => { if (location.hash === "#enlaces") { $("#enlaces").open = true; $("#enlaces").scrollIntoView(); } };
addEventListener("hashchange", abreEnl); abreEnl();
document.querySelector('a[href="#enlaces"]').addEventListener("click", () => { $("#enlaces").open = true; });
$("#pushX").onclick = () => { localStorage.setItem("ic_pushX", $("#pushInfo").dataset.k || "ok"); $("#pushInfo").hidden = true; };
if ($("#guardado")) { setTimeout(() => $("#guardado").remove(), 4000); history.replaceState(null, "", "/admin" + location.hash); }
$("#probar").onclick = async () => { $("#probar").textContent = "Enviando…"; await fetch("/admin/api/probar", { method: "POST" }); $("#probar").textContent = "🔔 Probar"; };
document.addEventListener("visibilitychange", () => { if (!document.hidden) revisa(); });
</script></body></html>`);
});

/* ---------- web estática: solo las carpetas públicas ---------- */
const est = { maxAge: "1h", extensions: ["html"], setHeaders: (res, f) => { if (f.endsWith(".html")) res.set("Cache-Control", "no-cache"); } };
app.use("/img", express.static(path.join(ROOT, "img"), est));
app.use("/excavadora", express.static(path.join(ROOT, "excavadora"), est));
for (const f of ["index.html", "robots.txt", "sitemap.xml"]) app.get("/" + f, (req, res) => res.set("Cache-Control", "no-cache").sendFile(path.join(ROOT, f)));
app.get("/", (req, res) => res.sendFile(path.join(ROOT, "index.html")));
app.use((req, res) => res.status(404).sendFile(path.join(ROOT, "index.html")));

app.use((err, req, res, next) => { console.error(err); res.status(400).send("No se pudo procesar"); });

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Importcap escuchando en", port, "datos en", DATA));
