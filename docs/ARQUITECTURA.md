# Arquitectura

## Panorama

```
Samsung Tizen (club)  ──HTTP──▶  Cloud Run: socios-slideshow  ──▶  Cloud Storage
       │                                │
       │                                ├──▶  Microsoft Graph (SharePoint)
       │                                └──▶  Power BI REST API
       │
       └── display.html: guarda los videos en memoria del televisor (blob)
```

Un solo servicio de Cloud Run sirve la API, los archivos estáticos y el video.
No hay base de datos: el estado vive como objetos JSON en Cloud Storage.

---

## El televisor

Cada pantalla abre `https://tv.fpt.com.mx/?screen=N` y no se vuelve a tocar.
`display.html` hace cuatro cosas en bucle:

1. **Consulta qué reproducir.** Pantallas 1 y 2 piden `/api/status`; pantallas
   3 a 8 piden `/api/playlist`.
2. **Precarga los videos a memoria** (ver abajo).
3. **Reproduce**, en bucle si es un solo video, o en secuencia si es playlist.
4. **Revisa si hay versión nueva** del servidor cada 5 minutos y se recarga sola
   cuando termina el video en curso.

### Caché en el dispositivo

Este es el mecanismo más importante del sistema y la razón por la que el costo
es viable.

**El problema:** las Samsung Tizen ignoran las cabeceras HTTP de caché para
video. Se midió: de 483 peticiones de video, 483 fueron `206 Partial Content` y
cero fueron `304 Not Modified`. El televisor vuelve a descargar el video entero
en cada vuelta del bucle, para siempre.

**La solución:** en lugar de confiar en el caché del navegador, `display.html`
descarga cada video una sola vez con `fetch`, lo convierte en `Blob`, y
reproduce desde una URL de objeto local:

```js
const r = await fetch(urlDirectaItem(it), { cache: 'no-store' });
const b = await r.blob();
cacheBlobs[it.video] = URL.createObjectURL(b);
```

El `<video>` reproduce desde `blob:` y ya no toca la red nunca más.

**Límites de memoria.** Un televisor no tiene RAM infinita, así que la caché
tiene dos topes:

| Constante | Valor | Qué controla |
|---|---|---|
| `LIMITE_BLOB` | 60 MB | Video individual más grande que se guarda |
| `LIMITE_TOTAL` | 150 MB | Suma de todo lo que puede vivir en memoria |

Si un video no cabe, **no falla**: simplemente se reproduce desde la red, como
antes. La degradación es silenciosa y segura.

Cuando un video sale de la playlist, su blob se libera con `URL.revokeObjectURL`
y se descuenta del total.

**Resultado medido:** cero descargas de video en 30 minutos con los televisores
encendidos y reproduciendo.

### Auto-actualización

Antes, cambiar el código no cambiaba nada en las pantallas: la página llevaba
días o semanas cargada y seguía ejecutando el JavaScript viejo. Había que ir
físicamente a cada televisor.

Ahora el servidor expone su revisión:

```js
const APP_VERSION = process.env.K_REVISION || ('local-' + Date.now());
app.get('/api/version', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ version: APP_VERSION });
});
```

`display.html` la consulta cada 5 minutos. Si cambió, marca una recarga
**pendiente** y espera: la recarga ocurre al terminar el video en curso, no a
media reproducción. Así nadie ve un corte.

---

## El servidor

`server.js`, un Express sin dependencias exóticas.

### Endpoints principales

| Ruta | Método | Para qué |
|---|---|---|
| `/api/status` | GET | Qué contenido tiene la pantalla 1 o 2 |
| `/api/current-pptx` | GET | Sirve el archivo de la pantalla 1 o 2 (soporta `Range`) |
| `/api/version` | GET | Revisión de Cloud Run, para la auto-actualización |
| `/api/display-config` | GET | Intervalo de diapositivas y si muestra el ticker |
| `/api/socios` | GET | Métricas de Power BI para el ticker |
| `/api/upload-url` | POST | URL firmada para subir a pantalla 1 o 2 |
| `/api/upload-complete` | POST | Confirma la subida y comprime (solo pantalla 2) |
| `/api/playlist` | GET | Lista de videos de una pantalla 3–8 |
| `/api/playlist/upload-url` | POST | URL firmada para subir un video de playlist |
| `/api/playlist/add` | POST | Agrega el video a la lista y lo comprime |
| `/api/playlist-item` | GET | Sirve un video de playlist (soporta `Range`) |
| `/api/sharepoint/*` | varios | Estado y sincronización manual de SharePoint |

Todo lo que escribe exige la cabecera `x-admin-token`.

### Subida de archivos

El archivo **no pasa por el servidor**. El navegador pide una URL firmada, sube
directo a Cloud Storage, y después avisa al servidor. Esto evita el límite de
tamaño de petición de Cloud Run y mantiene el servicio ligero.

```
navegador ──1── /api/upload-url ──▶ servidor (firma)
navegador ──2── PUT directo ──────▶ Cloud Storage
navegador ──3── /api/…add ────────▶ servidor (registra y comprime)
```

### Compresión automática de video

Marketing entrega videos pesados. Un video de 40 MB reproducido en bucle en seis
pantallas por club, en cincuenta clubes, es lo que hizo explotar la factura.
Ahora el servidor los comprime al momento de subirlos.

