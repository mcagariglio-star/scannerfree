# ScannerFree

Escáner de documentos **gratis, sin publicidad y sin cuenta**. Le sacás foto a cada hoja: la app encuentra los bordes, la endereza, la deja prolija y arma un PDF donde se puede buscar y copiar el texto.

**Tus fotos no salen del celular.** Todo se procesa en el teléfono: no hay servidor, no hay registro, no hay seguimiento. La página ni siquiera tiene permiso para conectarse a otros sitios (lo bloquea su `Content-Security-Policy`).

## Qué hace

- Foto con la cámara o desde la galería, varias hojas por documento
- Detecta las esquinas de la hoja sola; si hace falta, las corregís con el dedo (con lupa)
- Filtros: color (blanquea el papel), grises y blanco y negro
- Girar, reordenar y sacar hojas
- PDF con el texto reconocido (OCR en español) invisible encima de la imagen
- Compartir directo (WhatsApp, mail, Drive…) o descargar
- **Herramientas PDF**: unir varios PDF, eliminar páginas, girarlas y reordenarlas, y crear un PDF desde fotos. Las páginas se copian tal cual: el texto y la calidad no cambian
- **Mis documentos**: los PDF que hacés quedan guardados en el celular para verlos, compartirlos, renombrarlos, editarlos o borrarlos
- Inicio con todo a mano y pasos guiados: tomá la foto, ajustá, guardá en PDF, ¡listo!
- Se instala como app y anda sin internet
- Si el navegador se cierra mientras sacás la foto, las hojas quedan guardadas en el celular

## Cómo está hecha

Es una página web común (HTML, CSS y JavaScript, sin compilar nada) que se instala como app (PWA).

- `app.js` — toda la lógica: detección de bordes y enderezado con OpenCV.js, filtros, editor de esquinas, OCR con Tesseract.js, PDF con pdf-lib y las herramientas PDF (las miniaturas las dibuja pdf.js)
- `sw.js` — guarda la app en el celular para que ande sin internet (al cambiar archivos, subir `VERSION`)
- `vendor/` — las librerías, incluidas tal cual (ver [vendor/LICENCIAS.md](vendor/LICENCIAS.md))

La primera vez que se abre baja unos 25 MB (el detector de bordes y el OCR); después ya queda en el celular.

## Probarla en la PC

```
python herramientas/servidor.py
```

Abrí `http://localhost:8030`. Desde el celular, en la misma red Wi-Fi, abrí la dirección que muestra el servidor. Instalarla, usarla sin internet y el botón «Compartir» necesitan HTTPS; por eso andan en `localhost` y en la versión publicada, pero no en la dirección de la red local.

## Licencia

[GPL-3.0](LICENSE). Podés usarla, copiarla, cambiarla y compartirla; si distribuís una versión cambiada, tiene que seguir siendo libre y con el código abierto.
