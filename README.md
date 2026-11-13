# Importcap web

Página de Importcap (Ambato). Netlify publica esta carpeta tal cual: no hay paso de compilación.

La fuente para editar está en la carpeta del proyecto (`web/fuente/importcap.html`). Se arma con
`python3 web/fuente/build_netlify.py https://SITIO.netlify.app [codigo-google]` y el resultado
(`web/netlify/importcap/`) se copia aquí.

Cada push a `main` lo publica Netlify en https://importcap.netlify.app (el repositorio es público para que Netlify acepte los cambios en el plan gratis).

## Página de pedido de la excavadora (`/excavadora/`)

Página de una sola compra para los anuncios de Meta: https://importcap.squadraec.com/excavadora/
Se edita directo aquí (`excavadora/index.html`), no pasa por `build_netlify.py`. Precios, envío, pago,
garantía, píxel de Meta y testimonios se cambian en el bloque `CONFIG` al inicio del `<script>`.
Los pedidos llegan por Netlify Forms (formulario `pedido-excavadora`): Netlify > Forms.

## Servidor para Railway (opcional)

`server.js` muestra la misma web y guarda los formularios (pedidos y comprobantes de Deuna) sin Netlify.
En Railway: nuevo servicio desde este repositorio (arranca con `npm start`), agregar un volumen montado
en `/data`, y las variables `DATA_DIR=/data` y `ADMIN_CLAVE=<clave>`. Los pedidos se ven en `/admin`
(usuario `importcap`) y se descargan en CSV.

## App de pedidos (/admin)

- Entra a `https://importcap.squadraec.com/admin` con la clave `ADMIN_CLAVE`. La sesión queda abierta en ese celular.
- Android (Chrome): toca **📲 Instalar app**. iPhone: Compartir → Agregar a pantalla de inicio, y ábrela desde ahí.
- Toca **🔔 Activar notificaciones**: llega un aviso con cada pedido nuevo y cada comprobante.
- Cada pedido tiene estado (nuevo, pagado, despachado, cancelado) y se puede mandar a la papelera y recuperar.
- **💳 Enlaces**: pega el mensaje de cobro de Deuna de $5, $45 o $50 y la página lo usa al instante. Se dejan de usar a los 30 días.
- Datos en el volumen: `pedidos.jsonl`, `comprobantes/`, `estados.json`, `eliminados.json`, `enlaces.json`, `suscripciones.json`, `vapid.json` (llaves de notificaciones, se crean solas).
