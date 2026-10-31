/*
 * ScanerFree — escáner de documentos que corre entero en el navegador.
 *
 * Por cada hoja:
 *   1. La foto se achica a LADO_FOTO px (parada como se ve en la galería) y se guarda en el celular (IndexedDB),
 *      así no se pierde si el navegador se cierra mientras está abierta la cámara.
 *   2. detectarEsquinas(): OpenCV busca el cuadrilátero más grande (la hoja); si no lo encuentra, la foto entera.
 *      El usuario las corrige con el dedo en el editor.
 *   3. procesar(): endereza la hoja con esas esquinas, le aplica el filtro (color, grises o blanco y negro) y el giro.
 *   4. crearPdf(): una página por hoja; con OCR (Tesseract, español) cada página lleva el texto invisible encima
 *      de la imagen, así el PDF se puede buscar y copiar.
 *
 * Nada sale del celular: la página no tiene permiso para conectarse a ningún otro sitio (ver la CSP en index.html).
 */
'use strict';

const LADO_FOTO = 2600;   // px del lado largo de la foto que se guarda
const LADO_HOJA = 2400;   // px del lado largo de la hoja enderezada (~200 ppp en A4)
const LADO_MINI = 480;    // px de las miniaturas
const LADO_BUSCAR = 800;  // px de la foto chica donde se buscan los bordes
const FILTROS = ['color', 'grises', 'byn'];
const ENTERA = [[0, 0], [1, 0], [1, 1], [0, 1]];

const $ = (id) => document.getElementById(id);
const espera = () => new Promise((ok) => setTimeout(ok, 0));

// Cada hoja: {id, foto (Blob), ancho, alto, esquinas, encontrada, filtro, giro, hoja (Blob procesado), mini (URL), fotoUrl}
let hojas = [];
let pdfListo = null;   // {blob, nombre, url}

// ── Guardado en el celular (IndexedDB) ──

const db = (() => {
    let abierta = null;
    const abrir = () => abierta || (abierta = new Promise((ok, mal) => {
        const pedido = indexedDB.open('scanerfree', 1);
        pedido.onupgradeneeded = () => pedido.result.createObjectStore('hojas', { keyPath: 'id' });
        pedido.onsuccess = () => ok(pedido.result);
        pedido.onerror = () => mal(pedido.error);
    }));
    const tx = async (modo, f) => {
        const base = await abrir();
        return new Promise((ok, mal) => {
            const t = base.transaction('hojas', modo);
            const pedido = f(t.objectStore('hojas'));
            t.oncomplete = () => ok(pedido && pedido.result);
            t.onerror = () => mal(t.error);
        });
    };
    // Si el navegador no deja guardar (modo incógnito, poco espacio), la app sigue andando sin guardar
    const seguro = (f) => async (...args) => { try { return await f(...args); } catch (e) { return null; } };
    return {
        todas: seguro(() => tx('readonly', (s) => s.getAll())),
        guardar: seguro((h, orden) => tx('readwrite', (s) => s.put({
            id: h.id, foto: h.foto, ancho: h.ancho, alto: h.alto, esquinas: h.esquinas, encontrada: h.encontrada,
            filtro: h.filtro, giro: h.giro, hoja: h.hoja, orden,
        }))),
        borrar: seguro((id) => tx('readwrite', (s) => s.delete(id))),
        vaciar: seguro(() => tx('readwrite', (s) => s.clear())),
    };
})();

const guardarOrden = () => Promise.all(hojas.map((h, i) => db.guardar(h, i)));

// ── Librerías (se cargan recién cuando hacen falta) ──

function cargarScript(src) {
    return new Promise((ok, mal) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = ok;
        s.onerror = () => mal(new Error(`No pude cargar ${src}`));
        document.head.appendChild(s);
    });
}

let cvListo = null;
function cargarCv() {
    if (!cvListo) {
        cvListo = cargarScript('vendor/opencv.js').then(() => new Promise((ok) => {
            const cv = window.cv;
            if (cv.Mat) return ok(cv);
            // Según cómo esté armado opencv.js, avisa con onRuntimeInitialized o es una promesa
            if (typeof cv.then === 'function') {
                cv.then((listo) => { delete listo.then; window.cv = listo; ok(listo); });
            } else {
                cv.onRuntimeInitialized = () => ok(cv);
            }
        }));
        cvListo.catch(() => { cvListo = null; });
    }
    return cvListo;
}

let ocrListo = null, ocrProgreso = null;
function cargarOcr() {
    if (!ocrListo) {
        const base = new URL('vendor/', location.href).href;
        ocrListo = (window.Tesseract ? Promise.resolve() : cargarScript('vendor/tesseract.min.js'))
            .then(() => Tesseract.createWorker('spa', 1, {
                workerPath: base + 'worker.min.js',
                corePath: base + 'tesseract-core',
                langPath: base + 'lang',
                workerBlobURL: false,
                cacheMethod: 'none',   // el idioma ya lo guarda el service worker
                logger: (m) => ocrProgreso && ocrProgreso(m),
            }));
        ocrListo.catch(() => { ocrListo = null; });
    }
    return ocrListo;
}

// ── Imágenes ──

function lienzo(ancho, alto) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(ancho));
    c.height = Math.max(1, Math.round(alto));
    return c;
}

function aBlob(canvas, calidad = 0.85) {
    return new Promise((ok, mal) => canvas.toBlob((b) => (b ? ok(b) : mal(new Error('Sin memoria para la imagen'))), 'image/jpeg', calidad));
}

