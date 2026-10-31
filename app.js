/*
 * ScannerFree — escáner de documentos y herramientas PDF que corren enteros en el navegador.
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

// Dos cajones: 'hojas' (el escaneo en curso) y 'documentos' (los PDF terminados, «Mis documentos»)
const db = (() => {
    let abierta = null;
    const abrir = () => abierta || (abierta = new Promise((ok, mal) => {
        const pedido = indexedDB.open('scanerfree', 2);
        pedido.onupgradeneeded = () => {
            const base = pedido.result;
            if (!base.objectStoreNames.contains('hojas')) base.createObjectStore('hojas', { keyPath: 'id' });
            if (!base.objectStoreNames.contains('documentos')) base.createObjectStore('documentos', { keyPath: 'id' });
        };
        pedido.onsuccess = () => ok(pedido.result);
        pedido.onerror = () => mal(pedido.error);
    }));
    const tx = async (cajon, modo, f) => {
        const base = await abrir();
        return new Promise((ok, mal) => {
            const t = base.transaction(cajon, modo);
            const pedido = f(t.objectStore(cajon));
            t.oncomplete = () => ok(pedido && pedido.result);
            t.onerror = () => mal(t.error);
        });
    };
    // Si el navegador no deja guardar (modo incógnito, poco espacio), la app sigue andando sin guardar
    const seguro = (f) => async (...args) => { try { return await f(...args); } catch (e) { return null; } };
    return {
        todas: seguro(() => tx('hojas', 'readonly', (s) => s.getAll())),
        guardar: seguro((h, orden) => tx('hojas', 'readwrite', (s) => s.put({
            id: h.id, foto: h.foto, ancho: h.ancho, alto: h.alto, esquinas: h.esquinas, encontrada: h.encontrada,
            filtro: h.filtro, giro: h.giro, hoja: h.hoja, orden,
        }))),
        borrar: seguro((id) => tx('hojas', 'readwrite', (s) => s.delete(id))),
        vaciar: seguro(() => tx('hojas', 'readwrite', (s) => s.clear())),
        documentos: seguro(() => tx('documentos', 'readonly', (s) => s.getAll())),
        guardarDocumento: seguro((d) => tx('documentos', 'readwrite', (s) => s.put(d))),
        borrarDocumento: seguro((id) => tx('documentos', 'readwrite', (s) => s.delete(id))),
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
            <button type="button" aria-label="Mover antes" ${i === 0 ? 'disabled' : ''}><svg><use href="#i-izq"/></svg></button>
            <button type="button" aria-label="Mover después" ${i === total - 1 ? 'disabled' : ''}><svg><use href="#i-der"/></svg></button>
            <button type="button" aria-label="Girar a la derecha"><svg><use href="#i-girar"/></svg></button>
            <button type="button" aria-label="Eliminar ${nombre} ${i + 1}"><svg><use href="#i-basura"/></svg></button>
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
    actualizarPasos();
}

// Los pasos de arriba del escáner: Foto → Ajustá → PDF → ¡Listo!, con el que toca resaltado
function actualizarPasos() {
    let paso = hojas.length ? 1 : 0;
    if (modo === 'escanear' && !$('dlgPdf').hidden) paso = 2;
    if (!$('resultado').hidden) paso = 3;
    document.querySelectorAll('#pasos li').forEach((li, i) => {
        li.classList.toggle('hecho', i < paso || paso === 3);
        li.classList.toggle('actual', i === paso);
        if (i === paso) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
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
    $('pdfOcrFila').hidden = herramientas;
    $('pdfEstado').textContent = '';
    $('pdfProgreso').hidden = true;
    $('dlgPdf').hidden = false;
    actualizarPasos();
}

// Las palabras que reconoció Tesseract, invisibles, en el mismo lugar que en la imagen.
// `aPdf(x, y)` pasa un punto de la imagen a coordenadas de la página del PDF.
function capaDeTexto(pagina, fuente, letras, bloques, escala, altoPagina) {
    return capaDeTextoEn(pagina, fuente, letras, bloques, (x, y) => [x * escala, altoPagina - y * escala]);
}

function capaDeTextoEn(pagina, fuente, letras, bloques, aPdf) {
    const P = PDFLib;
    const clave = pagina.node.newFontDictionary(fuente.name, fuente.ref);
    const ops = [];
    let palabras = 0;
    for (const bloque of bloques || []) {
        for (const parrafo of bloque.paragraphs || []) {
            for (const linea of parrafo.lines || []) {
                for (const palabra of linea.words || []) {
                    const texto = [...(palabra.text || '')].filter((ch) => letras.has(ch.codePointAt(0))).join('');
                    if (!texto.trim()) continue;
                    const { x0, y0, x1, y1 } = palabra.bbox;
                    // Abajo a la izquierda, abajo a la derecha y arriba a la izquierda de la palabra, ya en el PDF:
                    // así sirve también para páginas giradas
                    const [ax, ay] = aPdf(x0, y1), [bx, by] = aPdf(x1, y1), [cx, cy] = aPdf(x0, y0);
                    const ancho = Math.hypot(bx - ax, by - ay), alto = Math.max(1, Math.hypot(cx - ax, cy - ay));
                    const anchoTexto = fuente.widthOfTextAtSize(texto, alto);
                    if (!anchoTexto || ancho <= 0) continue;
                    const cos = (bx - ax) / ancho, sen = (by - ay) / ancho;
                    // Altura de la letra = alto de la palabra; se estira a lo ancho para ocupar lo mismo que en la foto
                    ops.push(
                        P.beginText(),
                        P.setFontAndSize(clave, alto),
                        P.setTextRenderingMode(P.TextRenderingMode.Invisible),
                        P.setCharacterSqueeze(Math.max(1, Math.min(1000, (ancho / anchoTexto) * 100))),
                        P.setTextMatrix(cos, sen, -sen, cos, ax - sen * alto * 0.2, ay + cos * alto * 0.2),
                        P.showText(fuente.encodeText(`${texto} `)),
                        P.endText(),
                    );
                    palabras++;
                }
            }
        }
    }
    if (ops.length) pagina.pushOperators(P.pushGraphicsState(), ...ops, P.popGraphicsState());
    return palabras;
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
        pdf.setCreator('ScannerFree');
        pdf.setProducer('ScannerFree');
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
        await entregar(blob, nombre, `${total} ${total === 1 ? 'hoja' : 'hojas'}, ${tamano(blob)}` +
            (conOcr ? (palabras ? ', con el texto reconocido.' : '. No encontré texto para reconocer.') : '.'),
        total, hojas[0] && hojas[0].mini);
    } catch (e) {
        estado(`No pude armar el PDF: ${e.message}`);
    } finally {
        ocrProgreso = null;
        boton.disabled = false;
    }
}

const tamano = (blob) => (blob.size > 1e6 ? `${(blob.size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(blob.size / 1e3))} KB`);

// El PDF terminado (del escáner o de las herramientas): queda en «Mis documentos» y se muestra con
// Compartir y Descargar
async function entregar(blob, nombre, detalle, cantidad, miniUrl) {
    if (pdfListo) URL.revokeObjectURL(pdfListo.url);
    pdfListo = { blob, nombre, url: URL.createObjectURL(blob) };
    $('dlgPdf').hidden = true;
    let mini = null;
    try { if (miniUrl) mini = await (await fetch(miniUrl)).blob(); } catch (e) { /* sin miniatura */ }
    const guardado = await db.guardarDocumento({ id: nuevoId(), nombre, blob, paginas: cantidad, fecha: Date.now(), mini });
    // Que el navegador no borre los documentos solo si se queda sin espacio
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    $('resultadoTexto').textContent = `«${nombre}»: ${detalle}` + (guardado !== null ? ' Quedó guardado en Mis documentos.' : '');
    $('btnNuevo').textContent = modo === 'pdf' ? 'Empezar con otro PDF' : 'Escanear otro documento';
    $('btnDescargar').href = pdfListo.url;
    $('btnDescargar').download = pdfListo.nombre;
    const archivo = new File([pdfListo.blob], pdfListo.nombre, { type: 'application/pdf' });
    $('btnCompartir').hidden = !(navigator.canShare && navigator.canShare({ files: [archivo] }));
    $('resultado').hidden = false;
    $('resultado').scrollIntoView({ behavior: 'smooth', block: 'center' });
    actualizarPasos();
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

