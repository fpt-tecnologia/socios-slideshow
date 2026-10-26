require('dotenv').config();
const express = require('express');
const path = require('path');
const XLSX = require('xlsx');
const { Storage } = require('@google-cloud/storage');

const app = express();
const PORT = process.env.PORT || 8080;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'cambia-esta-clave';

// Identificador de la version desplegada. Cloud Run pone K_REVISION solo
// (ej. socios-slideshow-00053-abc). Las pantallas lo consultan para darse
// cuenta de que hay codigo nuevo y recargarse sin que nadie vaya al club.
const APP_VERSION = process.env.K_REVISION || ('local-' + Date.now());
// Token separado para el puente automatico (tarea programada que lee el
// numero de socios via Microsoft 365 y lo empuja aqui). No es la clave de
// administrador humana: asi, si se filtra o se rota, no afecta el login del panel.
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || null;
const FETCH_INTERVAL_MS = Number(process.env.SOCIOS_FETCH_MINUTES || 5) * 60 * 1000;
const BUCKET_NAME = process.env.GCS_BUCKET;
const MAX_PPTX_BYTES = 1024 * 1024 * 1024; // 1024 MB (1 GB)

// ---------- Sincronizacion en vivo desde SharePoint/OneDrive ----------
// Revisa periodicamente un archivo .pptx compartido y, si cambio, lo
// descarga y lo publica como la presentacion actual (misma ruta que usa
// la subida manual), sin tocar el contador de socios.
const MS_TENANT_ID = process.env.MS_TENANT_ID || '';
const MS_CLIENT_ID = process.env.MS_CLIENT_ID || '';
const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET || '';
// Enlace de SharePoint/OneDrive a sincronizar. Empieza con el valor de la
// variable de entorno, pero se puede cambiar en caliente desde el panel de
// administracion (ver /api/sharepoint/set-link); ese cambio se guarda en
// config.sharePointShareUrl y sobrevive a reinicios/despliegues.
let sharePointShareUrl = process.env.SHAREPOINT_SHARE_URL || '';
// Enlace de SharePoint/OneDrive para la pantalla 2. Mismo mecanismo que arriba,
// pero independiente: se puede cambiar sin afectar a la pantalla 1.
let sharePointShareUrl2 = process.env.SHAREPOINT_SHARE_URL_2 || '';
const SHAREPOINT_POLL_MS = Number(process.env.SHAREPOINT_POLL_MINUTES || 15) * 60 * 1000;

if (!BUCKET_NAME) {
  console.error('Falta la variable de entorno GCS_BUCKET. El servidor no puede iniciar sin ella.');
  process.exit(1);
}

const storage = new Storage();
const bucket = storage.bucket(BUCKET_NAME);

const PPTX_OBJECT = 'uploads/current.pptx';
const CONFIG_OBJECT = 'data/config.json';
const CACHE_OBJECT = 'data/socios-cache.json';
const STATUS_OBJECT = 'data/presentation-status.json';
const SHAREPOINT_STATE_OBJECT = 'data/sharepoint-sync.json';
const POWERBI_STATE_OBJECT = 'data/powerbi-sync.json';

// ---------- Pantalla 2 (segunda Smart TV) ----------
// La pantalla "1" (arriba) es la original: sigue usando exactamente las mismas
// rutas de siempre para no interrumpir la que ya esta en produccion. La
// pantalla "2" es nueva y usa su propio espacio, completamente independiente.
const SCREEN2_CONTENT_OBJECT = 'uploads/screen-2/current-content';
const SCREEN2_STATUS_OBJECT = 'data/screen-2/status.json';
const SCREEN2_CONFIG_OBJECT = 'data/screen-2/config.json';
const SCREEN2_SHAREPOINT_STATE_OBJECT = 'data/screen-2/sharepoint-sync.json';

// ---------- Pantallas 3, 4 y 5 (mas simples: solo subir video o presentacion) ----------
// No tienen sincronizacion con SharePoint ni contador de socios; solo lo esencial
// para servir el contenido subido manualmente, igual que las demas pantallas.
const SIMPLE_SCREEN_IDS = ['3', '4', '5', '6', '7', '8', '9', '10'];
const SIMPLE_SCREEN_OBJECTS = {
  '3': { content: 'uploads/screen-3/current-content', status: 'data/screen-3/status.json' },
  '4': { content: 'uploads/screen-4/current-content', status: 'data/screen-4/status.json' },
  '5': { content: 'uploads/screen-5/current-content', status: 'data/screen-5/status.json' },
  '6': { content: 'uploads/screen-6/current-content', status: 'data/screen-6/status.json' },
  '7': { content: 'uploads/screen-7/current-content', status: 'data/screen-7/status.json' },
  '8': { content: 'uploads/screen-8/current-content', status: 'data/screen-8/status.json' },
  '9': { content: 'uploads/screen-9/current-content', status: 'data/screen-9/status.json' },
  '10': { content: 'uploads/screen-10/current-content', status: 'data/screen-10/status.json' },
};

// Tipos de archivo admitidos como contenido de una pantalla (presentacion o video).
const CONTENT_TYPE_BY_EXT = {
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};
function detectContentType(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  return CONTENT_TYPE_BY_EXT[ext] || null;
}
function normalizeScreenId(value) {
  const s = String(value || '1').trim();
  return (s === '2' || SIMPLE_SCREEN_IDS.includes(s)) ? s : '1';
}

// ---------- Persistencia en Google Cloud Storage ----------
async function loadJSONFromGCS(objectName, fallback) {
  try {
    const [contents] = await bucket.file(objectName).download();
    return JSON.parse(contents.toString('utf8'));
  } catch (e) {
    return fallback;
  }
}
async function saveJSONToGCS(objectName, data) {
  await bucket.file(objectName).save(JSON.stringify(data, null, 2), {
    contentType: 'application/json',
    resumable: false,
  });
}

// Estado en memoria (se recarga de GCS al iniciar y se sincroniza en cada cambio)
let config = {
  excelUrl: process.env.SOCIOS_EXCEL_URL || '',
  sheetName: '',
  cell: '',
  label: 'socios',
  slideIntervalSeconds: 10,
  overrideEnabled: false,
  overrideValue: null,
  overrideSource: null,
  manualOverride: false,
  sharePointShareUrl: '',
};
let socios = {
  count: null,
  updatedAt: null,
  source: null,
  error: 'Aun no se ha consultado el Excel.',
};
let presentationStatus = {
  hasPresentation: false,
  contentType: null,
  originalName: null,
  uploadedAt: null,
};
let sharepointSync = {
  lastModifiedDateTime: null,
  lastCheckedAt: null,
  lastSyncedAt: null,
  sourceName: null,
  error: null,
};

// ---------- Estado de la pantalla 2 (independiente de la pantalla 1) ----------
let presentationStatus2 = {
  hasPresentation: false,
  contentType: null,
  originalName: null,
  uploadedAt: null,
};
let sharepointSync2 = {
  lastModifiedDateTime: null,
  lastCheckedAt: null,
  lastSyncedAt: null,
  sourceName: null,
  error: null,
};
let screenConfig2 = {
  sharePointShareUrl: '',
  slideIntervalSeconds: 10,
  showSociosTicker: false,
};

// Estado en memoria de las pantallas 3, 4 y 5 (simples: sin SharePoint ni ticker).
const simpleScreenState = {
  '3': { status: { hasPresentation: false, contentType: null, originalName: null, uploadedAt: null } },
  '4': { status: { hasPresentation: false, contentType: null, originalName: null, uploadedAt: null } },
  '5': { status: { hasPresentation: false, contentType: null, originalName: null, uploadedAt: null } },
  '6': { status: { hasPresentation: false, contentType: null, originalName: null, uploadedAt: null } },
  '7': { status: { hasPresentation: false, contentType: null, originalName: null, uploadedAt: null } },
  '8': { status: { hasPresentation: false, contentType: null, originalName: null, uploadedAt: null } },
  '9': { status: { hasPresentation: false, contentType: null, originalName: null, uploadedAt: null } },
  '10': { status: { hasPresentation: false, contentType: null, originalName: null, uploadedAt: null } },
};

// Da acceso uniforme al estado y a las rutas de almacenamiento de una pantalla,
// para reusar toda la logica de subida/SharePoint/servido sin duplicarla. La
// pantalla "1" sigue usando las variables y archivos de siempre.

// ---------- Listas de reproduccion (solo pantallas 3 en adelante) ----------
// Cada pantalla simple puede tener una lista ordenada de videos que se
// reproducen uno tras otro y vuelven a empezar al terminar el ultimo.
// Un mismo video puede aparecer varias veces en la lista: cada aparicion es
// un "slot" con identificador propio que apunta al mismo archivo ("video").
const simplePlaylists = {};
for (const plId of SIMPLE_SCREEN_IDS) simplePlaylists[plId] = { items: [], updatedAt: null };

