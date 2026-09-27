# Socios Slideshow — Señalización digital para Fitness Para Todos

Plataforma de señalización digital que alimenta las Smart TV de los clubes de
Fitness Para Todos. Corre en Google Cloud Run y sirve presentaciones y video a
televisores Samsung Tizen distribuidos en los clubes.

- **Producción:** https://tv.fpt.com.mx
- **Servicio Cloud Run:** `socios-slideshow` (proyecto `socios-slideshow`, región `us-central1`)
- **Almacenamiento:** `gs://socios-slideshow-storage`

---

## Qué hace

Cada televisor abre una URL con un número de pantalla y se queda ahí para
siempre. El servidor le dice qué reproducir; la página se encarga de refrescarse
sola cuando hay contenido nuevo o cuando se despliega una versión nueva del
código.

| Pantalla | Nombre | Tipo de contenido |
|---:|---|---|
| 1 | Oficina | Presentación `.pptx` (sincronizada desde SharePoint) |
| 2 | Recepción | Video único + ticker de socios |
| 3 | Vestidores | Playlist de videos |
| 4 | 30 Minutos | Playlist de videos |
| 5 | Entrenamiento Funcional | Playlist de videos |
| 6 | Mostrador | Playlist de videos |
| 7 | Zona Black | Playlist de videos |
| 8 | Zona Cardio | Playlist de videos |

Las pantallas 1 y 2 muestran además un **ticker** con métricas en vivo que se
leen de Power BI: socios activos, porcentaje de Black Card y clubes abiertos.

---

## Cómo se usa

### Subir contenido

Marketing entra a `https://tv.fpt.com.mx/upload.html?screen=N`, escribe la clave
de administrador y arrastra el archivo.

- Pantallas 1 y 2: un solo archivo (`.pptx` o video).
- Pantallas 3 a 8: varios videos que forman una playlist reproducida en bucle.

La página muestra una barra de progreso real durante la subida y un indicador
mientras el servidor optimiza el video. **El video se comprime automáticamente en
el servidor** antes de guardarse (ver [Compresión](docs/ARQUITECTURA.md#compresión-automática-de-video)).

### Desplegar

```bash
cd ~/app
gcloud run deploy socios-slideshow \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --timeout=600 \
  --quiet
```

Las pantallas detectan la revisión nueva y se recargan solas dentro de los
5 minutos siguientes, al terminar el video que estén reproduciendo. No hay que
tocar los televisores.

---

## Documentación

| Documento | Contenido |
|---|---|
| [ARQUITECTURA.md](docs/ARQUITECTURA.md) | Cómo está construido: endpoints, almacenamiento, caché en dispositivo, compresión |
| [OPERACION.md](docs/OPERACION.md) | Tareas del día a día: desplegar, subir contenido, refrescar pantallas, revisar costos |
| [RUNBOOK.md](docs/RUNBOOK.md) | Qué hacer cuando algo falla |
| [HISTORIAL.md](docs/HISTORIAL.md) | Por qué el sistema es como es: el problema de egress y cómo se resolvió |
| [COSTOS.md](docs/COSTOS.md) | Modelo de costo, mediciones reales y proyección a 50 clubes |

---

## Estructura del proyecto

```
.
├── server.js           # Servidor Express: API, sincronización SharePoint, Power BI, compresión
├── Dockerfile          # node:20-slim + ffmpeg
├── package.json
├── public/
│   ├── display.html    # Lo que ve el televisor
│   └── upload.html     # Panel de carga para marketing
└── docs/
```

---

## Configuración

Todo lo sensible vive en variables de entorno del servicio de Cloud Run. **No hay
credenciales en este repositorio.**

| Variable | Para qué sirve |
|---|---|
| `ADMIN_TOKEN` | Clave que protege la carga de contenido y los cambios de configuración |
| `POWERBI_*` | Credenciales y consultas DAX para el ticker de socios |
| `K_REVISION` | La inyecta Cloud Run; es la base del mecanismo de auto-actualización |

El enlace de SharePoint y el estado de cada pantalla se guardan en Cloud Storage,
no en el código.

---

## Requisitos del contenedor

`ffmpeg` y `ffprobe` se instalan en la imagen porque el servidor comprime y
valida video en cada subida. Si se cambia la imagen base hay que mantenerlos.