let modo = 'inicio';   // la pantalla que se ve: 'inicio' | 'escanear' | 'pdf' | 'documentos'
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

// ── Pantallas: inicio, escanear, herramientas PDF y mis documentos ──
// Cada una tiene su dirección (#escanear, #pdf, #documentos): así el botón «atrás» del celular vuelve al inicio.

const VISTAS = { inicio: 'vistaInicio', escanear: 'vistaEscaner', pdf: 'vistaPdf', texto: 'vistaTexto', documentos: 'vistaDocs' };
let desdeInicio = false;   // si se llegó desde el inicio, «volver» es ir para atrás en el historial

const vistaDeDireccion = () => (VISTAS[location.hash.slice(1)] ? location.hash.slice(1) : 'inicio');

function mostrarVista(nueva) {
    const cambia = nueva !== modo;
    modo = nueva;
    for (const [nombre, id] of Object.entries(VISTAS)) $(id).hidden = nombre !== modo;
    const conAcciones = modo === 'escanear' || modo === 'pdf';
    $('accionesEscaner').hidden = modo !== 'escanear';
    $('accionesPdf').hidden = modo !== 'pdf';
    document.body.classList.toggle('con-acciones', conAcciones);
    $('btnVolver').hidden = modo === 'inicio';
    $('pie').hidden = modo !== 'inicio';
    if (cambia) {
        $('resultado').hidden = true;
        $('pdfNombre').value = '';
        avisar('');
        window.scrollTo(0, 0);
    }
    pintar();
    pintarPaginas();
    if (modo === 'pdf') cargarPdfjs().catch(() => {});
    if (modo === 'texto' && cambia && !textoTarea) prepararTexto(textoModo);
    if (modo === 'inicio' || modo === 'documentos') pintarDocumentos();
}