// Una "clave" es el numero de una pantalla global ('1'..'10') o la clave
// interna de una pantalla de club ('club:<codigo>:<1-4>'). Para las globales
// estas rutas son byte por byte las de siempre.
function carpetaDeClave(clave) {
  const c = parseClaveClub(clave);
  return c ? ('clubes/' + c.codigo + '/screen-' + c.n) : ('screen-' + clave);
}
function playlistObjectName(screenId) {
  return 'data/' + carpetaDeClave(screenId) + '/playlist.json';
}
function playlistItemObjectName(screenId, videoId) {
  return 'uploads/' + carpetaDeClave(screenId) + '/playlist/' + videoId;
}
function asPlaylistScreen(value) {
  const s = String(value || '').trim();
  return SIMPLE_SCREEN_IDS.includes(s) ? s : null;
}
function isValidItemId(value) {
  return /^[a-f0-9]{24}$/.test(String(value || ''));
}
function newItemId() {
  let s = '';
  while (s.length < 24) s += Math.floor(Math.random() * 16).toString(16);
  return s.slice(0, 24);
}
// Acepta listas guardadas con el formato anterior (un solo id por renglon).
function normalizePlaylistItems(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  const out = [];
  for (const raw of rawItems) {
    if (!raw) continue;
    const video = raw.video || raw.id;
    if (!isValidItemId(video)) continue;
    out.push({
      slot: isValidItemId(raw.slot) ? raw.slot : newItemId(),
      video,
      name: String(raw.name || 'video').slice(0, 200),
      contentType: raw.contentType || 'video/mp4',
      addedAt: raw.addedAt || null,
    });
  }
  return out;
}
async function savePlaylist(screenId) {
  const pl = simplePlaylists[screenId];
  pl.updatedAt = new Date().toISOString();
  await saveJSONToGCS(playlistObjectName(screenId), pl);
  return pl;
}
// Borra el archivo solo cuando ningun otro renglon lo sigue usando.
async function deleteOrphanVideo(screenId, videoId) {
  const stillUsed = simplePlaylists[screenId].items.some((it) => it.video === videoId);
  if (stillUsed) return;
  try {
    await bucket.file(playlistItemObjectName(screenId, videoId)).delete();
  } catch (err) {
    // el archivo ya no existe: no es un problema
  }
}


// ---------- Administracion por club ----------
// Cada club tiene sus propias 4 pantallas, numeradas 1 a 4 DENTRO del club y
// guardadas en su propio arbol de archivos. Nada de lo que ya existe cambia:
// las pantallas globales 1 a 10 siguen usando exactamente las mismas rutas.
// Mientras un club no suba contenido propio, sus pantallas sirven el de la
// pantalla global que le toca por plantilla. Asi, migrar una TV es solo
// cambiarle la direccion: lo que se ve en la pared no cambia.
const CLUBES_OBJECT = 'data/clubes.json';
const CLUB_SCREEN_IDS = ['1', '2', '3', '4'];
const PLANTILLA_POR_DEFECTO = { '1': '3', '2': '4', '3': '5', '4': '6' };
let clubes = { actualizado: null, plantilla: Object.assign({}, PLANTILLA_POR_DEFECTO), clubes: [] };
const clubesPorCodigo = new Map();

function esCodigoClub(valor) {
  return /^[a-z0-9][a-z0-9-]{1,39}$/.test(String(valor || ''));
}
function reindexarClubes() {
  clubesPorCodigo.clear();
  for (const c of ((clubes && clubes.clubes) || [])) {
    if (c && esCodigoClub(c.codigo)) clubesPorCodigo.set(c.codigo, c);
  }
}
// A que pantalla global le copia una pantalla de club mientras no tenga
// contenido propio. Es configurable para que la migracion no dependa de que
// yo adivine que zona es cada pantalla.
function plantillaPara(n) {
  const p = (clubes && clubes.plantilla) || PLANTILLA_POR_DEFECTO;
  const destino = String(p[String(n)] || PLANTILLA_POR_DEFECTO[String(n)] || '3');
  return SIMPLE_SCREEN_IDS.indexOf(destino) !== -1 ? destino : '3';
}
// Clave interna de una pantalla de club. Las globales siguen siendo su numero
// pelado ('1'..'10'), por lo que ninguna ruta de archivo existente se mueve.
function claveDeClub(codigo, n) {
  return 'club:' + codigo + ':' + n;
}
function parseClaveClub(valor) {
  const m = /^club:([a-z0-9][a-z0-9-]{1,39}):([1-4])$/.exec(String(valor || ''));
  return m ? { codigo: m[1], n: m[2] } : null;
}
function objetosDeClub(clave) {
  const c = parseClaveClub(clave);
  if (!c) return null;
  return {
    content: 'uploads/clubes/' + c.codigo + '/screen-' + c.n + '/current-content',
    status: 'data/clubes/' + c.codigo + '/screen-' + c.n + '/status.json',
  };
}
// Punto unico donde se decide a que pantalla apunta una peticion. Si viene un
// club que no existe NUNCA se cae en silencio a una pantalla global: se
// devuelve un error. Ese silencio fue justo lo que una vez piso el contenido
// de la pantalla 1.
function resolverClave(screenRaw, clubRaw) {
  const club = String(clubRaw === null || clubRaw === undefined ? '' : clubRaw).trim();
  if (!club) return { clave: normalizeScreenId(screenRaw) };
  if (!esCodigoClub(club) || !clubesPorCodigo.has(club)) {
    return { error: 'El club "' + club.slice(0, 40) + '" no existe. No se hizo nada.' };
  }
  const n = String(screenRaw === null || screenRaw === undefined ? '' : screenRaw).trim();
  if (CLUB_SCREEN_IDS.indexOf(n) === -1) {
    return { error: 'Un club solo tiene las pantallas 1 a 4.' };
  }
  return { clave: claveDeClub(club, n), club: club, n: n };
}
// El estado de las pantallas de club se carga cuando se usa, no al arrancar:
// con 50+ clubes serian cientos de lecturas en cada arranque en frio. Se
// vuelve a leer cada pocos minutos por si la subida la recibio otra instancia.
const REFRESCO_CLUB_MS = 5 * 60 * 1000;
const clubCargadoEn = new Map();
const clubCargando = new Map();
function estadoVacioDeClub() {
  return { status: { hasPresentation: false, contentType: null, originalName: null, uploadedAt: null } };
}
async function asegurarClave(clave) {
  const c = parseClaveClub(clave);
  if (!c) return;
  if (!simpleScreenState[clave]) simpleScreenState[clave] = estadoVacioDeClub();
  if (!simplePlaylists[clave]) simplePlaylists[clave] = { items: [], updatedAt: null };
  const desde = clubCargadoEn.get(clave) || 0;
  if (Date.now() - desde < REFRESCO_CLUB_MS) return;
  // Si ya hay una carga en vuelo, esperamos esa misma: si no, dos peticiones
  // casi simultaneas de la misma pantalla verian el estado todavia vacio y
  // una de ellas mostraria la plantilla por un minuto sin razon.
  if (clubCargando.has(clave)) return clubCargando.get(clave);
  const tarea = (async () => {
    try {
      const st = await loadJSONFromGCS(objetosDeClub(clave).status, null);
      if (st) simpleScreenState[clave].status = st;
      const pl = await loadJSONFromGCS(playlistObjectName(clave), null);
      if (pl && Array.isArray(pl.items)) {
        simplePlaylists[clave] = { items: normalizePlaylistItems(pl.items), updatedAt: pl.updatedAt || null };
      }
      clubCargadoEn.set(clave, Date.now());
    } catch (e) {
      console.error('No se pudo cargar el estado de ' + clave + ': ' + e.message);
    } finally {
      clubCargando.delete(clave);
    }
  })();
  clubCargando.set(clave, tarea);
  return tarea;
}
// Para LEER: si el club aun no sube nada propio, se sirve la plantilla.
// Para ESCRIBIR siempre se usa la clave propia del club; una subida jamas
// puede acabar en la plantilla ni en una pantalla global.
async function claveDeLectura(clave) {
  const c = parseClaveClub(clave);
  if (!c) return clave;
  await asegurarClave(clave);
  const pl = simplePlaylists[clave];
  const st = simpleScreenState[clave];
  const tienePropio = (pl && pl.items && pl.items.length > 0) ||
                      (st && st.status && st.status.hasPresentation);
  return tienePropio ? clave : plantillaPara(c.n);
}
function ctxDeClub(clave) {
  const objs = objetosDeClub(clave);
  if (!simpleScreenState[clave]) simpleScreenState[clave] = estadoVacioDeClub();
  const state = simpleScreenState[clave];
  return {
    screenId: clave,
    contentObject: objs.content,
    statusObject: objs.status,
    sharepointStateObject: null,
    getStatus: () => state.status,
    setStatus: (v) => { state.status = v; },
    getSharepointSync: () => ({ lastModifiedDateTime: null, lastCheckedAt: null, lastSyncedAt: null, sourceName: null, error: null }),
    setSharepointSync: () => {},
    getShareUrl: () => '',
    setShareUrl: () => {},
    getSlideIntervalSeconds: () => 10,
    setSlideIntervalSeconds: () => {},
    // Una pantalla de club nunca muestra el contador de socios: ese dato es
    // de corporativo y vive solo en las pantallas globales 1 y 2.
    getShowSociosTicker: () => false,
    setShowSociosTicker: () => {},
    saveScreenConfig: async () => {},
  };
}