async function dibujar(origen, ladoMax) {
    const bmp = origen instanceof Blob ? await createImageBitmap(origen, { imageOrientation: 'from-image' }) : origen;
    const f = Math.min(1, ladoMax / Math.max(bmp.width, bmp.height));
    const c = lienzo(bmp.width * f, bmp.height * f);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close && origen instanceof Blob) bmp.close();
    return c;
}

// arriba-izq, arriba-der, abajo-der, abajo-izq
function ordenar(pts) {
    const suma = pts.map(([x, y]) => x + y), resta = pts.map(([x, y]) => y - x);
    const iMin = (a) => a.indexOf(Math.min(...a)), iMax = (a) => a.indexOf(Math.max(...a));
    return [pts[iMin(suma)], pts[iMin(resta)], pts[iMax(suma)], pts[iMax(resta)]];
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

async function detectarEsquinas(foto) {
    const cv = await cargarCv();
    const chica = await dibujar(foto, LADO_BUSCAR);
    const src = cv.imread(chica), gris = new cv.Mat(), bordes = new cv.Mat();
    const contornos = new cv.MatVector(), jerarquia = new cv.Mat(), nucleo = cv.Mat.ones(3, 3, cv.CV_8U);
    try {
        cv.cvtColor(src, gris, cv.COLOR_RGBA2GRAY);
        cv.GaussianBlur(gris, gris, new cv.Size(5, 5), 0);
        cv.Canny(gris, bordes, 50, 150);
        cv.dilate(bordes, bordes, nucleo, new cv.Point(-1, -1), 2);
        cv.findContours(bordes, contornos, jerarquia, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
        const lista = [];
        for (let i = 0; i < contornos.size(); i++) {
            const c = contornos.get(i);
            lista.push({ c, area: cv.contourArea(c) });
        }
        lista.sort((a, b) => b.area - a.area);
        const areaMin = 0.2 * chica.width * chica.height;
        let encontradas = null;
        for (const { c, area } of lista.slice(0, 8)) {
            if (area < areaMin) break;
            const aprox = new cv.Mat();
            cv.approxPolyDP(c, aprox, 0.02 * cv.arcLength(c, true), true);
            if (aprox.rows === 4 && cv.isContourConvex(aprox)) {
                const d = aprox.data32S, pts = [];
                for (let j = 0; j < 4; j++) pts.push([d[j * 2] / chica.width, d[j * 2 + 1] / chica.height]);
                encontradas = ordenar(pts);
            }
            aprox.delete();
            if (encontradas) break;
        }
        lista.forEach(({ c }) => c.delete());
        return encontradas;
    } finally {
        [src, gris, bordes, contornos, jerarquia, nucleo].forEach((m) => m.delete());
    }
}

// La hoja enderezada (vista de frente), con el filtro y girada `giro` cuartos de vuelta a la derecha
async function procesar(h) {
    const cv = await cargarCv();
    const foto = await dibujar(h.foto, LADO_FOTO);
    const W = foto.width, H = foto.height;
    const pts = ordenar(h.esquinas).map(([x, y]) => [Math.min(1, Math.max(0, x)) * W, Math.min(1, Math.max(0, y)) * H]);
    const [a, b, c, d] = pts;
    let w = Math.max(dist(a, b), dist(d, c)), alto = Math.max(dist(a, d), dist(b, c));
    const f = Math.min(1, LADO_HOJA / Math.max(w, alto, 1));
    w = Math.max(1, Math.round(w * f)); alto = Math.max(1, Math.round(alto * f));

    const rgba = cv.imread(foto), src = new cv.Mat(), hoja = new cv.Mat(), salida = new cv.Mat();
    const desde = cv.matFromArray(4, 1, cv.CV_32FC2, pts.flat());
    const hasta = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, alto, 0, alto]);
    const M = cv.getPerspectiveTransform(desde, hasta);
    try {
        cv.cvtColor(rgba, src, cv.COLOR_RGBA2RGB);
        cv.warpPerspective(src, hoja, M, new cv.Size(w, alto), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
        filtrar(cv, hoja, salida, FILTROS.includes(h.filtro) ? h.filtro : 'color');
        const plana = lienzo(w, alto);
        cv.imshow(plana, salida);
        return girar(plana, h.giro);
    } finally {
        [rgba, src, hoja, salida, desde, hasta, M].forEach((m) => m.delete());
    }
}

function filtrar(cv, hoja, salida, filtro) {
    const gris = new cv.Mat();
    try {
        if (filtro === 'byn') {
            cv.cvtColor(hoja, gris, cv.COLOR_RGB2GRAY);
            cv.GaussianBlur(gris, gris, new cv.Size(3, 3), 0);
            // Umbral por zonas: una sombra o la luz despareja no se comen el texto
            cv.adaptiveThreshold(gris, salida, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 31, 15);
            return;
        }
        // Blanquea el fondo: divide por el fondo estimado (la hoja sin letras), así el papel queda blanco parejo.
        // El fondo se calcula en chico (un cuarto) para que ande rápido en el celular.
        const chico = new cv.Mat(), fondo = new cv.Mat(), nucleo = cv.Mat.ones(3, 3, cv.CV_8U);
        cv.resize(hoja, chico, new cv.Size(Math.max(1, Math.round(hoja.cols / 4)), Math.max(1, Math.round(hoja.rows / 4))), 0, 0, cv.INTER_AREA);
        cv.dilate(chico, chico, nucleo);
        cv.medianBlur(chico, chico, 9);
        cv.resize(chico, fondo, new cv.Size(hoja.cols, hoja.rows), 0, 0, cv.INTER_LINEAR);
        cv.divide(hoja, fondo, filtro === 'grises' ? gris : salida, 255);
        if (filtro === 'grises') cv.cvtColor(gris, salida, cv.COLOR_RGB2GRAY);
        [chico, fondo, nucleo].forEach((m) => m.delete());
    } finally {
        gris.delete();
    }
}

function girar(canvas, giro) {
    const g = ((giro % 4) + 4) % 4;
    if (!g) return canvas;
    const c = g % 2 ? lienzo(canvas.height, canvas.width) : lienzo(canvas.width, canvas.height);
    const ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(g * Math.PI / 2);
    ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    return c;
}

// ── Hojas ──

let cola = Promise.resolve();   // de a una hoja por vez: menos memoria en el celular
const enCola = (f) => (cola = cola.then(f, f));

async function rehacer(h) {
    h.hoja = null;
    pintar();
    await enCola(async () => {
        try {
            const plana = await procesar(h);
            h.hoja = await aBlob(plana, 0.85);
            if (h.mini) URL.revokeObjectURL(h.mini);
            h.mini = URL.createObjectURL(await aBlob(await dibujar(plana, LADO_MINI), 0.8));
            if (hojas.includes(h)) await db.guardar(h, hojas.indexOf(h));
        } catch (e) {
            avisar(`No pude procesar una hoja: ${e.message}`, true);
        }
    });
    pintar();
}

async function agregar(archivos) {
    if (!archivos.length) return;
    $('resultado').hidden = true;
    const filtro = filtroComun();
    for (const [i, archivo] of archivos.entries()) {
        avisar(archivos.length > 1 ? `Preparando la foto ${i + 1} de ${archivos.length}…` : 'Preparando la foto…');
        try {
            const foto = await aBlob(await dibujar(archivo, LADO_FOTO), 0.92);
            const bmp = await createImageBitmap(foto);
            const h = {
                id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
                foto, ancho: bmp.width, alto: bmp.height, esquinas: ENTERA, encontrada: false,
                filtro, giro: 0, hoja: null, mini: null, fotoUrl: URL.createObjectURL(foto),
            };
            bmp.close && bmp.close();
            hojas.push(h);
            await db.guardar(h, hojas.length - 1);
            pintar();
            avisar('Buscando los bordes de la hoja…');
            try {
                const esq = await detectarEsquinas(foto);
                if (esq) Object.assign(h, { esquinas: esq, encontrada: true });
            } catch (e) {
                avisar(`No pude cargar el detector de bordes: ${e.message}`, true);
            }
            await rehacer(h);
        } catch (e) {
            avisar(`No pude abrir la foto: ${e.message}`, true);
            return;
        }
    }
    const sinBordes = hojas.some((h) => !h.encontrada);
    avisar(sinBordes ? 'En alguna hoja no encontré los bordes: tocala para marcarlos.' : '');
}

function filtroComun() {
    return hojas.length && hojas.every((h) => h.filtro === hojas[0].filtro) ? hojas[0].filtro : 'color';
}

// Una página en la grilla (la usan el escáner y las herramientas PDF): miniatura con su número y los botones
// para ordenar, girar y eliminar. `giro` gira solo la miniatura (en el escáner ya viene girada).
function itemPagina(i, total, { id, mini, giro = 0, aviso, pie, nombre, onAbrir, onMover, onGirar, onSacar }) {
    const li = document.createElement('li');
    li.className = 'hoja';
    li.dataset.id = id;
    li.innerHTML = `
        <span class="numero" aria-hidden="true">${i + 1}</span>
        <${onAbrir ? 'button type="button"' : 'div'} class="mini" ${onAbrir ? `aria-label="Ajustar ${nombre} ${i + 1}"` : ''}>
            <span class="procesando">Procesando…</span>
            ${aviso ? `<span class="aviso">${aviso}</span>` : ''}
        </${onAbrir ? 'button' : 'div'}>
        ${pie ? '<span class="pie-hoja"></span>' : ''}
        <div class="barra-hoja">
            <button type="button" aria-label="Mover antes" ${i === 0 ? 'disabled' : ''}>←</button>
            <button type="button" aria-label="Mover después" ${i === total - 1 ? 'disabled' : ''}>→</button>
            <button type="button" aria-label="Girar a la derecha">↻</button>
            <button type="button" aria-label="Eliminar ${nombre} ${i + 1}">🗑</button>
        </div>`;
    if (pie) li.querySelector('.pie-hoja').textContent = pie;
    ponerMini(li, mini, giro);
    const [antes, despues, girarBtn, sacar] = li.querySelectorAll('.barra-hoja button');
    if (onAbrir) li.querySelector('.mini').onclick = onAbrir;
    antes.onclick = () => onMover(-1);
    despues.onclick = () => onMover(1);
    girarBtn.onclick = onGirar;
    sacar.onclick = onSacar;
    return li;
}

function ponerMini(li, mini, giro = 0, fallo = false) {
    const caja = li.querySelector('.mini');
    if (fallo) { caja.querySelector('.procesando').textContent = 'Sin vista previa'; return; }
    if (!mini) return;
    let img = caja.querySelector('img');
    if (!img) { img = document.createElement('img'); img.alt = ''; caja.querySelector('.procesando').replaceWith(img); }
    img.src = mini;
    img.className = giro ? `giro${giro}` : '';
}

function pintar() {
    const lista = $('hojas');
    lista.innerHTML = '';
    hojas.forEach((h, i) => {
        lista.appendChild(itemPagina(i, hojas.length, {
            id: h.id, mini: h.mini, nombre: 'la hoja',
            aviso: h.mini && !h.encontrada ? 'No encontré los bordes: tocá para marcarlos' : '',
            onAbrir: () => abrirEditor(h),
            onMover: (paso) => mover(i, paso),
            onGirar: () => { h.giro = (h.giro + 1) % 4; rehacer(h); },
            onSacar: () => sacarHoja(h),
        }));
    });

    const hay = hojas.length > 0;
    $('vacio').hidden = hay || !$('resultado').hidden;
    $('documento').hidden = !hay;
    $('btnPdf').disabled = !hay;
    $('txtCamara').textContent = hay ? 'Otra hoja' : 'Sacar foto';
    $('cuentaHojas').textContent = `${hojas.length} ${hojas.length === 1 ? 'hoja' : 'hojas'}`;
    const comun = filtroComun();
    const todasIguales = hojas.every((h) => h.filtro === comun);
    document.querySelectorAll('#filtrosTodas [data-filtro]').forEach((b) =>
        b.setAttribute('aria-pressed', String(hay && todasIguales && b.dataset.filtro === comun)));
}

function mover(i, paso) {
    const j = i + paso;
    [hojas[i], hojas[j]] = [hojas[j], hojas[i]];
    pintar();
    guardarOrden();
}

function sacarHoja(h) {
    hojas = hojas.filter((x) => x !== h);
    soltar(h);
    db.borrar(h.id);
    guardarOrden();
    pintar();
}

function soltar(h) {
    if (h.mini) URL.revokeObjectURL(h.mini);
    if (h.fotoUrl) URL.revokeObjectURL(h.fotoUrl);
}

async function filtroTodas(filtro) {
    const cambian = hojas.filter((h) => h.filtro !== filtro);
    cambian.forEach((h) => { h.filtro = filtro; });
    pintar();
    for (const h of cambian) await rehacer(h);
}

function empezarDeNuevo() {
    hojas.forEach(soltar);
    hojas = [];
    db.vaciar();
    pintar();
    avisar('');
}

function avisar(texto, error = false) {
    $('estado').textContent = texto;
    $('estado').classList.toggle('error', error);
}

// ── Editor: la foto con las 4 esquinas para arrastrar (en fracción del ancho y alto de la foto) ──

let ed = null;

function abrirEditor(h) {
    ed = { h, esquinas: h.esquinas.map((p) => [...p]), filtro: h.filtro, giro: h.giro, activa: null };
    $('editorTitulo').textContent = `Hoja ${hojas.indexOf(h) + 1}`;
    const img = $('edFoto');
    img.onload = dibujarEsquinas;
    img.src = h.fotoUrl;
    $('editor').hidden = false;
    document.body.style.overflow = 'hidden';
    infoEditor();
    if (img.complete) dibujarEsquinas();
}

function cerrarEditor() {
    $('editor').hidden = true;
    $('lupa').hidden = true;
    document.body.style.overflow = '';
    ed = null;
}

function infoEditor() {
    document.querySelectorAll('#edFiltros [data-filtro]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filtro === ed.filtro)));
    $('edInfo').textContent = ed.giro ? `Se va a girar ${ed.giro * 90}° a la derecha.` : '';
}

function dibujarEsquinas() {
    if (!ed) return;
    const img = $('edFoto'), svg = $('edEsquinas');
    const W = img.clientWidth || 1, H = img.clientHeight || 1;
    Object.assign(svg.style, { left: `${img.offsetLeft}px`, top: `${img.offsetTop}px`, width: `${W}px`, height: `${H}px` });
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const p = ed.esquinas.map(([x, y]) => [x * W, y * H]);
    svg.innerHTML = `<polygon points="${p.map((q) => q.join(',')).join(' ')}"/>` +
        p.map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="16" class="${i === ed.activa ? 'activa' : ''}"/>`).join('');
}

function mostrarLupa([x, y]) {
    const img = $('edFoto'), lupa = $('lupa');
    const W = img.clientWidth, H = img.clientHeight, Z = 2.5, R = 56;
    lupa.hidden = false;
    lupa.style.backgroundImage = `url("${ed.h.fotoUrl}")`;
    lupa.style.backgroundSize = `${W * Z}px ${H * Z}px`;
    lupa.style.backgroundPosition = `${R - x * W * Z}px ${R - y * H * Z}px`;
    // Del lado contrario al dedo, para que no la tape
    const izquierda = x > 0.5;
    lupa.style.left = izquierda ? `${img.offsetLeft + 8}px` : '';
    lupa.style.right = izquierda ? '' : `${img.offsetParent.clientWidth - img.offsetLeft - W + 8}px`;
    lupa.style.top = `${img.offsetTop + (y < 0.3 ? H - 2 * R - 8 : 8)}px`;
}

(function arrastre() {
    const punto = (ev) => {
        const r = $('edFoto').getBoundingClientRect();
        return [Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height))];
    };
    const lienzoEd = $('lienzo');
    lienzoEd.addEventListener('pointerdown', (ev) => {
        if (!ed) return;
        const r = $('edFoto').getBoundingClientRect();
        const [x, y] = punto(ev);
        // La esquina más cercana al dedo, si está a menos de ~48 px
        let mejor = null, menor = Infinity;
        ed.esquinas.forEach(([ex, ey], i) => {
            const d = Math.hypot((ex - x) * r.width, (ey - y) * r.height);
            if (d < menor) { menor = d; mejor = i; }
        });
        if (menor > 48) return;
        ed.activa = mejor;
        ed.dx = ed.esquinas[mejor][0] - x;
        ed.dy = ed.esquinas[mejor][1] - y;
        lienzoEd.setPointerCapture(ev.pointerId);
        ev.preventDefault();
        dibujarEsquinas();
        mostrarLupa(ed.esquinas[mejor]);
    });
    lienzoEd.addEventListener('pointermove', (ev) => {
        if (!ed || ed.activa === null) return;
        const [x, y] = punto(ev);
        ed.esquinas[ed.activa] = [Math.min(1, Math.max(0, x + ed.dx)), Math.min(1, Math.max(0, y + ed.dy))];
        dibujarEsquinas();
        mostrarLupa(ed.esquinas[ed.activa]);
    });
    const soltarDedo = () => {
        if (!ed) return;
        ed.activa = null;
        $('lupa').hidden = true;
        dibujarEsquinas();
    };
    lienzoEd.addEventListener('pointerup', soltarDedo);
    lienzoEd.addEventListener('pointercancel', soltarDedo);
    window.addEventListener('resize', dibujarEsquinas);
})();

async function guardarEditor() {
    const { h, esquinas, filtro, giro } = ed;
    const cambio = JSON.stringify([h.esquinas, h.filtro, h.giro]) !== JSON.stringify([esquinas, filtro, giro]);
    if (JSON.stringify(h.esquinas) !== JSON.stringify(esquinas)) h.encontrada = true;   // las marcó el usuario
    Object.assign(h, { esquinas, filtro, giro });
    cerrarEditor();
    if (cambio) await rehacer(h); else pintar();
}

// ── PDF ──

function nombreArchivo(nombre) {
    const limpio = (nombre || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Documento';
    return /\.pdf$/i.test(limpio) ? limpio : `${limpio}.pdf`;
}

const hoy = () => new Date().toLocaleDateString('es-AR').replaceAll('/', '-');

function abrirPdf() {
    const herramientas = modo === 'pdf';
    if (!$('pdfNombre').value) $('pdfNombre').value = herramientas ? nombreSugerido() : `Documento ${hoy()}`;
    $('pdfTitulo').textContent = herramientas ? 'Guardar el PDF' : 'Crear el PDF';
    $('pdfCrear').textContent = herramientas ? 'Guardar PDF' : 'Crear PDF';
    $('pdfOcrFila').hidden = herramientas;
    $('pdfEstado').textContent = '';
    $('pdfProgreso').hidden = true;
    $('dlgPdf').hidden = false;
}

// Las palabras que reconoció Tesseract, invisibles, en el mismo lugar que en la imagen
function capaDeTexto(pagina, fuente, letras, bloques, escala, altoPagina) {
    const P = PDFLib;
    const clave = pagina.node.newFontDictionary(fuente.name, fuente.ref);
    const ops = [];
    for (const bloque of bloques || []) {
        for (const parrafo of bloque.paragraphs || []) {
            for (const linea of parrafo.lines || []) {
                for (const palabra of linea.words || []) {
                    const texto = [...(palabra.text || '')].filter((ch) => letras.has(ch.codePointAt(0))).join('');
                    if (!texto.trim()) continue;
                    const { x0, y0, x1, y1 } = palabra.bbox;
                    const ancho = (x1 - x0) * escala, alto = Math.max(1, (y1 - y0) * escala);
                    const anchoTexto = fuente.widthOfTextAtSize(texto, alto);
                    if (!anchoTexto || ancho <= 0) continue;
                    // Altura de la letra = alto de la palabra; se estira a lo ancho para ocupar lo mismo que en la foto
                    ops.push(
                        P.beginText(),
                        P.setFontAndSize(clave, alto),
                        P.setTextRenderingMode(P.TextRenderingMode.Invisible),
                        P.setCharacterSqueeze(Math.max(1, Math.min(1000, (ancho / anchoTexto) * 100))),
                        P.moveText(x0 * escala, altoPagina - y1 * escala + alto * 0.2),
                        P.showText(fuente.encodeText(`${texto} `)),
                        P.endText(),
                    );
                }
            }
        }
    }
    if (ops.length) pagina.pushOperators(P.pushGraphicsState(), ...ops, P.popGraphicsState());
    return ops.length / 7;
}

async function crearPdf(ev) {
    ev.preventDefault();
    const conOcr = $('pdfOcr').checked;
    const nombre = nombreArchivo($('pdfNombre').value);
    const boton = $('pdfCrear');
    const estado = (t) => { $('pdfEstado').textContent = t; };
    const barra = (f) => { $('pdfProgreso').hidden = false; $('pdfBarra').style.width = `${Math.round(f * 100)}%`; };
    boton.disabled = true;
    try {
        if (hojas.some((h) => !h.hoja)) {
            estado('Terminando de procesar las hojas…');
            await cola;
        }
        if (!window.PDFLib) await cargarScript('vendor/pdf-lib.min.js');
        const pdf = await PDFLib.PDFDocument.create();
        pdf.setTitle(nombre.replace(/\.pdf$/i, ''));
        pdf.setCreator('ScanerFree');
        pdf.setProducer('ScanerFree');
        let fuente = null, letras = null, ocr = null, palabras = 0;
        if (conOcr) {
            estado('Preparando el reconocimiento de texto…');
            fuente = await pdf.embedFont(PDFLib.StandardFonts.Helvetica);
            letras = new Set(fuente.getCharacterSet());
            ocr = await cargarOcr();
        }
        const total = hojas.length;
        for (const [i, h] of hojas.entries()) {
            if (!h.hoja) continue;
            barra(i / total);
            const img = await pdf.embedJpg(await h.hoja.arrayBuffer());
            // El lado corto mide como el ancho de una A4 (21 cm); el largo, lo que dé la hoja
            const escalaPt = 595.28 / Math.min(img.width, img.height);
            const ancho = img.width * escalaPt, alto = img.height * escalaPt;
            const pagina = pdf.addPage([ancho, alto]);
            pagina.drawImage(img, { x: 0, y: 0, width: ancho, height: alto });
            if (ocr) {
                estado(`Reconociendo el texto: hoja ${i + 1} de ${total}…`);
                ocrProgreso = (m) => { if (m.status === 'recognizing text') barra((i + m.progress) / total); };
                const { data } = await ocr.recognize(h.hoja, {}, { blocks: true });
                ocrProgreso = null;
                palabras += capaDeTexto(pagina, fuente, letras, data.blocks, escalaPt, alto);
            }
            await espera();
        }
        barra(1);
        estado('Guardando el PDF…');
        const blob = new Blob([await pdf.save()], { type: 'application/pdf' });
        entregar(blob, nombre, `${total} ${total === 1 ? 'hoja' : 'hojas'}, ${tamano(blob)}` +
            (conOcr ? (palabras ? ', con el texto reconocido.' : '. No encontré texto para reconocer.') : '.'));
    } catch (e) {
        estado(`No pude armar el PDF: ${e.message}`);
    } finally {
        ocrProgreso = null;
        boton.disabled = false;
    }
}

const tamano = (blob) => (blob.size > 1e6 ? `${(blob.size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(blob.size / 1e3))} KB`);

// El PDF terminado (del escáner o de las herramientas): se muestra con Compartir y Descargar
function entregar(blob, nombre, detalle) {
    if (pdfListo) URL.revokeObjectURL(pdfListo.url);
    pdfListo = { blob, nombre, url: URL.createObjectURL(blob) };
    $('dlgPdf').hidden = true;
    $('resultadoTexto').textContent = `«${nombre}»: ${detalle}`;
    $('btnNuevo').textContent = modo === 'pdf' ? 'Empezar con otro PDF' : 'Escanear otro documento';
    $('btnDescargar').href = pdfListo.url;
    $('btnDescargar').download = pdfListo.nombre;
    const archivo = new File([pdfListo.blob], pdfListo.nombre, { type: 'application/pdf' });
    $('btnCompartir').hidden = !(navigator.canShare && navigator.canShare({ files: [archivo] }));
    $('resultado').hidden = false;
    $('resultado').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function compartir() {
    try {
        const archivo = new File([pdfListo.blob], pdfListo.nombre, { type: 'application/pdf' });
        await navigator.share({ files: [archivo], title: pdfListo.nombre });
    } catch (e) {
        if (e.name !== 'AbortError') avisar('No pude compartirlo: usá «Descargar».', true);
    }
}

function nuevoDocumento() {
    $('resultado').hidden = true;
    $('pdfNombre').value = '';
    if (modo === 'pdf') vaciarPaginas(); else empezarDeNuevo();
}

// ── Herramientas PDF: unir, eliminar páginas y crear desde fotos ──
// Las tres son la misma mesa: se suman PDF (cada página por separado) y fotos, se ordenan, giran y eliminan,
// y al guardar se copian las páginas originales tal cual (el texto y la calidad no cambian).

let modo = 'escanear';
let paginas = [];   // {id, tipo: 'pdf' | 'img', fuente, num, blob, giro, mini, fallo}
let fuentes = [];   // los PDF abiertos: {nombre, bytes, vista (documento de pdf.js)}
let intencion = null;   // 'unir' | 'eliminar' | 'fotos': para sugerir el nombre del PDF

const nuevoId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));

let pdfjsListo = null;
function cargarPdfjs() {
    if (!pdfjsListo) {
        pdfjsListo = import('./vendor/pdfjs/pdf.min.mjs').then((m) => {
            m.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.min.mjs', location.href).href;
            return m;
        });
        pdfjsListo.catch(() => { pdfjsListo = null; });
    }
    return pdfjsListo;
}

function cambiarModo(nuevo) {
    modo = nuevo;
    const pdf = modo === 'pdf';
    $('vistaEscaner').hidden = pdf;
    $('vistaPdf').hidden = !pdf;
    $('accionesEscaner').hidden = pdf;
    $('accionesPdf').hidden = !pdf;
    $('modoEscanear').setAttribute('aria-selected', String(!pdf));
    $('modoPdf').setAttribute('aria-selected', String(pdf));
    $('resultado').hidden = true;
    $('pdfNombre').value = '';
    avisar('');
    pintar();
    pintarPaginas();
    try { localStorage.setItem('scanerfree_modo', modo); } catch (e) { /* sin guardar, no pasa nada */ }
    if (pdf) cargarPdfjs().catch(() => {});
}

async function agregarPdfs(archivos) {
    if (!archivos.length) return;
    $('resultado').hidden = true;
    let pdfjs;
    try { pdfjs = await cargarPdfjs(); } catch (e) { avisar('No pude cargar el lector de PDF.', true); return; }
    let error = '';
    for (const archivo of archivos) {
        avisar(`Abriendo «${archivo.name}»…`);
        try {
            const bytes = await archivo.arrayBuffer();
            // pdf.js se queda con la copia (la pasa a su worker); los bytes originales son para guardar
            const vista = await pdfjs.getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise;
            const fuente = fuentes.push({ nombre: archivo.name, bytes, vista }) - 1;
            for (let num = 1; num <= vista.numPages; num++) paginas.push({ id: nuevoId(), tipo: 'pdf', fuente, num, giro: 0, mini: null });
        } catch (e) {
            error = e && e.name === 'PasswordException'
                ? `«${archivo.name}» tiene contraseña. Abrilo, guardalo sin contraseña y probá de nuevo.`
                : `No pude abrir «${archivo.name}»: no parece un PDF.`;
        }
    }
    avisar(error, !!error);
    pintarPaginas();
    miniaturasPdf();
}

async function agregarImagenes(archivos) {
    if (!archivos.length) return;
    $('resultado').hidden = true;
    let error = '';
    for (const [i, archivo] of archivos.entries()) {
        avisar(archivos.length > 1 ? `Preparando la foto ${i + 1} de ${archivos.length}…` : 'Preparando la foto…');
        try {
            const c = await dibujar(archivo, LADO_HOJA);
            const blob = await aBlob(c, 0.9);
            const mini = URL.createObjectURL(await aBlob(await dibujar(c, LADO_MINI), 0.8));
            paginas.push({ id: nuevoId(), tipo: 'img', blob, giro: 0, mini, nombre: archivo.name });
            pintarPaginas();
        } catch (e) {
            error = `No pude abrir «${archivo.name}»: no parece una imagen.`;
        }
    }
    avisar(error, !!error);
    pintarPaginas();
}

// Las miniaturas de las páginas de PDF, de a una (un PDF largo no traba el celular)
let dibujandoMinis = false;
async function miniaturasPdf() {
    if (dibujandoMinis) return;
    dibujandoMinis = true;
    try {
        for (let p; (p = paginas.find((x) => x.tipo === 'pdf' && !x.mini && !x.fallo));) {
            try {
                const pagina = await fuentes[p.fuente].vista.getPage(p.num);
                const base = pagina.getViewport({ scale: 1 });
                const vp = pagina.getViewport({ scale: LADO_MINI / Math.max(base.width, base.height) });
                const c = lienzo(vp.width, vp.height), ctx = c.getContext('2d');
                ctx.fillStyle = '#fff';
                ctx.fillRect(0, 0, c.width, c.height);
                // Con intent 'print' pdf.js no espera al refresco de pantalla: dibuja aunque la app quede de fondo
                await pagina.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
                p.mini = URL.createObjectURL(await aBlob(c, 0.8));
            } catch (e) {
                p.fallo = true;
            }
            const li = document.querySelector(`#pdfPaginas [data-id="${p.id}"]`);
            if (li) ponerMini(li, p.mini, p.giro, p.fallo);
        }
    } finally {
        dibujandoMinis = false;
    }
}