function ir(vista) {
    if (vista === modo) return;
    desdeInicio = modo === 'inicio';
    location.hash = vista === 'inicio' ? '' : vista;   // el cambio de dirección muestra la pantalla
}

function volver() {
    if (desdeInicio) history.back(); else location.hash = '';
    desdeInicio = false;
}

// ── Mis documentos: los PDF terminados quedan guardados en el celular ──

let docs = [], docAbierto = null, urlsDocs = [], urlsVisor = [];

function fechaCorta(ms) {
    const d = new Date(ms), hoy = new Date();
    const dias = Math.round((new Date(hoy.toDateString()) - new Date(d.toDateString())) / 864e5);
    if (dias === 0) return `hoy ${d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
    if (dias === 1) return 'ayer';
    return d.toLocaleDateString('es-AR');
}

const detalleDoc = (d) => `${d.paginas} ${d.paginas === 1 ? 'página' : 'páginas'}, ${fechaCorta(d.fecha)}, ${tamano(d.blob)}`;

async function pintarDocumentos() {
    docs = ((await db.documentos()) || []).sort((a, b) => b.fecha - a.fecha);
    urlsDocs.forEach((u) => URL.revokeObjectURL(u));
    urlsDocs = [];
    const fila = (d) => {
        const li = document.createElement('li');
        li.innerHTML = `<button class="documento" type="button">
            ${d.mini ? '<img alt="">' : '<span class="sin-mini"><svg><use href="#i-pdf"/></svg></span>'}
            <span class="datos"><b></b><small></small></span>
            <span class="etiqueta-pdf">PDF</span>
        </button>`;
        if (d.mini) {
            const url = URL.createObjectURL(d.mini);
            urlsDocs.push(url);
            li.querySelector('img').src = url;
        }
        li.querySelector('b').textContent = d.nombre;
        li.querySelector('small').textContent = detalleDoc(d);
        li.querySelector('button').onclick = () => abrirDoc(d);
        return li;
    };
    $('recientes').replaceChildren(...docs.slice(0, 3).map(fila));
    $('documentos').replaceChildren(...docs.map(fila));
    $('sinRecientes').hidden = $('sinDocumentos').hidden = docs.length > 0;
    $('verTodos').hidden = docs.length === 0;
}

function abrirDoc(d) {
    docAbierto = d;
    const img = $('docMini');
    if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
    img.hidden = !d.mini;
    if (d.mini) img.src = URL.createObjectURL(d.mini);
    $('docTitulo').textContent = d.nombre;
    $('docDetalle').textContent = detalleDoc(d);
    $('dlgDoc').hidden = false;
}

const cerrarDoc = () => { $('dlgDoc').hidden = true; };
const archivoDe = (d) => new File([d.blob], d.nombre, { type: 'application/pdf' });

function descargar(blob, nombre) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nombre;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

async function compartirDoc(d) {
    const archivo = archivoDe(d);
    if (!(navigator.canShare && navigator.canShare({ files: [archivo] }))) return descargar(d.blob, d.nombre);
    try {
        await navigator.share({ files: [archivo], title: d.nombre });
    } catch (e) {
        if (e.name !== 'AbortError') descargar(d.blob, d.nombre);
    }
}

// Visor: cada página dibujada con pdf.js, una abajo de la otra
async function verDoc(d) {
    cerrarDoc();
    $('visorTitulo').textContent = d.nombre;
    const cont = $('visorPaginas');
    cont.innerHTML = '<p class="ayuda">Abriendo…</p>';
    $('visor').hidden = false;
    document.body.style.overflow = 'hidden';
    try {
        const pdfjs = await cargarPdfjs();
        const doc = await pdfjs.getDocument({ data: new Uint8Array(await d.blob.arrayBuffer()), isEvalSupported: false }).promise;
        cont.innerHTML = '';
        const ancho = Math.min(1400, Math.round(Math.min(window.innerWidth, 720) * (window.devicePixelRatio || 1)));
        for (let n = 1; n <= doc.numPages && !$('visor').hidden; n++) {
            const pagina = await doc.getPage(n);
            const base = pagina.getViewport({ scale: 1 });
            const vp = pagina.getViewport({ scale: ancho / base.width });
            const c = lienzo(vp.width, vp.height), ctx = c.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, c.width, c.height);
            await pagina.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
            const url = URL.createObjectURL(await aBlob(c, 0.85));
            urlsVisor.push(url);
            const img = document.createElement('img');
            img.alt = `Página ${n}`;
            img.src = url;
            cont.appendChild(img);
        }
        doc.destroy();
    } catch (e) {
        cont.innerHTML = '<p class="ayuda">No pude abrir el documento.</p>';
    }
}

function cerrarVisor() {
    $('visor').hidden = true;
    document.body.style.overflow = '';
    urlsVisor.forEach((u) => URL.revokeObjectURL(u));
    urlsVisor = [];
    $('visorPaginas').innerHTML = '';
}

async function editarDoc(d) {
    if (paginas.length && !confirm('Ya estás editando otras páginas. ¿Las reemplazo por este documento?')) return;
    cerrarDoc();
    ir('pdf');
    vaciarPaginas();
    intencion = 'eliminar';
    await agregarPdfs([archivoDe(d)]);
}

async function renombrarDoc(d) {
    const nuevo = prompt('Nuevo nombre', d.nombre.replace(/\.pdf$/i, ''));
    if (!nuevo || !nuevo.trim()) return;
    d.nombre = nombreArchivo(nuevo);
    await db.guardarDocumento(d);
    $('docTitulo').textContent = d.nombre;
    pintarDocumentos();
}

async function borrarDoc(d) {
    if (!confirm(`¿Borrar «${d.nombre}» de este celular?`)) return;
    await db.borrarDocumento(d.id);
    cerrarDoc();
    pintarDocumentos();
}

// ── Texto de un PDF: «PDF a texto» y «Hacer buscable un PDF escaneado» ──
// pdf-inspector (Firecrawl, MIT) lee el texto que el PDF ya trae y dice qué páginas son solo imágenes;
// esas páginas se dibujan con pdf.js y las lee Tesseract, igual que en el escáner.

let inspectorListo = null;
function cargarInspector() {
    if (!inspectorListo) {
        inspectorListo = import('./vendor/pdf-inspector/pdf_inspector_wasm.js').then(async (m) => {
            await m.default({ module_or_path: new URL('vendor/pdf-inspector/pdf_inspector_wasm_bg.wasm', location.href) });
            return m;
        });
        inspectorListo.catch(() => { inspectorListo = null; });
    }
    return inspectorListo;
}

const TEXTOS = {
    texto: {
        titulo: 'PDF a texto',
        descripcion: 'Elegí un PDF y te muestro su texto, listo para copiar o mandar por mensaje. No se sube a ningún lado.',
    },
    buscable: {
        titulo: 'Hacer buscable un PDF escaneado',
        descripcion: 'Elegí un PDF que sea solo fotos (como los de un escáner): le agrego el texto invisible para que se pueda buscar y copiar. El PDF se ve igual.',
    },
};
const TIPOS_PDF = {
    TextBased: 'PDF con texto',
    Scanned: 'PDF escaneado (solo imágenes)',
    ImageBased: 'PDF de imágenes',
    Mixed: 'PDF mixto: algunas páginas son imágenes',
};

let textoModo = 'texto';
let textoTarea = null;   // {nombre, bytes, paginas: [texto o null por página], faltan: [números de página]}

function estadoTexto(t, error = false) {
    $('textoEstado').textContent = t;
    $('textoEstado').classList.toggle('error', error);
}
function barraTexto(f) {
    $('textoProgreso').hidden = f === null;
    if (f !== null) $('textoBarra').style.width = `${Math.round(f * 100)}%`;
}

function prepararTexto(modoTexto) {
    textoModo = modoTexto;
    textoTarea = null;
    $('textoTitulo').textContent = TEXTOS[modoTexto].titulo;
    $('textoDescripcion').textContent = TEXTOS[modoTexto].descripcion;
    $('textoArchivo').hidden = true;
    $('textoAvisoOcr').hidden = true;
    $('textoAcciones').hidden = true;
    $('textoSalida').hidden = true;
    $('textoSalida').textContent = '';
    $('textoElegir').textContent = '';
    $('textoElegir').insertAdjacentHTML('beforeend', '<svg aria-hidden="true"><use href="#i-pdf"/></svg>Elegir un PDF');
    estadoTexto('');
    barraTexto(null);
}

// El Markdown de pdf-inspector, pasado a texto común (sin #, ** ni tablas con |)
function textoLegible(md) {
    return (md || '')
        .split('\n')
        .filter((l) => !/^\s*\|?\s*:?-{3,}/.test(l))
        .map((l) => l.replace(/^#{1,6}\s+/, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/(^|\s)_(.+?)_(?=\s|$)/g, '$1$2')
            .replace(/^\s*\|(.*)\|\s*$/, (m, celdas) => celdas.split('|').map((c) => c.trim()).join('   ')))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

async function abrirTexto(archivo) {
    prepararTexto(textoModo);
    $('textoNombre').textContent = archivo.name;
    $('textoTipo').textContent = '';
    $('textoArchivo').hidden = false;
    $('textoElegir').lastChild.textContent = 'Elegir otro PDF';
    estadoTexto('Leyendo el PDF…');
    try {
        const bytes = new Uint8Array(await archivo.arrayBuffer());
        const insp = await cargarInspector();
        let res;
        try {
            res = insp.processPdf(bytes, { profile: 'compact', includePageMarkers: true });
        } catch (e) {
            throw new Error(/password|encrypt/i.test(String(e)) ? 'Este PDF tiene contraseña. Abrilo, guardalo sin contraseña y probá de nuevo.' : 'No pude leerlo: no parece un PDF.');
        }
        // Separa el texto por página con las marcas <!-- Page N -->
        const paginas = Array(res.pageCount).fill('');
        const partes = (res.markdown || '').split(/<!--\s*Page\s+(\d+)\s*-->/i);
        if (partes.length > 1) {
            for (let k = 1; k < partes.length; k += 2) paginas[Number(partes[k]) - 1] = textoLegible(partes[k + 1]);
        } else if (res.pageCount) {
            paginas[0] = textoLegible(res.markdown);
        }
        const faltan = [...new Set(res.pagesNeedingOcr || [])].filter((n) => n >= 1 && n <= res.pageCount).sort((a, b) => a - b);
        faltan.forEach((n) => { paginas[n - 1] = null; });
        textoTarea = { nombre: archivo.name, bytes, paginas, faltan };
        const n = res.pageCount;
        $('textoTipo').textContent = `${TIPOS_PDF[res.pdfType] || 'PDF'}, ${n} ${n === 1 ? 'página' : 'páginas'}`;
        estadoTexto('');
        if (textoModo === 'buscable') return hacerBuscable();
        mostrarTextoExtraido();
        if (faltan.length) {
            $('textoAvisoTexto').textContent = faltan.length === n
                ? 'Este PDF es solo imágenes: no trae texto. Puedo reconocerlo leyendo las imágenes (tarda unos segundos por página).'
                : `${faltan.length === 1 ? 'La página' : 'Las páginas'} ${faltan.join(', ')} ${faltan.length === 1 ? 'es una imagen' : 'son imágenes'}: no ${faltan.length === 1 ? 'trae' : 'traen'} texto. Puedo reconocerlo leyendo las imágenes.`;
            $('textoAvisoOcr').hidden = false;
        }
    } catch (e) {
        estadoTexto(e.message || 'No pude leer el PDF.', true);
    }
}

function textoCompleto() {
    const { paginas } = textoTarea;
    const varias = paginas.length > 1;
    return paginas.map((t, i) => {
        const cuerpo = t === null ? `[La página ${i + 1} es una imagen: todavía no se reconoció su texto]` : (t || '');
        return varias ? `— Página ${i + 1} —\n${cuerpo}` : cuerpo;
    }).join('\n\n').trim();
}

function mostrarTextoExtraido() {
    const texto = textoCompleto();
    const vacio = !textoTarea.paginas.some((t) => t && t.trim());
    $('textoSalida').textContent = texto;
    $('textoSalida').hidden = false;
    if (vacio && !textoTarea.faltan.length) $('textoSalida').textContent = 'Este PDF no tiene texto.';
    $('textoAcciones').hidden = vacio;
    $('textoCompartir').hidden = !(navigator.share && window.isSecureContext);
}

// Dibuja una página con pdf.js (con su giro) y la lee Tesseract
async function leerPagina(vista, n, progreso) {
    const pagina = await vista.getPage(n);
    const base = pagina.getViewport({ scale: 1 });
    const vp = pagina.getViewport({ scale: Math.min(4, LADO_HOJA / Math.max(base.width, base.height)) });
    const c = lienzo(vp.width, vp.height), ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    await pagina.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
    const ocr = await cargarOcr();
    ocrProgreso = (m) => { if (m.status === 'recognizing text') progreso(m.progress); };
    try {
        const { data } = await ocr.recognize(c, {}, { text: true, blocks: true });
        return { data, vp, canvas: c };
    } finally {
        ocrProgreso = null;
    }
}

async function reconocerFaltantes() {
    const t = textoTarea;
    if (!t || !t.faltan.length) return;
    $('textoOcrBtn').disabled = true;
    try {
        estadoTexto('Preparando el reconocimiento de texto…');
        const pdfjs = await cargarPdfjs();
        const vista = await pdfjs.getDocument({ data: t.bytes.slice(), isEvalSupported: false }).promise;
        for (const [k, n] of t.faltan.entries()) {
            estadoTexto(`Reconociendo el texto: página ${n} (${k + 1} de ${t.faltan.length})…`);
            const { data } = await leerPagina(vista, n, (p) => barraTexto((k + p) / t.faltan.length));
            t.paginas[n - 1] = (data.text || '').trim();
            mostrarTextoExtraido();
        }
        vista.destroy();
        t.faltan = [];
        barraTexto(null);
        $('textoAvisoOcr').hidden = true;
        estadoTexto('Listo: se reconoció el texto de todas las páginas.');
    } catch (e) {
        estadoTexto(`No pude reconocer el texto: ${e.message}`, true);
    } finally {
        $('textoOcrBtn').disabled = false;
    }
}

async function hacerBuscable() {
    const t = textoTarea;
    if (!t.faltan.length) {
        estadoTexto('Este PDF ya tiene texto: ya se puede buscar y copiar. No hace falta cambiarlo.');
        return;
    }
    try {
        estadoTexto('Preparando el reconocimiento de texto…');
        barraTexto(0);
        const [pdfjs] = await Promise.all([cargarPdfjs(), window.PDFLib ? null : cargarScript('vendor/pdf-lib.min.js')]);
        const P = PDFLib;
        const doc = await P.PDFDocument.load(t.bytes, { ignoreEncryption: true });
        if (doc.isEncrypted) throw new Error('el PDF está protegido contra cambios');
        const fuente = await doc.embedFont(P.StandardFonts.Helvetica);
        const letras = new Set(fuente.getCharacterSet());
        const vista = await pdfjs.getDocument({ data: t.bytes.slice(), isEvalSupported: false }).promise;
        let palabras = 0, mini = null;
        for (const [k, n] of t.faltan.entries()) {
            estadoTexto(`Reconociendo el texto: página ${n} (${k + 1} de ${t.faltan.length})…`);
            const { data, vp, canvas } = await leerPagina(vista, n, (p) => barraTexto((k + p) / t.faltan.length));
            if (!mini && n === 1) mini = URL.createObjectURL(await aBlob(await dibujar(canvas, LADO_MINI), 0.8));
            const pagina = doc.getPage(n - 1);
            // Lo que ya dibuja la página va entre q/Q, así el texto nuevo arranca sin transformaciones heredadas
            pagina.node.wrapContentStreams(
                doc.context.register(doc.context.contentStream(P.pushGraphicsState())),
                doc.context.register(doc.context.contentStream(P.popGraphicsState())),
            );
            palabras += capaDeTextoEn(pagina, fuente, letras, data.blocks, (x, y) => vp.convertToPdfPoint(x, y));
            await espera();
        }
        vista.destroy();
        barraTexto(1);
        estadoTexto('Guardando el PDF…');
        const blob = new Blob([await doc.save()], { type: 'application/pdf' });
        const nombre = nombreArchivo(`${t.nombre.replace(/\.pdf$/i, '')} (buscable)`);
        const n = t.paginas.length, k = t.faltan.length;
        barraTexto(null);
        estadoTexto('');
        await entregar(blob, nombre, `${n} ${n === 1 ? 'página' : 'páginas'}, ${tamano(blob)}. ` +
            (palabras ? `Se reconoció el texto de ${k === n ? 'todas las páginas' : `${k} ${k === 1 ? 'página' : 'páginas'}`}.` : 'No encontré texto para reconocer.'),
        n, mini);
        if (mini) setTimeout(() => URL.revokeObjectURL(mini), 5000);
    } catch (e) {
        barraTexto(null);
        estadoTexto(`No pude hacerlo buscable: ${e.message}`, true);
    }
}

async function copiarTexto() {
    await copiar(textoCompleto());
    estadoTexto('Texto copiado.');
}

async function copiar(texto) {
    try {
        await navigator.clipboard.writeText(texto);
    } catch (e) {
        // Sin https el navegador no deja usar el portapapeles moderno: se copia a la antigua
        const area = document.createElement('textarea');
        area.value = texto;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
    }
}

// ── Apoyar el proyecto ──

async function abrirApoyar() {
    $('dlgApoyar').hidden = false;
    if ($('apoyarQr').firstChild) return;
    try {
        if (!window.qrcode) await cargarScript('vendor/qrcode/qrcode.js');
        const qr = qrcode(0, 'M');
        qr.addData($('apoyarDireccion').textContent.trim());
        qr.make();
        $('apoyarQr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    } catch (e) {
        $('apoyarQr').hidden = true;
    }
}

async function copiarDireccion() {
    await copiar($('apoyarDireccion').textContent.trim());
    const boton = $('apoyarCopiar');
    boton.lastChild.textContent = '¡Copiada!';
    setTimeout(() => { boton.lastChild.textContent = 'Copiar dirección'; }, 2000);
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
        salida.setCreator('ScannerFree');
        salida.setProducer('ScannerFree');
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
        await entregar(blob, nombre, `${n} ${n === 1 ? 'página' : 'páginas'}, ${tamano(blob)}.`, n, paginas[0] && paginas[0].mini);
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

    $('btnVolver').onclick = volver;
    window.addEventListener('hashchange', () => mostrarVista(vistaDeDireccion()));
    // El selector de archivos se abre en el mismo toque (los navegadores no lo dejan abrir después)
    $('inicioEscanear').onclick = () => { $('inCamara').click(); ir('escanear'); };
    const elegir = (input, cual) => () => { if (cual) intencion = intencion || cual; $(input).click(); };
    const ENTRADAS = { unir: 'inPdf', eliminar: 'inPdfUno', fotos: 'inImagenes' };
    document.querySelectorAll('[data-herramienta]').forEach((b) => {
        const cual = b.dataset.herramienta;
        b.onclick = () => { elegir(ENTRADAS[cual], cual)(); ir('pdf'); };
    });
    $('docVer').onclick = () => verDoc(docAbierto);
    $('docCompartir').onclick = () => compartirDoc(docAbierto);
    $('docDescargar').onclick = () => descargar(docAbierto.blob, docAbierto.nombre);
    $('docEditar').onclick = () => editarDoc(docAbierto);
    $('docRenombrar').onclick = () => renombrarDoc(docAbierto);
    $('docBorrar').onclick = () => borrarDoc(docAbierto);
    $('docCerrar').onclick = cerrarDoc;
    document.querySelectorAll('[data-texto]').forEach((b) => {
        b.onclick = () => { prepararTexto(b.dataset.texto); $('inPdfTexto').click(); ir('texto'); };
    });
    $('textoElegir').onclick = () => $('inPdfTexto').click();
    $('inPdfTexto').onchange = (ev) => { const [archivo] = ev.target.files; ev.target.value = ''; if (archivo) abrirTexto(archivo); };
    $('textoOcrBtn').onclick = reconocerFaltantes;
    $('btnApoyar').onclick = abrirApoyar;
    $('apoyarCopiar').onclick = copiarDireccion;
    $('apoyarCerrar').onclick = () => { $('dlgApoyar').hidden = true; };
    $('textoCopiar').onclick = copiarTexto;
    $('textoDescargar').onclick = () => descargar(new Blob([textoCompleto()], { type: 'text/plain;charset=utf-8' }),
        `${textoTarea.nombre.replace(/\.pdf$/i, '')}.txt`);
    $('textoCompartir').onclick = async () => {
        try { await navigator.share({ title: textoTarea.nombre, text: textoCompleto() }); } catch (e) { /* cancelado */ }
    };
    $('visorCerrar').onclick = cerrarVisor;
    $('visorCompartir').onclick = () => docAbierto && compartirDoc(docAbierto);
    $('btnAgregarPdf').onclick = elegir('inPdf');
    $('btnImagenes').onclick = elegir('inImagenes');
    for (const id of ['inPdf', 'inPdfUno']) {
        $(id).onchange = (ev) => { const archivos = [...ev.target.files]; ev.target.value = ''; agregarPdfs(archivos); };
    }
    $('inImagenes').onchange = (ev) => { const archivos = [...ev.target.files]; ev.target.value = ''; agregarImagenes(archivos); };
    $('btnGuardarPdf').onclick = abrirPdf;
    $('pdfBorrarTodo').onclick = () => { if (confirm('¿Sacar todas las páginas y empezar de nuevo?')) vaciarPaginas(); };

    $('formPdf').onsubmit = (ev) => (modo === 'pdf' ? guardarHerramientas(ev) : crearPdf(ev));
    $('pdfCancelar').onclick = () => { $('dlgPdf').hidden = true; actualizarPasos(); };
    $('btnCompartir').onclick = compartir;
    $('btnNuevo').onclick = nuevoDocumento;
    document.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Escape') return;
        if (!$('editor').hidden) cerrarEditor();
        else if (!$('visor').hidden) cerrarVisor();
        else if (!$('dlgDoc').hidden) cerrarDoc();
        else if (!$('dlgApoyar').hidden) $('dlgApoyar').hidden = true;
        else if (!$('dlgPdf').hidden && !$('pdfCrear').disabled) $('pdfCancelar').click();
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

// «Cómo funciona»: le dice a cada paso en qué escalón va y pone una línea ondulada entre paso y paso.
// Los pasos se cambian en index.html; esto no hace falta tocarlo.
function armarGuia() {
    const guia = $('guia');
    guia.querySelectorAll('.onda').forEach((o) => o.remove());
    const pasos = [...guia.querySelectorAll('.paso')];
    guia.style.setProperty('--n', pasos.length);
    pasos.forEach((paso, i) => {
        paso.style.setProperty('--i', i);
        if (i === pasos.length - 1) return;
        const onda = document.createElement('li');
        onda.className = 'onda';
        onda.setAttribute('aria-hidden', 'true');
        onda.style.setProperty('--i', i);
        // Baja del círculo de este paso al del siguiente, con una ola en el medio
        onda.innerHTML = '<svg viewBox="0 0 100 60" preserveAspectRatio="none"><path d="M0 0C0 24 30 18 50 30S100 36 100 60"/></svg>';
        paso.after(onda);
    });
}

conectar();
armarGuia();
modo = null;
mostrarVista(vistaDeDireccion());
recuperar();
// OpenCV pesa: se empieza a cargar apenas abre la app, así está lista para la primera foto
setTimeout(() => cargarCv().catch(() => {}), 300);

if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
}