function getScreenCtx(screenIdRaw) {
  if (parseClaveClub(screenIdRaw)) return ctxDeClub(String(screenIdRaw));
  const screenId = normalizeScreenId(screenIdRaw);
  if (screenId === '2') {
    return {
      screenId,
      contentObject: SCREEN2_CONTENT_OBJECT,
      statusObject: SCREEN2_STATUS_OBJECT,
      sharepointStateObject: SCREEN2_SHAREPOINT_STATE_OBJECT,
      getStatus: () => presentationStatus2,
      setStatus: (v) => { presentationStatus2 = v; },
      getSharepointSync: () => sharepointSync2,
      setSharepointSync: (v) => { sharepointSync2 = v; },
      getShareUrl: () => sharePointShareUrl2,
      setShareUrl: (v) => { sharePointShareUrl2 = v; },
      getSlideIntervalSeconds: () => screenConfig2.slideIntervalSeconds || 10,
      setSlideIntervalSeconds: (n) => { screenConfig2 = { ...screenConfig2, slideIntervalSeconds: n }; },
      getShowSociosTicker: () => Boolean(screenConfig2.showSociosTicker),
      setShowSociosTicker: (b) => { screenConfig2 = { ...screenConfig2, showSociosTicker: Boolean(b) }; },
      saveScreenConfig: async () => {
        screenConfig2 = { ...screenConfig2, sharePointShareUrl: sharePointShareUrl2 };
        await saveJSONToGCS(SCREEN2_CONFIG_OBJECT, screenConfig2);
      },
    };
  }
  if (SIMPLE_SCREEN_OBJECTS[screenId]) {
    const objs = SIMPLE_SCREEN_OBJECTS[screenId];
    const state = simpleScreenState[screenId];
    return {
      screenId,
      contentObject: objs.content,
      statusObject: objs.status,
      sharepointStateObject: null,
      getStatus: () => state.status,
      setStatus: (v) => { state.status = v; },
      getSharepointSync: () => ({ lastModifiedDateTime: null, lastCheckedAt: null, lastSyncedAt: null, sourceName: null, error: null }),
      setSharepointSync: () => {},
      getShareUrl: () => '',
      setShareUrl: () => {},
      getSlideIntervalSeconds: () => 10,
      setSlideIntervalSeconds: () => {},
      getShowSociosTicker: () => false,
      setShowSociosTicker: () => {},
      saveScreenConfig: async () => {},
    };
  }
  return {
    screenId: '1',
    contentObject: PPTX_OBJECT,
    statusObject: STATUS_OBJECT,
    sharepointStateObject: SHAREPOINT_STATE_OBJECT,
    getStatus: () => presentationStatus,
    setStatus: (v) => { presentationStatus = v; },
    getSharepointSync: () => sharepointSync,
    setSharepointSync: (v) => { sharepointSync = v; },
    getShareUrl: () => config.sharePointShareUrl,
    setShareUrl: (v) => { config = { ...config, sharePointShareUrl: v }; },
    getSlideIntervalSeconds: () => config.slideIntervalSeconds || 10,
    setSlideIntervalSeconds: (n) => { config = { ...config, slideIntervalSeconds: n }; },
    // La pantalla 1 siempre muestra el contador de socios (comportamiento de
    // siempre); no es configurable desde aqui.
    getShowSociosTicker: () => true,
    setShowSociosTicker: () => {},
    saveScreenConfig: async () => {
      await saveJSONToGCS(CONFIG_OBJECT, config);
    },
  };
}

let powerbiSync = {
  blackCardPct: null,
  clubesAbiertos: null,
  lastValue: null,
  lastCheckedAt: null,
  lastSyncedAt: null,
  error: null,
};

// ---------- Middleware ----------
app.use(express.json());
app.get('/api/version', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ version: APP_VERSION });
});

app.use(express.static(path.join(__dirname, 'public')));

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Token de administrador invalido.' });
  }
  next();
}

// Middleware separado para el puente automatico (tarea programada). Usa su
// propio token (BRIDGE_TOKEN) para no depender de la clave de administrador humana.
function requireBridge(req, res, next) {
  const token = req.headers['x-bridge-token'] || req.query.token;
  if (!BRIDGE_TOKEN || token !== BRIDGE_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Token de puente invalido o no configurado.' });
  }
  next();
}

// ---------- Subida de presentacion (URL firmada directo a GCS) ----------
// Cloud Run limita las peticiones HTTP a 32 MB, asi que el navegador NO sube
// el archivo a este servidor: primero pide una URL firmada y luego sube el
// archivo directo a Google Cloud Storage (hasta 1024 MB).
app.post('/api/upload-url', requireAdmin, async (req, res) => {
  try {
    const { fileSize, fileName } = req.body || {};
    const rc = resolverClave(req.body && req.body.screen, req.body && req.body.club);
    if (rc.error) return res.status(400).json({ ok: false, error: rc.error });
    const ctx = getScreenCtx(rc.clave);
    if (fileSize && Number(fileSize) > MAX_PPTX_BYTES) {
      return res.status(400).json({ ok: false, error: `El archivo supera el limite de ${MAX_PPTX_BYTES / (1024 * 1024)} MB.` });
    }
    const contentType = detectContentType(fileName);
    if (!contentType) {
      return res.status(400).json({ ok: false, error: 'Formato no admitido. Usa .pptx, .mp4, .mov, .webm o .m4v.' });
    }
    const [url] = await bucket.file(ctx.contentObject).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + 60 * 60 * 1000, // 60 minutos (archivos grandes tardan mas en subir)
      contentType,
    });
    res.json({ ok: true, url, contentType });
  } catch (e) {
    console.error('Error generando URL firmada:', e);
    res.status(500).json({ ok: false, error: 'No se pudo preparar la subida: ' + e.message });
  }
});

app.post('/api/upload-complete', requireAdmin, async (req, res) => {
  try {
    const { originalName } = req.body || {};
    const rc = resolverClave(req.body && req.body.screen, req.body && req.body.club);
    if (rc.error) return res.status(400).json({ ok: false, error: rc.error });
    const ctx = getScreenCtx(rc.clave);
    const idPantalla = String(rc.clave);
    let compresion = null;
    if (idPantalla === '2') {
      compresion = await comprimirObjetoGCS(ctx.contentObject, 'pantalla 2');
    }
    const status = {
      hasPresentation: true,
      contentType: compresion ? 'video/mp4' : (detectContentType(originalName) || 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
      originalName: originalName || 'presentacion.pptx',
      uploadedAt: new Date().toISOString(),
    };
    ctx.setStatus(status);
    await saveJSONToGCS(ctx.statusObject, status);
    res.json({ ok: true, status, compresion: compresion });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/status', async (req, res) => {
  const rc = resolverClave(req.query.screen, req.query.club);
  if (rc.error) {
    return res.status(404).json({ ok: false, error: rc.error, hasPresentation: false, clubDesconocido: true });
  }
  const ctx = getScreenCtx(await claveDeLectura(rc.clave));
  res.json(ctx.getStatus());
});

// Config publica (sin datos sensibles) para la pantalla de la Smart TV
app.get('/api/display-config', async (req, res) => {
  const rc = resolverClave(req.query.screen, req.query.club);
  if (rc.error) {
    return res.status(404).json({ ok: false, error: rc.error, slideIntervalSeconds: 10, showSociosTicker: false });
  }
  const ctx = getScreenCtx(await claveDeLectura(rc.clave));
  res.json({ slideIntervalSeconds: ctx.getSlideIntervalSeconds(), showSociosTicker: ctx.getShowSociosTicker() });
});

app.get('/api/current-pptx', async (req, res) => {
  const rc = resolverClave(req.query.screen, req.query.club);
  if (rc.error) {
    return res.status(404).json({ ok: false, error: rc.error });
  }
  const ctx = getScreenCtx(await claveDeLectura(rc.clave));
  const status = ctx.getStatus();
  const contentType = (status && status.contentType) || 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  const file = bucket.file(ctx.contentObject);

  // Los videos grandes necesitan que el servidor soporte solicitudes de
  // rango (Range) para que el navegador pueda reproducirlos; sin esto el
  // navegador se queda "cargando" indefinidamente en archivos grandes.
  let metadata;
  try {
    [metadata] = await file.getMetadata();
  } catch (err) {
    res.status(404).json({ ok: false, error: 'Todavia no se ha subido ninguna presentacion.' });
    return;
  }

  const fileSize = Number(metadata.size) || 0;
  const range = req.headers.range;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', 'bytes');

  const handleStreamError = () => {
    if (!res.headersSent) {
      res.status(404).json({ ok: false, error: 'Todavia no se ha subido ninguna presentacion.' });
    } else {
      res.end();
    }
  };

  if (range && fileSize > 0) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    let start, end;
    if (match && match[1] === '' && match[2] !== '') {
      // Suffix byte-range-spec: "bytes=-N" significa los ultimos N bytes
      // del archivo (usado por el navegador para localizar el atomo moov
      // al final de videos MP4 que no estan optimizados con "faststart").
      const suffixLength = parseInt(match[2], 10);
      start = Math.max(fileSize - suffixLength, 0);
      end = fileSize - 1;
    } else {
      start = match && match[1] ? parseInt(match[1], 10) : 0;
      end = match && match[2] ? parseInt(match[2], 10) : fileSize - 1;
    }
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= fileSize) end = fileSize - 1;
    if (start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
      return;
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    const stream = file.createReadStream({ start, end });
    stream.on('error', handleStreamError);
    stream.pipe(res);
  } else {
    const stream = file.createReadStream();
    stream.on('error', handleStreamError);
    stream.pipe(res);
  }
});

// ---------- Lista de reproduccion de varios videos (pantallas 3 en adelante) ----------
const PLAYLIST_VIDEO_EXT = ['.mp4', '.m4v', '.mov', '.webm'];

// Devuelve la clave de ESCRITURA: la propia del club, nunca la plantilla.
async function requirePlaylistScreen(req, res) {
  const raw = (req.body && req.body.screen) || req.query.screen;
  const club = (req.body && req.body.club) || req.query.club;
  const rc = resolverClave(raw, club);
  if (rc.error) {
    res.status(400).json({ ok: false, error: rc.error });
    return null;
  }
  if (parseClaveClub(rc.clave)) {
    // Las cuatro pantallas de un club admiten lista de reproduccion.
    await asegurarClave(rc.clave);
    return rc.clave;
  }
  const screenId = asPlaylistScreen(rc.clave);
  if (!screenId) {
    res.status(400).json({ ok: false, error: 'La lista de reproduccion solo esta disponible en las pantallas 3 en adelante.' });
    return null;
  }
  return screenId;
}
// Clave de LECTURA de una lista: la del club si ya tiene videos propios, si no
// la de la plantilla corporativa.
async function claveDeListaParaLeer(screenRaw, clubRaw) {
  const rc = resolverClave(screenRaw, clubRaw);
  if (rc.error) return { error: rc.error };
  const lectura = await claveDeLectura(rc.clave);
  if (parseClaveClub(lectura)) return { clave: lectura };
  const screenId = asPlaylistScreen(lectura);
  return screenId ? { clave: screenId } : { clave: null };
}

app.get('/api/playlist', async (req, res) => {
  const rl = await claveDeListaParaLeer(req.query.screen, req.query.club);
  if (rl.error) {
    return res.status(404).json({ ok: false, enabled: false, items: [], updatedAt: null, error: rl.error, clubDesconocido: true });
  }
  const screenId = rl.clave;
  if (!screenId) {
    return res.json({ ok: true, enabled: false, items: [], updatedAt: null });
  }
  const pl = simplePlaylists[screenId] || { items: [], updatedAt: null };
  res.json({
    ok: true,
    enabled: true,
    updatedAt: pl.updatedAt || null,
    items: (pl.items || []).map((it) => ({
      slot: it.slot,
      video: it.video,
      name: it.name,
      contentType: it.contentType,
    })),
  });
});

app.post('/api/playlist/upload-url', requireAdmin, async (req, res) => {
  try {
    const screenId = await requirePlaylistScreen(req, res);
    if (!screenId) return;
    const { fileName, fileSize } = req.body || {};
    const ext = path.extname(String(fileName || '')).toLowerCase();
    if (!PLAYLIST_VIDEO_EXT.includes(ext)) {
      return res.status(400).json({ ok: false, error: 'La lista solo admite videos: .mp4, .m4v, .mov o .webm.' });
    }
    if (fileSize && Number(fileSize) > MAX_PPTX_BYTES) {
      return res.status(400).json({ ok: false, error: `El archivo supera el limite de ${MAX_PPTX_BYTES / (1024 * 1024)} MB.` });
    }
    const contentType = detectContentType(fileName) || 'video/mp4';
    const itemId = newItemId();
    const [url] = await bucket.file(playlistItemObjectName(screenId, itemId)).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + 60 * 60 * 1000,
      contentType,
    });
    res.json({ ok: true, url, contentType, itemId });
  } catch (e) {
    console.error('Error generando URL firmada de lista:', e);
    res.status(500).json({ ok: false, error: 'No se pudo preparar la subida: ' + e.message });
  }
});

