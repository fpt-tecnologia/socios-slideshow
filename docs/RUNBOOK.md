# Runbook — qué hacer cuando algo falla

---

## Una pantalla está en negro o congelada

1. **Confirma que el servidor responde para esa pantalla:**

   ```bash
   U=https://socios-slideshow-982543281674.us-central1.run.app
   curl -s "$U/api/status?screen=3" | head -c 300; echo
   ```

   - `200` con contenido → el problema está en el televisor, no en el servidor.
   - `500` o vacío → ve a *"El servicio no responde"*.

2. **Confirma que hay contenido cargado.** Una pantalla sin contenido se ve
   vacía y eso es correcto, no una falla. Las pantallas 7 y 8 han estado vacías
   por no tener material asignado.

3. **Recarga el televisor.** En la mayoría de las Samsung: salir de la app del
   navegador y volver a entrar. También puedes forzar la recarga de toda la
   flota creando una revisión nueva (ver [OPERACION](OPERACION.md#refrescar-todas-las-pantallas-a-la-fuerza));
   la pantalla se recarga sola en menos de 5 minutos.

---

## El contenido nuevo no aparece en la pantalla

Casi siempre es esto: **la página lleva días cargada y está corriendo el
JavaScript viejo.**

El mecanismo de auto-actualización solo reacciona a **revisiones nuevas de Cloud
Run**, no a cambios de contenido. El contenido sí se detecta en el ciclo normal
(cada minuto para status, cada ciclo para playlist), pero si la lógica de la
página cambió, hace falta recargar.

Fuerza una revisión nueva:

```bash
gcloud run services update socios-slideshow \
  --region us-central1 \
  --update-env-vars REFRESH_MARCA=$(date +%s)
```

Espera 5 minutos. Si sigue igual, el televisor no está ejecutando el ciclo de
versión: recárgalo a mano.

---

## El video se ve pero se reproduce entrecortado

Revisa si el video está entrando a la caché local del televisor. Con la consola
del navegador conectada verás una de estas líneas:

```
video en cache local: abc123 2.1 MB
cache local lleno, este video se reproduce por red: def456
```

Si dice *"cache local lleno"*, la playlist excede los 150 MB del tope
(`LIMITE_TOTAL`). Los videos que no caben se reproducen por red, lo que además
de entrecortarse **cuesta dinero**. Solución: re-comprimir esa playlist.

```bash
bash ~/recomp.sh 3
```

---

## El servicio no responde

1. **Revisa el estado del servicio:**

   ```bash
   gcloud run services describe socios-slideshow --region us-central1 \
     --format='value(status.conditions)'
   ```

2. **Revisa la bitácora:**

   ```bash
   gcloud run services logs read socios-slideshow --region us-central1 --limit 100
   ```

3. **Vuelve a la revisión anterior** si el despliegue reciente rompió algo:

   ```bash
   gcloud run revisions list --service socios-slideshow --region us-central1 --limit 5
   gcloud run services update-traffic socios-slideshow \
     --region us-central1 --to-revisions=REVISION_BUENA=100
   ```

   Esto es instantáneo y no requiere volver a construir la imagen.

---

## Un despliegue falló

El código tiene respaldos con marca de tiempo en `~/app`:

```bash
ls -la ~/app/*.antes* ~/app/public/*.antes*
```

Para restaurar:

```bash
cp ~/app/server.js.antesbarra-AAAAMMDD-HHMMSS ~/app/server.js
cp ~/app/public/upload.html.antesbarra-AAAAMMDD-HHMMSS ~/app/public/upload.html
```

Antes de volver a desplegar, **siempre** verifica sintaxis:

```bash
node --check ~/app/server.js && echo SERVER_OK
```

Para el JavaScript dentro de `upload.html` o `display.html`, extráelo y
revísalo:

```bash
python3 - <<'PYX'
import re, io
s = io.open('/home/betancourt_jair/app/public/upload.html', encoding='utf-8').read()
m = re.findall(r'<script>(.*?)</script>', s, re.S)
io.open('/tmp/u.js', 'w', encoding='utf-8').write(chr(10).join(m))
print('bloques script:', len(m))
PYX
node --check /tmp/u.js && echo HTML_JS_OK
```

---

## El ticker de socios muestra datos viejos o no muestra nada

1. **Revisa la bitácora por errores de Power BI:**

   ```bash
   gcloud run services logs read socios-slideshow --region us-central1 \
     --limit 100 | grep -i powerbi
   ```

2. **Causa más común: el nombre de la medida DAX está mal.** Los nombres reales
   del modelo son `Socios Activos`, `Porc_BC` y `Clubes Activos`. Si alguien
   renombra una medida en Power BI, la consulta falla en silencio.

   El servidor puede listar las medidas disponibles en la bitácora
   (`POWERBI_LISTAR_MEDIDAS`), que es la forma rápida de ver el nombre correcto.

3. **Corregir sin tocar código:**

   ```bash
   gcloud run services update socios-slideshow --region us-central1 \
     --update-env-vars 'POWERBI_DAX_BC=EVALUATE ROW("v", [Porc_BC])'
   ```

   Si el valor lleva coma, usa el delimitador alternativo:
   `--update-env-vars '^@^CLAVE=valor, con coma'`

---

## El costo se disparó

Esto ya pasó una vez y la causa está documentada en
[HISTORIAL.md](HISTORIAL.md). Diagnóstico rápido:

1. **Mide el egress real** (ver [OPERACION](OPERACION.md#revisar-consumo-y-costo)).
   Si supera unos pocos GiB al día, hay pantallas redescargando video.

2. **Confirma si la caché local está funcionando.** En la bitácora, cuenta las
   peticiones a `/api/playlist-item` y `/api/current-pptx`. Con la caché
   funcionando deberían ser casi cero después del arranque inicial.

3. **Causas probables, en orden:**
   - Una pantalla con la página vieja cargada, sin el código de caché.
   - Videos que exceden `LIMITE_BLOB` (60 MB) y por eso van por red.
   - Una playlist cuya suma supera `LIMITE_TOTAL` (150 MB).

   Las tres se arreglan re-comprimiendo el contenido y forzando una recarga.

---

## Un video se subió pero quedó pesado

Significa que la compresión no corrió. Causas:

- Alguien cerró la pestaña durante el paso de optimización.
- El archivo superaba `COMP_MAX_ENTRADA` (300 MB).
- `ffprobe` no detectó stream de video.

Revisa la bitácora:

```bash
gcloud run services logs read socios-slideshow --region us-central1 \
  --limit 50 | grep compresion
```

Solución: volver a subir el archivo, o re-comprimir la playlist con
`~/recomp.sh`.

---

## Cloud Shell no coopera

Síntomas frecuentes y qué significan:

| Síntoma | Qué hacer |
|---|---|
| *"Se perdió la conexión"* | **Volver a conectar**. Después acepta el modal **"Autoriza Cloud Shell"**. |
| Comando que parece colgado | Si escribe a un log, la terminal se ve congelada aunque esté trabajando. `tail -f` desde otra pestaña. |
| `ffmpeg: command not found` | La VM se reinició y borró los paquetes de `apt`. Instálalo en el mismo comando en que lo uses. |
| Proceso largo que murió solo | Se ejecutó en primer plano y lo mató la desconexión. Usa `nohup ... &`. |

Solo `$HOME` sobrevive al reinicio de la máquina. `/tmp` no.