function pintarPaginas() {
    const lista = $('pdfPaginas');
    lista.innerHTML = '';
    const varios = fuentes.length > 1 || (fuentes.length && paginas.some((p) => p.tipo === 'img'));
    paginas.forEach((p, i) => {
        lista.appendChild(itemPagina(i, paginas.length, {
            id: p.id, mini: p.mini, giro: p.giro, nombre: 'la página',
            // Si hay más de un archivo, cada página dice de cuál viene
            pie: p.tipo === 'pdf' ? (varios ? `${fuentes[p.fuente].nombre}, pág. ${p.num}` : `Pág. ${p.num}`) : (varios ? p.nombre : ''),
            onMover: (paso) => { [paginas[i], paginas[i + paso]] = [paginas[i + paso], paginas[i]]; pintarPaginas(); },
            onGirar: () => {
                p.giro = (p.giro + 1) % 4;
                const li = lista.querySelector(`[data-id="${p.id}"]`);
                if (li) ponerMini(li, p.mini, p.giro, p.fallo);
            },
            onSacar: () => {
                paginas.splice(paginas.indexOf(p), 1);
                if (p.tipo === 'img' && p.mini) URL.revokeObjectURL(p.mini);
                pintarPaginas();
            },
        }));
        if (p.fallo) ponerMini(lista.lastChild, null, 0, true);
    });
    const hay = paginas.length > 0;
    $('pdfVacio').hidden = hay || !$('resultado').hidden;
    $('pdfTrabajo').hidden = !hay;
    $('btnGuardarPdf').disabled = !hay;
    $('pdfCuenta').textContent = `${paginas.length} ${paginas.length === 1 ? 'página' : 'páginas'}`;
}

