# Importcap web

Página de Importcap (Ambato). Netlify publica esta carpeta tal cual: no hay paso de compilación.

La fuente para editar está en la carpeta del proyecto (`web/fuente/importcap.html`). Se arma con
`python3 web/fuente/build_netlify.py https://SITIO.netlify.app [codigo-google]` y el resultado
(`web/netlify/importcap/`) se copia aquí.

Cada push a `main` lo publica Netlify en https://importcap.netlify.app (el repositorio es público para que Netlify acepte los cambios en el plan gratis).
