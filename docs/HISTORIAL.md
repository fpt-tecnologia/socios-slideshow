# Historial — por qué el sistema es como es

Este documento existe para que quien herede el proyecto entienda las decisiones
sin tener que redescubrirlas. Incluye lo que salió mal, no solo lo que salió
bien.

---

## El problema del egress

### Cómo se veía

La plataforma funcionaba. El contenido se veía en las pantallas. Y la factura de
Google Cloud crecía a un ritmo que habría hecho imposible sostener el proyecto:

| Medición | Valor |
|---|---|
| Egress diario | **626 GiB** |
| Proyección mensual | **~1,821 USD** |
| Proyección a 50 clubes × 6 pantallas | **~2,285 USD/mes** |

El almacenamiento no era el problema. El problema era **salida de red**.

### El primer diagnóstico, que fue el equivocado

La hipótesis inicial fue la obvia: faltaban cabeceras de caché. Se implementaron:

```js
res.set('Cache-Control', 'public, max-age=31536000, immutable');
res.set('ETag', '"' + videoId + '"');
if (req.headers['if-none-match'] === etiqueta) { res.status(304).end(); return; }
```

Se verificó con `curl` que el servidor efectivamente respondía `304 Not
Modified`. La corrección se dio por buena.

**No funcionó.** El egress siguió plano en ~26 GiB por hora, antes y después.

Este fue un error de método: se verificó que *el servidor hacía lo correcto*, no
que *el problema se había resuelto*. Desde entonces la regla es medir el
resultado, nunca proyectarlo.

### El diagnóstico real

El análisis de la bitácora fue concluyente:

- **483 de 483** peticiones de video devolvieron `206 Partial Content`.
- **Cero** devolvieron `304 Not Modified`.
- Todos los `User-Agent` eran Tizen.

Las Samsung Tizen **ignoran las cabeceras HTTP de caché para video**. No mandan
`If-None-Match`. Vuelven a pedir el archivo completo en cada vuelta del bucle,
indefinidamente. La caché HTTP simplemente no es una herramienta disponible en
este hardware.

### La solución

Dos frentes, en este orden:

**1. Hacer el contenido más chico.** Se re-comprimió todo el video existente con
un preajuste pensado para señalización (sin audio, CRF 25, faststart):

| Contenido | Antes | Después | Reducción |
|---|---:|---:|---:|
| Playlists | 388 MiB | 17.5 MiB | **−95.5 %** |
| Pantalla 2 | 725 MiB | 90.3 MiB | **−87.5 %** |
| Pantallas 3 y 4 | — | ~700 KiB c/u | — |

Cada archivo se verificó con `ffprobe` contra el original: códec, resolución y
duración idénticos.