**Preajuste** (`server.js`):

```
ffmpeg -nostdin -y -loglevel error -i ENTRADA -an \
  -c:v libx264 -preset veryfast -crf 25 \
  -maxrate 2000k -bufsize 4000k \
  -pix_fmt yuv420p -movflags +faststart SALIDA
```

Decisiones detrás del preajuste:

- **`-an` (sin audio).** Los televisores están en silencio. El audio era peso
  puro.
- **`-crf 25`.** Calidad visualmente indistinguible a distancia de
  señalización; `-crf 18` casi no comprime, `-crf 30` se nota.
- **`-movflags +faststart`.** Mueve el índice al principio del archivo para que
  el video empiece a reproducirse sin descargarlo entero.
- **`-preset veryfast`.** Cloud Run cobra por tiempo de CPU. Presets más lentos
  comprimen algo más pero cuestan más de lo que ahorran.

**Salvaguardas.** Comprimir en automático es riesgoso: un encode truncado que
pesa menos "parece" un éxito. Por eso hay tres verificaciones:

1. `ffprobe` confirma que el archivo de entrada **tiene stream de video**. Así
   el `.pptx` de la pantalla 1 se salta por regla explícita, no porque ffmpeg
   falle por accidente.
2. Si el resultado no es más chico que el original, se descarta.
3. `ffprobe` confirma que el resultado **sigue siendo video válido** antes de
   subirlo.

Si cualquiera falla, el archivo original se queda como está. Nunca se sube algo
roto.

**Límites:**

| Constante | Valor | Razón |
|---|---|---|
| `COMP_MIN_ENTRADA` | 2 MB | Debajo de eso no vale la pena |
| `COMP_MAX_ENTRADA` | 300 MB | Arriba de eso no cabe cómodo en el `/tmp` del contenedor |

`/tmp` en Cloud Run es **tmpfs, o sea RAM**, y cuenta contra el límite de
memoria del servicio (8 GiB). Por eso el tope de entrada.

**Alcance:** se comprime en las pantallas 2 a 8. La pantalla 1 está excluida por
regla porque su contenido es una presentación, no video.

### Ticker de socios (Power BI)

El servidor consulta el dataset de Power BI vía la API REST con consultas DAX
configuradas por variable de entorno:

| Variable | Medida |
|---|---|
| `POWERBI_DAX` | `[Socios Activos]` |
| `POWERBI_DAX_BC` | `[Porc_BC]` |
| `POWERBI_DAX_CLUBES` | `[Clubes Activos]` |

Los nombres de las medidas se toman tal cual existen en el modelo. Hay un
endpoint de diagnóstico que lista las medidas disponibles en la bitácora, útil
cuando una consulta falla por nombre equivocado.

El texto del ticker se arma en `display.html`:

```
👥 Socios activos: 316,214 — Black Card: 74% — Clubes abiertos: 50 — Fitness Para Todos
```

### Sincronización con SharePoint

Las pantallas 1 y 2 pueden tomar su contenido de un enlace de SharePoint. El
servidor revisa cada 15 minutos si el archivo cambió y lo baja.

SharePoint funciona bien como **origen** de contenido, pero no como vía de
entrega a los televisores: los enlaces expiran, Microsoft limita el ancho de
banda, y no resolvería el problema de la redescarga. Por eso el contenido se
copia a Cloud Storage y se sirve desde ahí.

---

## Almacenamiento

```
gs://socios-slideshow-storage/
├── uploads/current.pptx              # Pantalla 1
├── uploads/screen-2/current-content  # Pantalla 2
├── playlists/<pantalla>/<id>         # Videos de las playlists
├── data/screen-N/status.json         # Qué tiene cargado cada pantalla
├── data/screen-N/config.json         # Configuración por pantalla
└── backup-original/                  # Originales antes de comprimir
```

No hay base de datos. El estado es JSON en Cloud Storage, leído y escrito por el
servidor.

---

## Decisiones que vale la pena conocer

**Por qué sigue en Google Cloud.** Se evaluó mover el video a Cloudflare R2
(egress gratis). Se descartó por dos razones concretas: usar R2 en producción
exige un dominio propio, lo que significaba mover el DNS de `fpt.com.mx` —que
lleva el correo de la empresa— a Cloudflare; y Cloudflare prohíbe servir video
por su CDN en los planes Free, Pro y Business, con casos documentados de
aplicación de esa regla contra R2. Además, el almacenamiento nunca fue el costo:
el costo era el egress, y el egress lo causaba la redescarga. Arreglado eso, la
migración dejó de tener sentido.

**Por qué no se usa caché HTTP para el video.** Se intentó. Se implementó
`Cache-Control: immutable` y `ETag`, se verificó con `curl` que el servidor
respondía `304`, y aun así el consumo no bajó ni un byte. El análisis de la
bitácora mostró que las Tizen nunca mandan `If-None-Match` para video. La caché
HTTP no es una herramienta disponible en este hardware.

**Por qué la barra de progreso de compresión no avanza.** Durante la subida del
archivo hay porcentaje real, porque `XMLHttpRequest` reporta avance. Durante la
compresión en el servidor **no existe ninguna señal de progreso**, así que la
barra se vuelve indeterminada en lugar de inventar un porcentaje. Una barra que
llega al 100 % y se queda ahí desespera más que no tener barra.
