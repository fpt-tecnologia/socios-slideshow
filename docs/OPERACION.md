# Operación

Tareas del día a día. Todos los comandos se corren desde Cloud Shell en el
proyecto `socios-slideshow`, con el código en `~/app`.

---

## Desplegar

```bash
cd ~/app
nohup gcloud run deploy socios-slideshow \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --timeout=600 \
  --quiet > /tmp/deploy.log 2>&1 &
```

Se lanza en segundo plano con `nohup` a propósito: Cloud Shell pierde la
conexión con frecuencia, y un despliegue en primer plano muere con ella.

Seguimiento:

```bash
tail -f /tmp/deploy.log
```

Terminó bien cuando aparece:

```
Service [socios-slideshow] revision [socios-slideshow-000NN-xxx] has been
deployed and is serving 100 percent of traffic.
```

### Verificación obligatoria después de cada despliegue

Las pantallas están en vivo en los clubes. **Siempre** verifica antes de irte:

```bash
U=https://socios-slideshow-982543281674.us-central1.run.app
for n in 1 2 3 4 5 6 7 8; do
  printf "s%s=%s " $n $(curl -s -o /dev/null -w '%{http_code}' "$U/api/status?screen=$n")
done; echo
for n in 1 2; do
  printf "p%s=%s " $n $(curl -s -o /dev/null -H 'Range: bytes=0-1000' \
    -w '%{http_code}' "$U/api/current-pptx?screen=$n")
done; echo
curl -s "$U/api/version"; echo
```

Lo que debes ver:

- `s1` a `s8` → **200**
- `p1` y `p2` → **206** (el 206 confirma que el video se sirve por rangos, que es
  como lo piden los televisores)
- La versión debe ser la revisión que acabas de desplegar

Si algo sale distinto, ve al [RUNBOOK](RUNBOOK.md).

---

## Subir contenido

### Desde el panel web

`https://tv.fpt.com.mx/upload.html?screen=N`

Escribe la clave de administrador y arrastra el archivo. Verás:

1. Barra con porcentaje real mientras sube el archivo.
2. Barra animada mientras el servidor optimiza el video, con el aviso
   **"No cierres esta ventana hasta que termine."**
3. El resultado, por ejemplo `deportes.mp4: 23.0 MB → 1.8 MB`.

**Importante:** si alguien cierra la pestaña durante el paso 2, el video **sí**
queda subido y funcionando, pero se queda sin comprimir. No se rompe nada, solo
queda pesado. Se puede volver a subir para que se comprima.

### Confirmar que la compresión corrió

```bash
gcloud run services logs read socios-slideshow \
  --region us-central1 --limit 50 | grep compresion
```

Deberías ver algo como:

```
[compresion] pantalla 3 abc123: 38.4 -> 2.1 MiB
```

Si ves `no es un video, se deja tal cual`, el archivo no tenía stream de video
(por ejemplo un `.pptx`) y se dejó intacto a propósito.

---

## Refrescar todas las pantallas a la fuerza

Las pantallas se actualizan solas dentro de 5 minutos tras un despliegue. Para
forzarlo sin cambiar código, basta con crear una revisión nueva:

```bash
gcloud run services update socios-slideshow \
  --region us-central1 \
  --update-env-vars REFRESH_MARCA=$(date +%s)
```

> **Nota sobre comas.** `gcloud` interpreta la coma como separador de variables.
> Si el valor lleva coma, usa el delimitador alternativo:
> `--update-env-vars '^@^CLAVE=valor, con coma'`

---

## Re-comprimir video que ya está arriba

El script `recomp.sh` toma un número de pantalla y re-comprime su playlist.
Guarda el original en `gs://socios-slideshow-storage/backup-original/` antes de
tocar nada, con `gsutil cp -n` para no pisar un respaldo previo.

```bash
bash ~/recomp.sh 3
```

Corre en segundo plano y escribe en `~/reenc/log.txt`. **La terminal se ve
congelada porque toda la salida va al log** — no está trabada. Sigue el avance
desde otra pestaña:

```bash
tail -f ~/reenc/log.txt
```

Antes de dar por buena una re-compresión, verifica integridad con `ffprobe`:
códec, resolución y duración deben coincidir con el original. Un archivo
truncado pesa menos y pasaría una revisión que solo mire el tamaño.

---

## Revisar consumo y costo

### Egress de red

```bash
TOKEN=$(gcloud auth print-access-token)
AHORA=$(date -u +%Y-%m-%dT%H:%M:%SZ)
ANTES=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)

curl -s -H "Authorization: Bearer $TOKEN" \
  "https://monitoring.googleapis.com/v3/projects/socios-slideshow/timeSeries?\
filter=metric.type%3D%22run.googleapis.com%2Fcontainer%2Fnetwork%2Fsent_bytes_count%22&\
interval.startTime=$ANTES&interval.endTime=$AHORA&\
aggregation.alignmentPeriod=3600s&\
aggregation.perSeriesAligner=ALIGN_SUM&\
aggregation.crossSeriesReducer=REDUCE_SUM"
```

Otras métricas útiles con el mismo patrón:

- `run.googleapis.com/container/billable_instance_time`
- `run.googleapis.com/request_count`

### Créditos restantes

Consola de Google Cloud → Facturación → Descripción general.

---

## Alertas configuradas

| Alerta | Qué vigila |
|---|---|
| Alerta de egress | Consumo de red anormal, probada de punta a punta |
| Presupuesto (MXN) | Tres umbrales, avisan al correo verificado |

> **Nota al crear presupuestos por API:** la moneda del presupuesto **debe
> coincidir con la de la cuenta de facturación**, que en este caso es **MXN**.
> Además hay que mandar la cabecera `x-goog-user-project: socios-slideshow`. Sin
> cualquiera de las dos cosas la API responde `INVALID_ARGUMENT` sin explicar
> por qué.

---

## Notas sobre Cloud Shell

- Solo `$HOME` sobrevive al reinicio de la máquina virtual. `/tmp` y los
  paquetes instalados con `apt` **se pierden**. Si necesitas `ffmpeg` en Cloud
  Shell, instálalo en el mismo comando en que lo usas.
- Cuando aparece *"Se perdió la conexión"*, dale **Volver a conectar**. Después
  suele salir el modal **"Autoriza Cloud Shell"**, que hay que aceptar a mano.
- Los procesos largos van siempre con `nohup ... &`.

### Trampa de shell que ya costó un susto

```bash
# MAL: ffmpeg se come la lista desde stdin y el bucle se detiene
while read f; do ffmpeg -i "$f" ... ; done < lista.txt

# BIEN
while read f; do ffmpeg -nostdin -i "$f" ... ; done < lista.txt
```

Sin `-nostdin`, ffmpeg consume el resto de `lista.txt` y el proceso se detiene
silenciosamente a los pocos archivos, aparentando haber terminado.
