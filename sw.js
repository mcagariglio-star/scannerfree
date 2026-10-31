// Guarda la app entera en el celular la primera vez, así después anda sin internet.
// Al cambiar cualquier archivo, subir VERSION para que los celulares bajen la nueva.
const VERSION = 'scannerfree-v3';
const ARCHIVOS = [
    './', 'index.html', 'app.css', 'app.js', 'manifest.json',
    'fuentes/bricolage.woff2',
    'iconos/icono.svg', 'iconos/icono-180.png', 'iconos/icono-192.png', 'iconos/icono-512.png', 'iconos/icono-mascara-512.png',
    'vendor/opencv.js', 'vendor/pdf-lib.min.js', 'vendor/tesseract.min.js', 'vendor/worker.min.js',
    'vendor/tesseract-core/tesseract-core-lstm.wasm.js',
    'vendor/tesseract-core/tesseract-core-simd-lstm.wasm.js',
    'vendor/tesseract-core/tesseract-core-relaxedsimd-lstm.wasm.js',
    'vendor/lang/spa.traineddata.gz',
    'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs',
];

self.addEventListener('install', (ev) => {
    ev.waitUntil(caches.open(VERSION).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (ev) => {
    ev.waitUntil(caches.keys()
        .then((claves) => Promise.all(claves.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
        .then(() => self.clients.claim()));
});

// Primero lo guardado; si no está, de la red (y se guarda para la próxima)
self.addEventListener('fetch', (ev) => {
    const pedido = ev.request;
    if (pedido.method !== 'GET' || new URL(pedido.url).origin !== location.origin) return;
    ev.respondWith(caches.match(pedido, { ignoreSearch: true }).then((guardado) => guardado || fetch(pedido).then((resp) => {
        if (resp.ok) {
            const copia = resp.clone();
            caches.open(VERSION).then((c) => c.put(pedido, copia));
        }
        return resp;
    })));
});