**2. Dejar de redescargar.** Si el televisor no respeta la caché del navegador,
se le da una caché propia: descargar cada video una vez con `fetch`, convertirlo
en `Blob`, y reproducir desde `blob:`. Ver
[ARQUITECTURA](ARQUITECTURA.md#caché-en-el-dispositivo).

### El resultado

| Momento | Egress diario | Costo mensual proyectado |
|---|---:|---:|
| Inicio | 626 GiB | ~1,821 USD |
| Tras re-comprimir | ~13 GiB | ~47 USD |
| Tras la caché local | **≈ 0** | **≈ 0** |

Medición de cierre: **cero descargas de video en 30 minutos** con los
televisores encendidos y reproduciendo.

Proyección a 50 clubes × 6 pantallas: de ~2,285 USD/mes a **~6 USD/mes**.

---

## Por qué no se migró a Cloudflare R2

Se evaluó seriamente. R2 no cobra egress y da 10 GB de almacenamiento gratis, lo
que sonaba a solución perfecta. Se descartó por tres razones:

1. **`r2.dev` no sirve para producción.** Está limitado por tasa y marcado como
   dominio de desarrollo. Producción exige dominio propio.
2. **Dominio propio significaba mover el DNS de `fpt.com.mx` a Cloudflare.** Ese
   dominio lleva el correo de la empresa. El riesgo operativo de migrar el DNS
   corporativo para ahorrar en video no se justificaba.
3. **Cloudflare prohíbe servir video por su CDN** en los planes Free, Pro y
   Business, con casos documentados de aplicación de esa regla contra usuarios
   que servían video desde R2.

Y sobre todo: **el almacenamiento nunca fue el costo.** El costo era el egress, y
el egress lo causaba la redescarga. Resuelto eso, migrar dejó de tener sentido.

### Por qué SharePoint tampoco es la vía de entrega

SharePoint funciona bien como **origen** del contenido — de hecho la
sincronización existente lo usa así para las pantallas 1 y 2. Pero no puede ser
lo que los televisores consultan:

- Los enlaces de descarga expiran.
- Microsoft limita el ancho de banda de forma agresiva.
- No resolvería el problema real: el televisor seguiría redescargando.

---

## Cronología de cambios

### Métricas de Power BI en el ticker

Se agregaron **% de Black Card** y **clubes abiertos** al ticker de las
pantallas 1 y 2, junto a los socios activos.

Tropiezo: la medida se llamaba `[% BC]` según lo asumido, pero el nombre real en
el modelo era `[Porc_BC]`. Se resolvió haciendo que el servidor listara las
medidas disponibles en la bitácora. Desde entonces las consultas DAX son
configurables por variable de entorno, para poder corregirlas sin desplegar.

### Auto-actualización de pantallas

**El problema:** cambiar el código no cambiaba nada en las pantallas. Cada
televisor llevaba la página cargada desde hacía días y seguía ejecutando el
JavaScript viejo. Actualizar significaba ir físicamente a cada club.

**La solución:** el servidor expone su revisión en `/api/version`; la página la
consulta cada 5 minutos y, si cambió, se recarga **al terminar el video en
curso** — nunca a media reproducción.

### Compresión automática al subir

En lugar de pedirle a marketing que comprima antes de subir (que nunca iba a
pasar de forma consistente), el servidor lo hace solo. Se agregó `ffmpeg` a la
imagen del contenedor.

Después se reforzó con verificación por `ffprobe` en ambos extremos, porque un
encode truncado pesa menos que el original y habría pasado una validación que
solo mirara el tamaño.

### Barra de progreso en la carga

Marketing subía archivos grandes sin ninguna señal de avance y se desesperaba.
Se agregó:

- **Porcentaje real** durante la subida — requirió cambiar `fetch` por
  `XMLHttpRequest`, porque `fetch` no puede reportar progreso de subida.
- **Barra indeterminada** durante la compresión en el servidor, donde no existe
  ninguna señal de progreso. Se decidió explícitamente **no inventar** un
  porcentaje: una barra que llega al 100 % y se queda ahí desespera más que no
  tener barra.
- **Aviso "No cierres esta ventana"**, porque cerrar durante la compresión deja
  el video subido pero sin optimizar.
- **Contador "archivo N de M"** para cargas múltiples.

---

## Errores que costaron tiempo

Se documentan para que no se repitan.

| Error | Consecuencia | Lección |
|---|---|---|
| Declarar resuelto el problema de caché verificando solo que el servidor mandaba `304` | Se perdió tiempo mientras la factura seguía corriendo | Medir el resultado, no el mecanismo |
| `while read ... done < lista.txt` con ffmpeg sin `-nostdin` | ffmpeg consumió la lista desde stdin; el proceso se detuvo en 3 de 20 archivos aparentando haber terminado | Siempre `-nostdin` en bucles |
| Validar una re-compresión solo por tamaño | Un encode truncado habría pasado como éxito y se habría subido | Verificar con `ffprobe`: códec, resolución, duración |
| Caché de blobs sin tope de memoria total | 7 videos × 40 MB = 280 MB en la RAM del televisor | Todo caché necesita presupuesto y desalojo |
| Re-ejecutar el script de re-compresión sobre el respaldo | Habría sobrescrito el original con la versión ya comprimida | `gsutil cp -n` |
| Procesos largos en primer plano en Cloud Shell | Morían en cada desconexión | `nohup ... &` |
| Presupuesto creado por API con moneda USD | `INVALID_ARGUMENT` sin explicación | La moneda debe coincidir con la cuenta: **MXN** |

---

## Pendientes conocidos

- Cargar contenido en las pantallas **7 (Zona Black)** y **8 (Zona Cardio)**.
- Resolver la numeración: las pantallas **3 y 6** tienen contenido duplicado.
- Botón "Guardar" para reordenar playlists sin volver a escribir la clave.
- Alerta por correo cuando una pantalla deja de reportar.
- Regenerar el manual en Word: todavía documenta 5 pantallas con nombres viejos
  y no menciona las playlists.
- Limpieza: `screen-2/current-content.backup-before-faststart` (724.9 MiB,
  probablemente muerto) y una política de retención en Artifact Registry, que
  crece ~922 MB por despliegue.