function vaciarPaginas() {
    paginas.forEach((p) => { if (p.mini) URL.revokeObjectURL(p.mini); });
    fuentes.forEach((f) => f.vista && f.vista.destroy());
    paginas = [];
    fuentes = [];
    intencion = null;
    pintarPaginas();
    avisar('');
}

function nombreSugerido() {
    const base = fuentes.length ? fuentes[0].nombre.replace(/\.pdf$/i, '') : '';
    if (intencion === 'eliminar' && fuentes.length === 1 && base) return `${base} (editado)`;
    if (intencion === 'fotos' || !fuentes.length) return `Fotos ${hoy()}`;
    return fuentes.length > 1 ? `PDF unido ${hoy()}` : `${base} (editado)`;
}

async function guardarHerramientas(ev) {
    ev.preventDefault();
    const nombre = nombreArchivo($('pdfNombre').value);
    const boton = $('pdfCrear');
    const estado = (t) => { $('pdfEstado').textContent = t; };
    const barra = (f) => { $('pdfProgreso').hidden = false; $('pdfBarra').style.width = `${Math.round(f * 100)}%`; };
    boton.disabled = true;
    try {
        if (!window.PDFLib) await cargarScript('vendor/pdf-lib.min.js');
        const P = PDFLib;
        estado('Armando el PDF…');
        const salida = await P.PDFDocument.create();
        salida.setTitle(nombre.replace(/\.pdf$/i, ''));
        salida.setCreator('ScanerFree');
        salida.setProducer('ScanerFree');
        // Las páginas de cada PDF se copian juntas: así comparten letras e imágenes y el archivo no se agranda
        const copiadas = new Map();
        for (const [f, fuente] of fuentes.entries()) {
            const usadas = paginas.filter((p) => p.tipo === 'pdf' && p.fuente === f);
            if (!usadas.length) continue;
            const doc = await P.PDFDocument.load(fuente.bytes, { ignoreEncryption: true });
            if (doc.isEncrypted) throw new Error(`«${fuente.nombre}» está protegido contra cambios.`);
            const copias = await salida.copyPages(doc, usadas.map((p) => p.num - 1));
            usadas.forEach((p, k) => copiadas.set(p, copias[k]));
        }
        for (const [i, p] of paginas.entries()) {
            barra(i / paginas.length);
            if (p.tipo === 'pdf') {
                const pagina = copiadas.get(p);
                if (p.giro) pagina.setRotation(P.degrees((pagina.getRotation().angle + p.giro * 90) % 360));
                salida.addPage(pagina);
            } else {
                const c = girar(await dibujar(p.blob, LADO_HOJA), p.giro);
                const img = await salida.embedJpg(await (await aBlob(c, 0.9)).arrayBuffer());
                const e = 595.28 / Math.min(img.width, img.height);
                salida.addPage([img.width * e, img.height * e]).drawImage(img, { x: 0, y: 0, width: img.width * e, height: img.height * e });
            }
            await espera();
        }
        barra(1);
        estado('Guardando el PDF…');
        const blob = new Blob([await salida.save()], { type: 'application/pdf' });
        const n = paginas.length;
        entregar(blob, nombre, `${n} ${n === 1 ? 'página' : 'páginas'}, ${tamano(blob)}.`);
    } catch (e) {
        estado(`No pude guardar el PDF: ${e.message}`);
    } finally {
        boton.disabled = false;
    }
}