// Comprime en el servidor el video que acaba de subir marketing.
// Nunca interrumpe la subida: si algo falla, el archivo original se queda
// tal cual y la unica consecuencia es que pesa mas.
const COMP_MAX_ENTRADA = 300 * 1024 * 1024; // mas grande que esto no se toca
const COMP_MIN_ENTRADA = 2 * 1024 * 1024;   // mas chico que esto ya esta bien

// Devuelve true solo si el archivo tiene al menos un stream de video.
// Asi nunca intentamos comprimir un .pptx ni un archivo corrupto.
async function tieneStreamDeVideo(rutaArchivo) {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const correr = promisify(execFile);
  try {
    const r = await correr('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', rutaArchivo],
      { timeout: 90 * 1000, maxBuffer: 1024 * 1024 });
    return String(r.stdout || '').trim().length > 0;
  } catch (e) {
    return false;
  }
}

// Comprime un objeto cualquiera del bucket, en su mismo lugar.
// Lo usa la pantalla 2. La pantalla 1 nunca pasa por aqui.
async function comprimirObjetoGCS(nombreObjeto, etiqueta) {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { execFile } = require('child_process'); const { promisify } = require('util');
  const correr = promisify(execFile);
  const obj = bucket.file(nombreObjeto);
  const base = 'c' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const entrada = path.join(os.tmpdir(), base + '.in');
  const salida = path.join(os.tmpdir(), base + '.mp4');
  let antes = 0;
  try {
    const [meta] = await obj.getMetadata();
    antes = Number(meta.size || 0);
    if (!antes || antes > COMP_MAX_ENTRADA) return null;
    if (antes < COMP_MIN_ENTRADA) return null;
    await obj.download({ destination: entrada });
    if (!(await tieneStreamDeVideo(entrada))) {
      console.log('[compresion] ' + etiqueta + ': no es un video, se deja tal cual');
      return null;
    }
    await correr('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-i', entrada, '-an',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25',
      '-maxrate', '2000k', '-bufsize', '4000k', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', salida],
      { timeout: 8 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
    const despues = fs.statSync(salida).size;
    if (!despues || despues >= antes) return null;
    if (!(await tieneStreamDeVideo(salida))) {
      console.error('[compresion] ' + etiqueta + ': el resultado no es video valido, no se sube');
      return null;
    }
    await bucket.upload(salida, {
      destination: nombreObjeto,
      metadata: { contentType: 'video/mp4' }, resumable: false,
    });
    console.log('[compresion] ' + etiqueta + ': ' + (antes / 1048576).toFixed(1) +
      ' -> ' + (despues / 1048576).toFixed(1) + ' MiB');
    return { antes: antes, despues: despues };
  } catch (e) {
    console.error('[compresion] no se pudo comprimir ' + etiqueta + ': ' + e.message);
    return null;
  } finally {
    try { fs.unlinkSync(entrada); } catch (e) {}
    try { fs.unlinkSync(salida); } catch (e) {}
  }
}

async function comprimirVideoSubido(screenId, itemId) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const correr = promisify(execFile);

  const objeto = bucket.file(playlistItemObjectName(screenId, itemId));
  const dir = os.tmpdir();
  const entrada = path.join(dir, 'in-' + itemId);
  const salida = path.join(dir, 'out-' + itemId + '.mp4');
  let antes = 0;

  try {
    const [meta] = await objeto.getMetadata();
    antes = Number(meta.size || 0);
    if (!antes || antes > COMP_MAX_ENTRADA) return null;
    if (antes < COMP_MIN_ENTRADA) return null;

    await objeto.download({ destination: entrada });
    if (!(await tieneStreamDeVideo(entrada))) {
      console.log('[compresion] ' + itemId + ': no es un video, se deja tal cual');
      return null;
    }

    await correr('ffmpeg', [
      '-nostdin', '-y', '-loglevel', 'error',
      '-i', entrada,
      '-an',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25',
      '-maxrate', '2000k', '-bufsize', '4000k',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      salida,
    ], { timeout: 8 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });

    const despues = fs.statSync(salida).size;
    if (!despues || despues >= antes) return null;

    if (!(await tieneStreamDeVideo(salida))) {
      console.error('[compresion] ' + itemId + ': el resultado no es video valido, no se sube');
      return null;
    }
    await bucket.upload(salida, {
      destination: playlistItemObjectName(screenId, itemId),
      metadata: { contentType: 'video/mp4' },
      resumable: false,
    });
    console.log('[compresion] pantalla ' + screenId + ' ' + itemId +
      ': ' + (antes / 1048576).toFixed(1) + ' -> ' + (despues / 1048576).toFixed(1) + ' MiB');
    return { antes: antes, despues: despues };
  } catch (e) {
    console.error('[compresion] no se pudo comprimir ' + itemId + ': ' + e.message);
    return null;
  } finally {
    try { fs.unlinkSync(entrada); } catch (e) {}
    try { fs.unlinkSync(salida); } catch (e) {}
  }
}

app.post('/api/playlist/add', requireAdmin, async (req, res) => {
  try {
    const screenId = await requirePlaylistScreen(req, res);
    if (!screenId) return;
    const { itemId, originalName } = req.body || {};
    if (!isValidItemId(itemId)) {
      return res.status(400).json({ ok: false, error: 'Identificador de video invalido.' });
    }
    const comprimido = await comprimirVideoSubido(screenId, itemId);
    const pl = simplePlaylists[screenId];
    pl.items.push({
      slot: newItemId(),
      video: itemId,
      name: String(originalName || 'video').slice(0, 200),
      contentType: detectContentType(originalName) || 'video/mp4',
      addedAt: new Date().toISOString(),
    });
    await savePlaylist(screenId);
    res.json({ ok: true, playlist: pl, compresion: comprimido });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Repite un video dentro de la lista sin volver a subir el archivo:
// crea un renglon nuevo, justo despues del original, que apunta al mismo video.
app.post('/api/playlist/duplicate', requireAdmin, async (req, res) => {
  try {
    const screenId = await requirePlaylistScreen(req, res);
    if (!screenId) return;
    const { slot } = req.body || {};
    if (!isValidItemId(slot)) {
      return res.status(400).json({ ok: false, error: 'Identificador de renglon invalido.' });
    }
    const pl = simplePlaylists[screenId];
    const index = pl.items.findIndex((it) => it.slot === slot);
    if (index === -1) {
      return res.status(404).json({ ok: false, error: 'Ese video ya no esta en la lista.' });
    }
    if (pl.items.length >= 60) {
      return res.status(400).json({ ok: false, error: 'La lista llego al limite de 60 renglones.' });
    }
    const original = pl.items[index];
    pl.items.splice(index + 1, 0, {
      slot: newItemId(),
      video: original.video,
      name: original.name,
      contentType: original.contentType,
      addedAt: new Date().toISOString(),
    });
    await savePlaylist(screenId);
    res.json({ ok: true, playlist: pl });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/playlist/remove', requireAdmin, async (req, res) => {
  try {
    const screenId = await requirePlaylistScreen(req, res);
    if (!screenId) return;
    const { slot } = req.body || {};
    if (!isValidItemId(slot)) {
      return res.status(400).json({ ok: false, error: 'Identificador de renglon invalido.' });
    }
    const pl = simplePlaylists[screenId];
    const entry = pl.items.find((it) => it.slot === slot);
    if (!entry) {
      return res.json({ ok: true, playlist: pl });
    }
    pl.items = pl.items.filter((it) => it.slot !== slot);
    await savePlaylist(screenId);
    await deleteOrphanVideo(screenId, entry.video);
    res.json({ ok: true, playlist: pl });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/playlist/reorder', requireAdmin, async (req, res) => {
  try {
    const screenId = await requirePlaylistScreen(req, res);
    if (!screenId) return;
    const order = (req.body && req.body.order) || [];
    if (!Array.isArray(order)) {
      return res.status(400).json({ ok: false, error: 'Orden invalido.' });
    }
    const pl = simplePlaylists[screenId];
    const bySlot = new Map(pl.items.map((it) => [it.slot, it]));
    const next = [];
    for (const slot of order) {
      const it = bySlot.get(String(slot));
      if (it && next.indexOf(it) === -1) next.push(it);
    }
    for (const it of pl.items) {
      if (next.indexOf(it) === -1) next.push(it);
    }
    pl.items = next;
    await savePlaylist(screenId);
    res.json({ ok: true, playlist: pl });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/playlist-item', async (req, res) => {
  const rl = await claveDeListaParaLeer(req.query.screen, req.query.club);
  if (rl.error) {
    res.status(404).json({ ok: false, error: rl.error });
    return;
  }
  const screenId = rl.clave;
  const videoId = String(req.query.id || '');
  if (!screenId || !isValidItemId(videoId)) {
    res.status(400).json({ ok: false, error: 'Video no valido.' });
    return;
  }
  const entry = (((simplePlaylists[screenId] || {}).items) || []).find((it) => it.video === videoId);
  const contentType = (entry && entry.contentType) || 'video/mp4';
  const file = bucket.file(playlistItemObjectName(screenId, videoId));

  // El id de un video es inmutable: cada archivo subido recibe un id nuevo y el
  // contenido de esta URL nunca cambia. Sin estos encabezados el navegador volvia
  // a descargar el video completo en cada vuelta del loop, las 24 horas.
  const etiqueta = '"' + videoId + '"';
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.set('ETag', etiqueta);
  if (req.headers['if-none-match'] === etiqueta) {
    res.status(304).end();
    return;
  }

  let metadata;
  try {
    [metadata] = await file.getMetadata();
  } catch (err) {
    res.status(404).json({ ok: false, error: 'Ese video ya no esta disponible.' });
    return;
  }
  const fileSize = Number(metadata.size) || 0;
  const range = req.headers.range;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', 'bytes');

  const handleStreamError = () => {
    if (!res.headersSent) {
      res.status(404).json({ ok: false, error: 'Ese video ya no esta disponible.' });
    } else {
      res.end();
    }
  };

  if (range && fileSize > 0) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    let start, end;
    if (match && match[1] === '' && match[2] !== '') {
      const suffixLength = parseInt(match[2], 10);
      start = Math.max(fileSize - suffixLength, 0);
      end = fileSize - 1;
    } else {
      start = match && match[1] ? parseInt(match[1], 10) : 0;
      end = match && match[2] ? parseInt(match[2], 10) : fileSize - 1;
    }
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= fileSize) end = fileSize - 1;
    if (start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
      return;
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    const stream = file.createReadStream({ start, end });
    stream.on('error', handleStreamError);
    stream.pipe(res);
  } else {
    const stream = file.createReadStream();
    stream.on('error', handleStreamError);
    stream.pipe(res);
  }
});

// ---------- Configuracion (admin) ----------
app.get('/api/config', requireAdmin, (req, res) => {
  res.json({ ok: true, config });
});

app.post('/api/config', requireAdmin, async (req, res) => {
  const { excelUrl, sheetName, cell, label, slideIntervalSeconds, overrideEnabled, overrideValue, manualOverride } = req.body || {};
  config = {
    excelUrl: typeof excelUrl === 'string' ? excelUrl.trim() : config.excelUrl,
    sheetName: typeof sheetName === 'string' ? sheetName.trim() : config.sheetName,
    cell: typeof cell === 'string' ? cell.trim().toUpperCase() : config.cell,
    label: typeof label === 'string' && label.trim() ? label.trim() : config.label,
    slideIntervalSeconds: Number(slideIntervalSeconds) > 0 ? Number(slideIntervalSeconds) : config.slideIntervalSeconds,
    overrideEnabled: typeof overrideEnabled === 'boolean' ? overrideEnabled : config.overrideEnabled,
    manualOverride: typeof manualOverride === 'boolean' ? manualOverride : config.manualOverride,
    overrideValue:
      overrideValue !== undefined && overrideValue !== null && overrideValue !== ''
        ? Number(overrideValue)
        : config.overrideValue,
    // Un guardado manual desde el panel de administracion siempre limpia la
    // etiqueta de origen del puente automatico (para no mostrar una fuente
    // vieja de Microsoft 365 junto a un numero que el humano acaba de escribir).
    overrideSource: null,
    // El enlace de SharePoint se cambia unicamente desde /api/sharepoint/set-link,
    // asi que este guardado (interval/override) nunca lo debe tocar.
    sharePointShareUrl: config.sharePointShareUrl,
  };
  await saveJSONToGCS(CONFIG_OBJECT, config);
  if (manualOverride === false) {
    await checkPowerBISync();
  }
  const result = await fetchSocios();
  res.json({ ok: true, config, socios: result });
});

// ---------- Puente automatico (tarea programada via Microsoft 365) ----------
// Endpoint dedicado y minimo: solo recibe un conteo ya calculado y lo publica
// como el numero de socios, activando el override. No toca excelUrl/sheetName/
// cell/label/slideIntervalSeconds, asi que no interfiere con esa configuracion.
app.post('/api/socios/push', requireBridge, async (req, res) => {
  const { count, source } = req.body || {};
  const num = Number(count);
  if (!Number.isFinite(num)) {
    return res.status(400).json({ ok: false, error: 'El campo "count" debe ser un numero.' });
  }
  config = {
    ...config,
    overrideEnabled: true,
    overrideValue: num,
    overrideSource: typeof source === 'string' && source.trim()
      ? source.trim()
      : 'Microsoft 365 (automatico)',
  };
  await saveJSONToGCS(CONFIG_OBJECT, config);
  const result = await fetchSocios();
  res.json({ ok: true, config, socios: result });
});

app.get('/api/socios', (req, res) => {
  res.json({
    ...socios,
    blackCardPct: powerbiSync.blackCardPct != null ? powerbiSync.blackCardPct : null,
    clubesAbiertos: powerbiSync.clubesAbiertos != null ? powerbiSync.clubesAbiertos : null,
  });
});

app.post('/api/socios/refresh', requireAdmin, async (req, res) => {
  const result = await fetchSocios();
  res.json(result);
});

// ---------- Logica para leer el numero de socios desde Excel ----------
function extractCount(workbook) {
  const sheetName = config.sheetName && workbook.Sheets[config.sheetName]
    ? config.sheetName
    : workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error('No se encontro la hoja indicada en el Excel.');

  // 1) Si se configuro una celda explicita, usarla directamente.
  if (config.cell) {
    const cellObj = sheet[config.cell];
    if (!cellObj) throw new Error(`La celda ${config.cell} esta vacia.`);
    const num = Number(String(cellObj.v).toString().replace(/[^\d.-]/g, ''));
    if (Number.isNaN(num)) throw new Error(`La celda ${config.cell} no contiene un numero.`);
    return { count: num, sheetName, cellUsed: config.cell };
  }

  // 2) Si no, buscar una celda que contenga la palabra clave (ej. "socios")
  //    y tomar el numero de la celda vecina (derecha o abajo).
  const rangeRef = sheet['!ref'];
  if (!rangeRef) throw new Error('La hoja de Excel esta vacia.');
  const range = XLSX.utils.decode_range(rangeRef);
  const label = (config.label || 'socios').toLowerCase();

  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cellObj = sheet[addr];
      if (!cellObj || typeof cellObj.v !== 'string') continue;
      if (!cellObj.v.toLowerCase().includes(label)) continue;

      const rightAddr = XLSX.utils.encode_cell({ r, c: c + 1 });
      const belowAddr = XLSX.utils.encode_cell({ r: r + 1, c });
      for (const candidateAddr of [rightAddr, belowAddr]) {
        const candidate = sheet[candidateAddr];
        if (!candidate) continue;
        const num = Number(String(candidate.v).toString().replace(/[^\d.-]/g, ''));
        if (!Number.isNaN(num)) {
          return { count: num, sheetName, cellUsed: candidateAddr };
        }
      }
    }
  }

  throw new Error(`No se encontro ninguna celda con la palabra "${config.label}" seguida de un numero.`);
}

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchWithRedirects(url, maxRedirects = 8) {
  let currentUrl = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const response = await fetch(currentUrl, {
      redirect: 'manual',
      headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: '*/*' },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`El servidor del Excel respondio con estado ${response.status} sin indicar a donde redirigir.`);
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return response;
  }
  throw new Error('El enlace del Excel tiene demasiadas redirecciones.');
}

async function fetchSocios() {
  if (config.overrideEnabled) {
    socios = {
      count: Number.isFinite(config.overrideValue) ? config.overrideValue : null,
      updatedAt: new Date().toISOString(),
      source: config.overrideSource || 'Numero manual (override)',
      error: null,
    };
    await saveJSONToGCS(CACHE_OBJECT, socios);
    return socios;
  }
  if (!config.excelUrl) {
    socios = { count: socios.count, updatedAt: socios.updatedAt, source: null, error: 'No se ha configurado el link del Excel (esto no afecta la presentacion ni el tiempo entre diapositivas).' };
    await saveJSONToGCS(CACHE_OBJECT, socios);
    return socios;
  }
  try {
    const response = await fetchWithRedirects(config.excelUrl);
    if (!response.ok) throw new Error(`El servidor del Excel respondio con estado ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    const buffer = Buffer.from(await response.arrayBuffer());

    let workbook;
    try {
      workbook = XLSX.read(buffer, { type: 'buffer' });
    } catch (e) {
      if (contentType.includes('html')) {
        const snippet = buffer.toString('utf8', 0, 200).replace(/\s+/g, ' ').trim();
        throw new Error(`La respuesta fue una pagina HTML, no un archivo Excel (content-type: ${contentType}). Inicio: ${snippet}`);
      }
      workbook = XLSX.read(buffer.toString('utf8'), { type: 'string' });
    }

    const { count, sheetName, cellUsed } = extractCount(workbook);
    socios = {
      count,
      updatedAt: new Date().toISOString(),
      source: `${sheetName}!${cellUsed}`,
      error: null,
    };
  } catch (e) {
    socios = {
      count: socios.count,
      updatedAt: socios.updatedAt,
      source: socios.source,
      error: e.message,
    };
  }
  await saveJSONToGCS(CACHE_OBJECT, socios);
  return socios;
}

// ---------- SharePoint: obtener token, resolver el enlace y sincronizar ----------
let graphTokenCache = { token: null, expiresAt: 0 };

async function getGraphToken() {
  if (graphTokenCache.token && Date.now() < graphTokenCache.expiresAt - 60000) {
    return graphTokenCache.token;
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: MS_CLIENT_ID,
    client_secret: MS_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
  });
  let res;
  try {
    res = await fetch(`https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(GRAPH_FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`No se pudo contactar a Microsoft (login.microsoftonline.com) a tiempo: ${e.message}`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`No se pudo obtener token de Microsoft Graph (estado ${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  graphTokenCache = { token: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3000) * 1000 };
  return graphTokenCache.token;
}

// ---------- Power BI: token propio (mismo app, scope distinto) ----------
let pbiTokenCache = { token: null, expiresAt: 0 };

async function getPowerBIToken() {
  if (pbiTokenCache.token && Date.now() < pbiTokenCache.expiresAt - 60000) {
    return pbiTokenCache.token;
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: MS_CLIENT_ID,
    client_secret: MS_CLIENT_SECRET,
    scope: 'https://analysis.windows.net/powerbi/api/.default',
  });
  const res = await fetch(`https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(GRAPH_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`No se pudo obtener el token de Power BI (estado ${res.status}).`);
  }
  const data = await res.json();
  pbiTokenCache = { token: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3000) * 1000 };
  return pbiTokenCache.token;
}

// Area de trabajo "FPT_WS" y dataset "Contador_Socios". La medida
// "Socios Activos" es la misma que usa el reporte para humanos (confirmada
// contra el valor mostrado en pantalla antes de activar esto).
const POWERBI_GROUP_ID = process.env.POWERBI_GROUP_ID || '';
const POWERBI_DATASET_ID = process.env.POWERBI_DATASET_ID || '';
const POWERBI_DAX_QUERY = process.env.POWERBI_DAX_QUERY || 'EVALUATE ROW("v", [Socios Activos])';

// ---------- Metricas adicionales del ticker (Black Card y clubes abiertos) ----------
// Van en consultas SEPARADAS a proposito: si el nombre de una medida esta mal,
// falla solo esa y el conteo de socios (que ya funciona) no se ve afectado.
const POWERBI_DAX_BC = process.env.POWERBI_DAX_BC || 'EVALUATE ROW("v", [% BC])';
const POWERBI_DAX_CLUBES = process.env.POWERBI_DAX_CLUBES || 'EVALUATE ROW("v", [Clubes Activos])';
// Deja en la bitacora la lista de medidas del modelo para poder corregir los
// nombres de arriba sin adivinar. Se apaga con POWERBI_LISTAR_MEDIDAS=false.
const POWERBI_LISTAR_MEDIDAS = process.env.POWERBI_LISTAR_MEDIDAS !== 'false';

async function ejecutarDax(token, query) {
  const res = await fetch(
    `https://api.powerbi.com/v1.0/myorg/groups/${POWERBI_GROUP_ID}/datasets/${POWERBI_DATASET_ID}/executeQueries`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries: [{ query }], serializerSettings: { includeNulls: true } }),
      signal: AbortSignal.timeout(GRAPH_FETCH_TIMEOUT_MS),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`estado ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const tabla = data && data.results && data.results[0] && data.results[0].tables && data.results[0].tables[0];
  return (tabla && tabla.rows) || [];
}

async function leerMetricaNumerica(token, query, etiqueta) {
  try {
    const filas = await ejecutarDax(token, query);
    const fila = filas[0];
    if (!fila) throw new Error('la consulta no devolvio filas');
    const n = Number(fila[Object.keys(fila)[0]]);
    if (!Number.isFinite(n)) throw new Error('el valor no es numerico');
    return n;
  } catch (e) {
    console.warn(`[powerbi] No se pudo leer ${etiqueta}: ${e.message}`);
    return null;
  }
}

async function listarMedidasEnBitacora(token) {
  for (const consulta of ['EVALUATE INFO.VIEW.MEASURES()', 'EVALUATE INFO.MEASURES()']) {
    try {
      const filas = await ejecutarDax(token, consulta);
      const nombres = filas
        .map((f) => {
          const k = Object.keys(f).find((x) => x.toLowerCase().includes('name'));
          return k ? f[k] : null;
        })
        .filter(Boolean);
      if (nombres.length) {
        console.log(`[powerbi] MEDIDAS DEL MODELO (${nombres.length}): ${nombres.join(' | ')}`);
        return;
      }
    } catch (e) {
      // se intenta la siguiente forma
    }
  }
  console.warn('[powerbi] No se pudo listar las medidas del modelo.');
}

// Power BI puede devolver 0.78 o 78 segun como este definida la medida.
function normalizarPorcentaje(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n > 0 && n <= 1 ? n * 100 : n);
}



// Tiempo maximo de espera por cada llamada a Microsoft Graph. Sin esto, una
// llamada de red que se cuelga (en vez de fallar rapido) puede acumular
// memoria y peticiones concurrentes hasta tumbar el contenedor (Cloud Run
// lo mata por exceso de memoria y el navegador ve un 503 en vez de un error
// claro en JSON).
const GRAPH_FETCH_TIMEOUT_MS = 20000;
// La descarga del archivo puede ser mas pesada (hasta MAX_PPTX_BYTES), asi
// que se le da mas margen que a las llamadas de solo metadatos.
const DOWNLOAD_FETCH_TIMEOUT_MS = Number(process.env.DOWNLOAD_FETCH_TIMEOUT_MS) || 240000; // 4 min: el pptx puede pesar varios cientos de MB

// Codifica un link para compartir de SharePoint/OneDrive al formato que
// espera el endpoint /shares/{id}/driveItem de Microsoft Graph.
function encodeShareUrl(url) {
  const base64 = Buffer.from(url, 'utf8').toString('base64');
  return 'u!' + base64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
}

async function checkSharePointSync(screenIdRaw) {
  const ctx = getScreenCtx(screenIdRaw);
  const nowIso = new Date().toISOString();
  const shareUrl = ctx.getShareUrl();
  let sync = ctx.getSharepointSync();
  if (!shareUrl || !MS_TENANT_ID || !MS_CLIENT_ID || !MS_CLIENT_SECRET) {
    sync = {
      ...sync,
      lastCheckedAt: nowIso,
      error: 'Sincronizacion con SharePoint no configurada (falta el enlace o las variables de entorno).',
    };
    ctx.setSharepointSync(sync);
    return sync;
  }
  try {
    const token = await getGraphToken();
    const encoded = encodeShareUrl(shareUrl);
    let itemRes;
    try {
      itemRes = await fetch(`https://graph.microsoft.com/v1.0/shares/${encoded}/driveItem`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(GRAPH_FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(`No se pudo contactar a Microsoft Graph a tiempo al resolver el enlace: ${e.message}`);
    }
    if (!itemRes.ok) {
      const text = await itemRes.text();
      throw new Error(`Microsoft Graph respondio ${itemRes.status} al resolver el enlace: ${text.slice(0, 300)}`);
    }
    const item = await itemRes.json();
    const remoteModified = item.lastModifiedDateTime || null;

    // Si no cambio desde la ultima revision, solo actualizar la hora de chequeo.
    if (remoteModified && sync.lastModifiedDateTime === remoteModified) {
      sync = { ...sync, lastCheckedAt: nowIso, error: null };
      ctx.setSharepointSync(sync);
      await saveJSONToGCS(ctx.sharepointStateObject, sync);
      return sync;
    }

    if (item.size && item.size > MAX_PPTX_BYTES) {
      throw new Error(`El archivo "${item.name}" pesa mas del limite de ${Math.round(MAX_PPTX_BYTES / 1024 / 1024)} MB.`);
    }
    const contentType = detectContentType(item.name);
    if (!contentType) {
      throw new Error(`El archivo "${item.name}" no es un formato admitido. Usa .pptx, .mp4, .mov, .webm o .m4v.`);
    }

    // Descargar el contenido actualizado (URL directa si Graph la ofrece; si no,
    // se pide el contenido autenticado con el mismo token).
    let fileBuffer;
    const downloadUrl = item['@microsoft.graph.downloadUrl'];
    try {
      if (downloadUrl) {
        const fileRes = await fetch(downloadUrl, { signal: AbortSignal.timeout(DOWNLOAD_FETCH_TIMEOUT_MS) });
        if (!fileRes.ok) throw new Error(`No se pudo descargar el archivo (estado ${fileRes.status}).`);
        fileBuffer = Buffer.from(await fileRes.arrayBuffer());
      } else {
        const driveId = item.parentReference && item.parentReference.driveId;
        const contentRes = await fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${item.id}/content`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(DOWNLOAD_FETCH_TIMEOUT_MS),
        });
        if (!contentRes.ok) throw new Error(`No se pudo descargar el archivo (estado ${contentRes.status}).`);
        fileBuffer = Buffer.from(await contentRes.arrayBuffer());
      }
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        throw new Error('La descarga del archivo desde SharePoint tardo demasiado y se cancelo.');
      }
      throw e;
    }

    await bucket.file(ctx.contentObject).save(fileBuffer, {
      contentType,
      resumable: false,
    });

    const status = {
      hasPresentation: true,
      contentType,
      originalName: item.name || 'Pantalla Corpo FPT.pptx',
      uploadedAt: nowIso,
    };
    ctx.setStatus(status);
    await saveJSONToGCS(ctx.statusObject, status);

    sync = {
      lastModifiedDateTime: remoteModified,
      lastCheckedAt: nowIso,
      lastSyncedAt: nowIso,
      sourceName: item.name || null,
      error: null,
    };
    ctx.setSharepointSync(sync);
    await saveJSONToGCS(ctx.sharepointStateObject, sync);
    console.log(`SharePoint (pantalla ${ctx.screenId}): nueva version de "${item.name}" sincronizada (${nowIso}).`);
  } catch (e) {
    console.error(`Error sincronizando con SharePoint (pantalla ${ctx.screenId}):`, e.message);
    sync = { ...sync, lastCheckedAt: nowIso, error: e.message };
    ctx.setSharepointSync(sync);
    await saveJSONToGCS(ctx.sharepointStateObject, sync);
  }
  return sync;
}

// Estado publico (sin secretos) para mostrar en el panel de administracion.
// Consulta la medida "Socios Activos" en Power BI y, si tiene exito, activa
// el override igual que /api/socios/push (no toca excelUrl ni las demas
// opciones de la presentacion).
async function checkPowerBISync() {
  const nowIso = new Date().toISOString();
  if (config.manualOverride) {
    powerbiSync = { ...powerbiSync, lastCheckedAt: nowIso, error: null, skippedReason: 'manual_override_active' };
    await saveJSONToGCS(POWERBI_STATE_OBJECT, powerbiSync);
    return powerbiSync;
  }
  if (!MS_TENANT_ID || !MS_CLIENT_ID || !MS_CLIENT_SECRET) {
    powerbiSync = { ...powerbiSync, lastCheckedAt: nowIso, error: 'Faltan MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET.' };
    await saveJSONToGCS(POWERBI_STATE_OBJECT, powerbiSync);
    return powerbiSync;
  }
  try {
    const token = await getPowerBIToken();
    const res = await fetch(
      `https://api.powerbi.com/v1.0/myorg/groups/${POWERBI_GROUP_ID}/datasets/${POWERBI_DATASET_ID}/executeQueries`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ queries: [{ query: POWERBI_DAX_QUERY }], serializerSettings: { includeNulls: true } }),
        signal: AbortSignal.timeout(GRAPH_FETCH_TIMEOUT_MS),
      }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Power BI respondio con estado ${res.status}. ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    const row = data && data.results && data.results[0] && data.results[0].tables &&
      data.results[0].tables[0] && data.results[0].tables[0].rows && data.results[0].tables[0].rows[0];
    const rawValue = row ? row[Object.keys(row)[0]] : undefined;
    const num = Number(rawValue);
    if (!Number.isFinite(num)) {
      throw new Error('La consulta a Power BI no devolvio un numero valido.');
    }
    config = {
      ...config,
      overrideEnabled: true,
      overrideValue: num,
      overrideSource: 'Power BI (automatico)',
    };
    await saveJSONToGCS(CONFIG_OBJECT, config);
    await fetchSocios();
    let bcPct = (powerbiSync && powerbiSync.blackCardPct != null) ? powerbiSync.blackCardPct : null;
    let clubes = (powerbiSync && powerbiSync.clubesAbiertos != null) ? powerbiSync.clubesAbiertos : null;
    try {
      if (POWERBI_LISTAR_MEDIDAS) await listarMedidasEnBitacora(token);
      const bcCrudo = await leerMetricaNumerica(token, POWERBI_DAX_BC, 'porcentaje de Black Card');
      const clubesCrudo = await leerMetricaNumerica(token, POWERBI_DAX_CLUBES, 'clubes abiertos');
      if (bcCrudo !== null) bcPct = normalizarPorcentaje(bcCrudo);
      if (clubesCrudo !== null) clubes = Math.round(clubesCrudo);
      console.log(`[powerbi] socios=${num} blackCardPct=${bcPct} clubesAbiertos=${clubes}`);
    } catch (e) {
      console.warn(`[powerbi] Metricas adicionales no disponibles: ${e.message}`);
    }
    powerbiSync = { lastValue: num, blackCardPct: bcPct, clubesAbiertos: clubes, lastCheckedAt: nowIso, lastSyncedAt: nowIso, error: null, skippedReason: null };
  } catch (e) {
    powerbiSync = { ...powerbiSync, lastCheckedAt: nowIso, error: e.message || String(e), skippedReason: null };
  }
  await saveJSONToGCS(POWERBI_STATE_OBJECT, powerbiSync);
  return powerbiSync;
}

// Se ejecuta una vez al dia (no cada 15 min, para no saturar la API de
// Power BI). Hora por defecto: 9:30 am tiempo de Ciudad de Mexico
// (UTC-6 todo el ano; Mexico ya no usa horario de verano nacionalmente).
const POWERBI_POLL_HOUR_UTC = Number(process.env.POWERBI_POLL_HOUR_UTC ?? 15);
const POWERBI_POLL_MINUTE_UTC = Number(process.env.POWERBI_POLL_MINUTE_UTC ?? 30);

function msUntilNextPowerBIRun() {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    POWERBI_POLL_HOUR_UTC, POWERBI_POLL_MINUTE_UTC, 0, 0
  ));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function schedulePowerBISync() {
  setTimeout(async () => {
    try {
      await checkPowerBISync();
    } catch (e) {
      console.error('Error en checkPowerBISync programado:', e);
    }
    schedulePowerBISync();
  }, msUntilNextPowerBIRun());
}

// ---------- Directorio de clubes ----------
// Publico: el menu de tv.fpt.com.mx lo necesita para armar region > club >
// pantalla. Son los mismos datos del directorio publico de la empresa.
app.get('/api/clubes', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    actualizado: clubes.actualizado || null,
    plantilla: clubes.plantilla || PLANTILLA_POR_DEFECTO,
    pantallasPorClub: CLUB_SCREEN_IDS.length,
    clubes: ((clubes.clubes) || []).map((c) => ({
      codigo: c.codigo,
      nombre: c.nombre,
      region: c.region,
      ciudad: c.ciudad || '',
      estado: c.estado || '',
      estatus: c.estatus || 'Abierto',
    })),
  });
});

