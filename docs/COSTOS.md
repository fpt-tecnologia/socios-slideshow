# Costos

---

## Dónde está el costo

Cloud Run cobra por cuatro cosas. En este proyecto el reparto es muy desigual:

| Concepto | Peso real |
|---|---|
| **Salida de red (egress)** | Era el 95 % del costo. Hoy es casi cero. |
| Tiempo de instancia facturable | Bajo: el servicio está inactivo la mayor parte del tiempo |
| Almacenamiento en Cloud Storage | Marginal (unos pocos GiB) |
| Artifact Registry | Crece ~922 MB por despliegue. **Necesita política de retención.** |

El almacenamiento nunca fue el problema. Vale la pena repetirlo porque es
contraintuitivo y llevó a considerar migraciones innecesarias.

---

## Trayectoria medida

| Momento | Egress diario | Costo mensual |
|---|---:|---:|
| Antes de intervenir | 626 GiB | ~1,821 USD |
| Después de re-comprimir el video | ~13 GiB | ~47 USD |
| Después de la caché en dispositivo | ≈ 0 | ≈ 0 |

Todas son mediciones reales de Cloud Monitoring, no proyecciones.

### Proyección a escala completa

Con 50 clubes × 6 pantallas:

| Escenario | Costo mensual |
|---|---:|
| Sin ninguna optimización | ~2,285 USD |
| Con el sistema actual | **~6 USD** |

La diferencia no viene de un plan más barato ni de otro proveedor. Viene de que
el video dejó de descargarse una y otra vez.

---

## Por qué la caché local es lo que domina el costo

Un video de 2 MB en bucle de 30 segundos, redescargado cada vuelta:

```
2 MB × 120 vueltas/hora × 24 h × 6 pantallas × 50 clubes ≈ 1.7 TB/día
```

El mismo video con caché en dispositivo:

```
2 MB × 1 descarga × 6 pantallas × 50 clubes ≈ 600 MB, una sola vez
```

De ahí que la caché sea la pieza más importante del sistema, y que valga la pena
vigilar que siga funcionando. Los síntomas de que se rompió están en el
[RUNBOOK](RUNBOOK.md#el-costo-se-disparó).

---

## Cómo medir

### Egress de las últimas 24 horas

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

Métricas equivalentes cambiando `metric.type`:

- `run.googleapis.com/container/billable_instance_time`
- `run.googleapis.com/request_count`

### Señal de alarma

Si el egress diario supera unos pocos GiB, algo dejó de funcionar. Con el
sistema sano, después del arranque inicial de cada pantalla el consumo tiende a
cero.

---

## Alertas y presupuestos

| Mecanismo | Estado |
|---|---|
| Alerta de egress | Configurada y **probada de punta a punta** |
| Presupuesto con 3 umbrales | Configurado en **MXN**, avisa al correo verificado |

### Trampas al crear presupuestos por API

Dos cosas que hacen fallar la API con `INVALID_ARGUMENT` sin decir por qué:

1. **Falta el proyecto de cuota.** Hay que mandar la cabecera
   `x-goog-user-project: socios-slideshow`.
2. **Moneda equivocada.** La moneda del presupuesto debe coincidir con la de la
   cuenta de facturación, que es **MXN**, no USD.

Para descubrir la moneda correcta, lista los presupuestos que ya existen en la
cuenta y mira el campo de moneda.

---

## Limpieza pendiente

| Elemento | Por qué |
|---|---|
| `screen-2/current-content.backup-before-faststart` | 724.9 MiB, probablemente ya no se usa |
| Política de retención en Artifact Registry | Cada despliegue deja ~922 MB de imagen |
| Presupuesto "Alerta validador-expediente" de 1 MXN | Preexistente, sin filtro de proyecto; probablemente ruido |