// ── Arranque ──

function conectar() {
    $('btnCamara').onclick = () => $('inCamara').click();
    $('btnGaleria').onclick = () => $('inGaleria').click();
    for (const id of ['inCamara', 'inGaleria']) {
        $(id).onchange = (ev) => { const archivos = [...ev.target.files]; ev.target.value = ''; agregar(archivos); };
    }
    $('btnPdf').onclick = abrirPdf;
    $('btnBorrarTodo').onclick = () => { if (confirm('¿Sacar todas las hojas y empezar de nuevo?')) empezarDeNuevo(); };
    document.querySelectorAll('#filtrosTodas [data-filtro]').forEach((b) => { b.onclick = () => filtroTodas(b.dataset.filtro); });

    $('edCancelar').onclick = cerrarEditor;
    $('edListo').onclick = guardarEditor;
    $('edGirar').onclick = () => { ed.giro = (ed.giro + 1) % 4; infoEditor(); };
    $('edEntera').onclick = () => { ed.esquinas = ENTERA.map((p) => [...p]); dibujarEsquinas(); };
    $('edDetectar').onclick = async () => {
        $('edInfo').textContent = 'Buscando los bordes…';
        try {
            const esq = await detectarEsquinas(ed.h.foto);
            if (!ed) return;
            if (esq) { ed.esquinas = esq; dibujarEsquinas(); infoEditor(); } else $('edInfo').textContent = 'No encontré los bordes: marcalos a mano.';
        } catch (e) { if (ed) $('edInfo').textContent = e.message; }
    };
    document.querySelectorAll('#edFiltros [data-filtro]').forEach((b) => { b.onclick = () => { ed.filtro = b.dataset.filtro; infoEditor(); }; });

    $('modoEscanear').onclick = () => cambiarModo('escanear');
    $('modoPdf').onclick = () => cambiarModo('pdf');
    const elegir = (input, cual) => () => { if (cual) intencion = intencion || cual; $(input).click(); };
    $('hUnir').onclick = elegir('inPdf', 'unir');
    $('hEliminar').onclick = elegir('inPdfUno', 'eliminar');
    $('hFotos').onclick = elegir('inImagenes', 'fotos');
    $('btnAgregarPdf').onclick = elegir('inPdf');
    $('btnImagenes').onclick = elegir('inImagenes');
    for (const id of ['inPdf', 'inPdfUno']) {
        $(id).onchange = (ev) => { const archivos = [...ev.target.files]; ev.target.value = ''; agregarPdfs(archivos); };
    }
    $('inImagenes').onchange = (ev) => { const archivos = [...ev.target.files]; ev.target.value = ''; agregarImagenes(archivos); };
    $('btnGuardarPdf').onclick = abrirPdf;
    $('pdfBorrarTodo').onclick = () => { if (confirm('¿Sacar todas las páginas y empezar de nuevo?')) vaciarPaginas(); };

    $('formPdf').onsubmit = (ev) => (modo === 'pdf' ? guardarHerramientas(ev) : crearPdf(ev));
    $('pdfCancelar').onclick = () => { $('dlgPdf').hidden = true; };
    $('btnCompartir').onclick = compartir;
    $('btnNuevo').onclick = nuevoDocumento;
    document.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Escape') return;
        if (!$('editor').hidden) cerrarEditor();
        else if (!$('dlgPdf').hidden && !$('pdfCrear').disabled) $('dlgPdf').hidden = true;
    });
}

async function recuperar() {
    const guardadas = await db.todas();
    if (!guardadas || !guardadas.length) return;
    hojas = guardadas.sort((a, b) => a.orden - b.orden).map((g) => ({ ...g, fotoUrl: URL.createObjectURL(g.foto), mini: null }));
    pintar();
    for (const h of hojas) {
        if (h.hoja) h.mini = URL.createObjectURL(await aBlob(await dibujar(h.hoja, LADO_MINI), 0.8));
        else rehacer(h);
    }
    pintar();
}

conectar();
try { if (localStorage.getItem('scanerfree_modo') === 'pdf') modo = 'pdf'; } catch (e) { /* sin guardar */ }
cambiarModo(modo);
recuperar();
// OpenCV pesa: se empieza a cargar apenas abre la app, así está lista para la primera foto
setTimeout(() => cargarCv().catch(() => {}), 300);

if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
}
