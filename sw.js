// Guarda la app entera en el celular la primera vez, así después anda sin internet.
// Al cambiar cualquier archivo, subir VERSION para que los celulares bajen la nueva.
const VERSION = 'scannerfree-v11';
const ARCHIVOS = [
    './', 'index.html', 'app.css', 'app.js', 'manifest.json',
    'fuentes/bricolage.woff2',
    'iconos/icono.svg', 'iconos/icono-180.png', 'iconos/icono-192.png', 'iconos/icono-512.png', 'iconos/icono-mascara-512.png',
    'vendor/opencv.js', 'vendor/pdf-lib.min.js', 'vendor/tesseract.min.js', 'vendor/worker.min.js',
    'vendor/tesseract-core/tesseract-core-lstm.wasm.js',
    'vendor/tesseract-core/tesseract-core-simd-lstm.wasm.js',
    'vendor/tesseract-core/tesseract-core-relaxedsimd-lstm.wasm.js',
    'vendor/lang/spa.traineddata.gz',
    'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs', 'vendor/qrcode/qrcode.js',
];

// Más o menos cuánto pesa cada archivo grande (en KB), para que la barra de «Preparando» avance parejo
const PESOS = {
    'vendor/opencv.js': 10600, 'vendor/lang/spa.traineddata.gz': 2050, 'vendor/pdfjs/pdf.worker.min.mjs': 1380,
    'vendor/tesseract-core/tesseract-core-lstm.wasm.js': 3800, 'vendor/tesseract-core/tesseract-core-simd-lstm.wasm.js': 3800,
    'vendor/tesseract-core/tesseract-core-relaxedsimd-lstm.wasm.js': 3800, 'vendor/pdf-lib.min.js': 510, 'vendor/pdfjs/pdf.min.mjs': 390,
};
const peso = (a) => PESOS[a] || 40;

// Le cuenta a la app cómo va, para el aviso de la primera vez («Preparando ScannerFree para que funcione sin internet»)
async function contar(mensaje) {
    for (const cliente of await self.clients.matchAll({ includeUncontrolled: true, type: 'window' })) cliente.postMessage(mensaje);
}

self.addEventListener('install', (ev) => {
    const primeraVez = !self.registration.active;   // si ya había una versión, es una actualización: va sin aviso
    ev.waitUntil((async () => {
        const cache = await caches.open(VERSION);
        const total = ARCHIVOS.reduce((s, a) => s + peso(a), 0);
        let hecho = 0;
        await Promise.all(ARCHIVOS.map(async (a) => {
            // cache: 'reload' pide cada archivo de nuevo al servidor: sin eso, una actualización podía guardar la copia vieja
            const resp = await fetch(new Request(a, { cache: 'reload' }));
            if (!resp.ok) throw new Error(`No se pudo bajar ${a}`);
            await cache.put(a, resp);
            hecho += peso(a);
            if (primeraVez) contar({ tipo: 'preparando', avance: hecho / total });
        }));
        if (primeraVez) contar({ tipo: 'preparada' });
        self.skipWaiting();
    })());
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
