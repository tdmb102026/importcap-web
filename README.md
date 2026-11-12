# Importcap web

Página de Importcap (Ambato). Netlify publica esta carpeta tal cual: no hay paso de compilación.

La fuente para editar está en la carpeta del proyecto (`web/fuente/importcap.html`). Se arma con
`python3 web/fuente/build_netlify.py https://SITIO.netlify.app [codigo-google]` y el resultado
(`web/netlify/importcap/`) se copia aquí.

Cada push a `main` lo publica Netlify en https://importcap.netlify.app (el repositorio es público para que Netlify acepte los cambios en el plan gratis).

## Página de pedido de la excavadora (`/excavadora/`)

Página de una sola compra para los anuncios de Meta: https://importcap.netlify.app/excavadora/
Se edita directo aquí (`excavadora/index.html`), no pasa por `build_netlify.py`. Precios, envío, pago,
garantía, píxel de Meta y testimonios se cambian en el bloque `CONFIG` al inicio del `<script>`.
Los pedidos llegan por Netlify Forms (formulario `pedido-excavadora`): Netlify > Forms.