app.post('/api/clubes', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const codigo = String(b.codigo || '').trim().toLowerCase();
    const nombre = String(b.nombre || '').trim();
    const region = String(b.region || '').trim();
    if (!esCodigoClub(codigo)) {
      return res.status(400).json({ ok: false, error: 'El codigo solo admite minusculas, numeros y guiones (2 a 40 caracteres).' });
    }
    if (!nombre) return res.status(400).json({ ok: false, error: 'Escribe el nombre del club.' });
    if (!region) return res.status(400).json({ ok: false, error: 'Escribe la region del club.' });
    if (clubesPorCodigo.has(codigo)) {
      return res.status(409).json({ ok: false, error: 'Ya existe un club con el codigo "' + codigo + '".' });
    }
    const nuevo = {
      codigo: codigo,
      nombre: nombre.slice(0, 120),
      region: region.slice(0, 60),
      ciudad: String(b.ciudad || '').trim().slice(0, 80),
      estado: String(b.estado || '').trim().slice(0, 80),
      estatus: String(b.estatus || 'Abierto').trim().slice(0, 20),
    };
    clubes.clubes = ((clubes.clubes) || []).concat([nuevo]);
    clubes.actualizado = new Date().toISOString().slice(0, 10);
    reindexarClubes();
    await saveJSONToGCS(CLUBES_OBJECT, clubes);
    res.json({ ok: true, club: nuevo, total: clubes.clubes.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Cambia a que pantalla global le copia cada pantalla de club mientras no
// tenga contenido propio. No mueve ni borra ningun archivo.
app.post('/api/clubes/plantilla', requireAdmin, async (req, res) => {
  try {
    const entrada = (req.body && req.body.plantilla) || {};
    const nueva = {};
    for (const n of CLUB_SCREEN_IDS) {
      const destino = String(entrada[n] || (clubes.plantilla || {})[n] || PLANTILLA_POR_DEFECTO[n]);
      if (SIMPLE_SCREEN_IDS.indexOf(destino) === -1) {
        return res.status(400).json({ ok: false, error: 'La pantalla ' + n + ' solo puede copiar de una pantalla global 3 a 10.' });
      }
      nueva[n] = destino;
    }
    clubes.plantilla = nueva;
    await saveJSONToGCS(CLUBES_OBJECT, clubes);
    res.json({ ok: true, plantilla: nueva });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/powerbi-status', (req, res) => {
  res.json({
    ...powerbiSync,
    configured: Boolean(MS_TENANT_ID && MS_CLIENT_ID && MS_CLIENT_SECRET && POWERBI_GROUP_ID && POWERBI_DATASET_ID),
  });
});

app.post('/api/powerbi/sync-now', requireAdmin, async (req, res) => {
  const result = await checkPowerBISync();
  if (result.skippedReason === 'manual_override_active') {
    return res.json({
      ok: false,
      error: 'Tienes activado "Usar numero manual". Desactivalo y guarda para poder sincronizar con Power BI.',
      powerbiSync: result,
    });
  }
  res.json({ ok: !result.error, powerbiSync: result, socios });
});

app.get('/api/sharepoint-status', (req, res) => {
  if (req.query.club) {
    return res.status(400).json({ ok: false, error: 'Las pantallas de club no usan SharePoint.', configured: false });
  }
  const ctx = getScreenCtx(req.query.screen);
  res.json({
    ...ctx.getSharepointSync(),
    configured: Boolean(ctx.getShareUrl() && MS_TENANT_ID && MS_CLIENT_ID && MS_CLIENT_SECRET),
    slideIntervalSeconds: ctx.getSlideIntervalSeconds(),
    showSociosTicker: ctx.getShowSociosTicker(),
  });
});

app.post('/api/sharepoint/sync-now', requireAdmin, async (req, res) => {
  if ((req.body && req.body.club) || req.query.club) {
    return res.status(400).json({ ok: false, error: 'Las pantallas de club no usan SharePoint.' });
  }
  const screenId = normalizeScreenId((req.body && req.body.screen) || req.query.screen);
  const result = await checkSharePointSync(screenId);
  res.json({ ok: !result.error, sharepoint: result });
});

// Cambia el enlace de SharePoint/OneDrive a sincronizar (para apuntar a otra
// presentacion) sin necesidad de redesplegar el servicio. El enlace debe
// crearse con acceso "Cualquier persona con el vinculo" para que el bridge
// (autenticacion de aplicacion, sin usuario) pueda resolverlo.
app.post('/api/sharepoint/set-link', requireAdmin, async (req, res) => {
  const { shareUrl, slideIntervalSeconds, showSociosTicker } = req.body || {};
  if (req.body && req.body.club) {
    return res.status(400).json({ ok: false, error: 'Las pantallas de club no usan SharePoint.' });
  }
  const screenId = normalizeScreenId(req.body && req.body.screen);
  const ctx = getScreenCtx(screenId);
  const hasShareUrl = typeof shareUrl === 'string' && shareUrl.trim().length > 0;
  const onlyTogglingTicker = !hasShareUrl && typeof showSociosTicker === 'boolean';
  if (!hasShareUrl && !onlyTogglingTicker) {
    return res.status(400).json({ ok: false, error: 'Escribe un enlace valido.' });
  }
  if (hasShareUrl) {
    const trimmed = shareUrl.trim();
    if (!/^https:\/\//i.test(trimmed)) {
      return res.status(400).json({ ok: false, error: 'El enlace debe comenzar con https://' });
    }
    ctx.setShareUrl(trimmed);
  }
  if (Number(slideIntervalSeconds) > 0) {
    ctx.setSlideIntervalSeconds(Number(slideIntervalSeconds));
  }
  if (typeof showSociosTicker === 'boolean') {
    ctx.setShowSociosTicker(showSociosTicker);
  }
  await ctx.saveScreenConfig();
  if (!hasShareUrl) {
    // Solo se actualizo el contador de socios; no hay enlace que sincronizar.
    return res.json({ ok: true, sharepoint: ctx.getSharepointSync() });
  }
  // Forzar que la proxima revision descargue de inmediato (no solo cuando "cambie").
  ctx.setSharepointSync({ ...ctx.getSharepointSync(), lastModifiedDateTime: null });
  const result = await checkSharePointSync(screenId);
  res.json({ ok: !result.error, sharepoint: result });
});

async function start() {
  // Cargar estado guardado en Cloud Storage (si existe) antes de aceptar trafico.
  config = await loadJSONFromGCS(CONFIG_OBJECT, config);
  socios = await loadJSONFromGCS(CACHE_OBJECT, socios);
  presentationStatus = await loadJSONFromGCS(STATUS_OBJECT, presentationStatus);
  sharepointSync = await loadJSONFromGCS(SHAREPOINT_STATE_OBJECT, sharepointSync);
  powerbiSync = await loadJSONFromGCS(POWERBI_STATE_OBJECT, powerbiSync);
  screenConfig2 = await loadJSONFromGCS(SCREEN2_CONFIG_OBJECT, screenConfig2);
  presentationStatus2 = await loadJSONFromGCS(SCREEN2_STATUS_OBJECT, presentationStatus2);
  sharepointSync2 = await loadJSONFromGCS(SCREEN2_SHAREPOINT_STATE_OBJECT, sharepointSync2);
  for (const id of SIMPLE_SCREEN_IDS) {
    simpleScreenState[id].status = await loadJSONFromGCS(SIMPLE_SCREEN_OBJECTS[id].status, simpleScreenState[id].status);
    const loadedPlaylist = await loadJSONFromGCS(playlistObjectName(id), null);
    if (loadedPlaylist && Array.isArray(loadedPlaylist.items)) {
      const necesitaMigrar = loadedPlaylist.items.some((it) => !it || !it.slot || !it.video);
      simplePlaylists[id] = { items: normalizePlaylistItems(loadedPlaylist.items), updatedAt: loadedPlaylist.updatedAt || null };
      if (necesitaMigrar && simplePlaylists[id].items.length) {
        try {
          await savePlaylist(id);
          console.log(`Lista de la pantalla ${id} migrada al formato nuevo.`);
        } catch (e) {
          console.error(`No se pudo migrar la lista de la pantalla ${id}:`, e.message);
        }
      }
    }
  }

  // Directorio de clubes. La primera vez se siembra con el listado oficial que
  // viaja en el repositorio; despues manda siempre lo que hay en el bucket.
  try {
    const guardado = await loadJSONFromGCS(CLUBES_OBJECT, null);
    if (guardado && Array.isArray(guardado.clubes)) {
      clubes = {
        actualizado: guardado.actualizado || null,
        plantilla: Object.assign({}, PLANTILLA_POR_DEFECTO, guardado.plantilla || {}),
        clubes: guardado.clubes,
      };
    } else {
      const semilla = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'clubes-semilla.json'), 'utf8'));
      clubes = {
        actualizado: semilla.actualizado || null,
        plantilla: Object.assign({}, PLANTILLA_POR_DEFECTO, semilla.plantilla || {}),
        clubes: semilla.clubes || [],
      };
      await saveJSONToGCS(CLUBES_OBJECT, clubes);
      console.log('Directorio de clubes sembrado con ' + clubes.clubes.length + ' clubes.');
    }
  } catch (e) {
    console.error('No se pudo cargar el directorio de clubes: ' + e.message);
  }
  reindexarClubes();

  // Un enlace guardado desde el panel de administracion (mas reciente) gana
  // sobre la variable de entorno con la que arranco el contenedor.
  if (config.sharePointShareUrl && config.sharePointShareUrl.trim()) {
    sharePointShareUrl = config.sharePointShareUrl.trim();
  }
  if (screenConfig2.sharePointShareUrl && screenConfig2.sharePointShareUrl.trim()) {
    sharePointShareUrl2 = screenConfig2.sharePointShareUrl.trim();
  }

  // Si no hay registro de status pero si existe el archivo en el bucket, reflejarlo.
  if (!presentationStatus.hasPresentation) {
    try {
      const [exists] = await bucket.file(PPTX_OBJECT).exists();
      if (exists) presentationStatus = { ...presentationStatus, hasPresentation: true };
    } catch (e) {
      // Ignorar: no es critico.
    }
  }
  if (!presentationStatus2.hasPresentation) {
    try {
      const [exists2] = await bucket.file(SCREEN2_CONTENT_OBJECT).exists();
      if (exists2) presentationStatus2 = { ...presentationStatus2, hasPresentation: true };
    } catch (e) {
      // Ignorar: no es critico.
    }
  }
  for (const id of SIMPLE_SCREEN_IDS) {
    if (!simpleScreenState[id].status.hasPresentation) {
      try {
        const [existsN] = await bucket.file(SIMPLE_SCREEN_OBJECTS[id].content).exists();
        if (existsN) simpleScreenState[id].status = { ...simpleScreenState[id].status, hasPresentation: true };
      } catch (e) {
        // Ignorar: no es critico.
      }
    }
  }

  fetchSocios();
  setInterval(fetchSocios, FETCH_INTERVAL_MS);

  checkSharePointSync('1');
  setInterval(() => checkSharePointSync('1'), SHAREPOINT_POLL_MS);
  checkSharePointSync('2');
  setInterval(() => checkSharePointSync('2'), SHAREPOINT_POLL_MS);

  checkPowerBISync();
  schedulePowerBISync();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor listo en el puerto ${PORT}`);
    console.log(`  - Panel para subir presentacion/video: /upload.html (agrega ?screen=2 para la pantalla 2)`);
    console.log(`  - Panel de administracion:              /admin.html`);
    console.log(`  - Pantalla 1 para la Smart TV:           /display.html`);
    console.log(`  - Pantalla 2 para la Smart TV:           /display.html?screen=2`);
    console.log(`  - Pantalla 3 para la Smart TV:              /display.html?screen=3`);
    console.log(`  - Pantalla 4 para la Smart TV:              /display.html?screen=4`);
    console.log(`  - Pantalla 5 para la Smart TV:              /display.html?screen=5`);
    console.log(`  - Pantalla 6 para la Smart TV:              /display.html?screen=6`);
    console.log(`  - Pantalla 7 para la Smart TV:              /display.html?screen=7`);
    console.log(`  - Pantalla 8 para la Smart TV:              /display.html?screen=8`);
    console.log(`  - Pantalla 9 para la Smart TV:              /display.html?screen=9`);
    console.log(`  - Pantalla 10 para la Smart TV:              /display.html?screen=10`);
    console.log(`  - Clubes registrados: ${clubes.clubes.length}. Pantalla de club: /display.html?club=<codigo>&screen=1..4`);
    console.log(`  - Sincronizacion SharePoint cada ${Math.round(SHAREPOINT_POLL_MS / 60000)} minuto(s) (ambas pantallas).`);
    console.log(`  - Power BI: sincronizacion diaria a las ${POWERBI_POLL_HOUR_UTC}:${String(POWERBI_POLL_MINUTE_UTC).padStart(2, '0')} UTC.`);
  });
}

start().catch((e) => {
  console.error('No se pudo iniciar el servidor:', e);
  process.exit(1);
});
