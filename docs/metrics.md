# Métricas de uso

La WebUI de Habit Memory incluye una vista **Métricas** con datos de uso del runtime de OpenCode y del propio plugin. El detalle vive en `metrics.db`, una base SQLite independiente de `store-v1.json`.

## Fuentes de datos

OpenCode entrega eventos con el sobre:

```js
{ id, created, type, metadata, location, data }
```

Habit Memory se suscribe a dos tipos:

- **`session.step.ended`**: un paso de asistente. `data` contiene `sessionID`, `assistantMessageID`, `finish`, `rawFinish`, `cost`, `tokens` y metadatos del proveedor. `tokens` tiene la forma `{ input, output, reasoning, cache: { read, write } }`.
- **`session.usage.recorded`**: uso no asociado a un paso normal, con `source` `title`, `compaction` o `generate`, además de `cost` y `tokens`.

La ingesta en vivo se hace con `ctx.event.subscribe({ types, signal })`. Las dimensiones que no vienen en el evento (`parentID`, `projectID`, `agent`, `model`, `location.directory`) se resuelven con `ctx.session.get` y se guardan en una caché LRU acotada.

Para completar el histórico se ejecuta un **backfill** en segundo plano con `ctx.session.list` paginado por `cursor`. No recorre mensajes: inserta una fila aproximada por sesión con los totales de `Session.Info`.

## Almacenamiento

- Ruta: el mismo directorio que `store-v1.json`; por defecto `$XDG_DATA_HOME/habit-memory-plugin/metrics.db` o `~/.local/share/habit-memory-plugin/metrics.db`.
- `journal_mode=WAL`, `busy_timeout=5000`, `synchronous=NORMAL`.
- Permisos `0600` para el archivo y sus auxiliares WAL/SHM.
- `store-v1.json` no se modifica ni se usa para métricas.

### `steps`

Una fila por paso o por uso agregado. La deduplicación se hace por `message_hash`.

| Columna | Contenido |
|---|---|
| `id` | Clave interna. |
| `day` | Día UTC (`YYYY-MM-DD`). |
| `created_at` | Marca temporal en milisegundos. |
| `message_hash` | SHA-256 de `message:<assistantMessageID>` o `event:<event.id>`. Único. |
| `session_hash` | SHA-256 del `sessionID`. |
| `parent_hash` | SHA-256 del `parentID` si existe. |
| `project_hash` | SHA-256 del `projectID` si existe. |
| `directory` | Solo el basename saneado del directorio. |
| `agent`, `provider`, `model`, `variant` | Etiquetas allowlisted, sin contenido libre. |
| `kind` | `primary`, `subagent`, `title`, `compaction`, `generate` u `other`. |
| `source` | `live` o `backfill`. |
| `input_tokens` | Tokens de entrada **sin caché**. |
| `output_tokens` | Tokens de salida. |
| `reasoning_tokens` | Tokens de razonamiento. |
| `cache_read_tokens` | Tokens leídos de caché. |
| `cache_write_tokens` | Tokens escritos a caché. |
| `cost` | Coste reportado por el runtime, en USD. |
| `priced` | `1` solo si `cost > 0`; `0` si falta precio o es cero. |

Índices: `day`, `session_hash` y `(session_hash, source)`.

### `monthly`

Tabla preparada para agregados mensuales con horizonte de 24 meses:

`month`, `project_hash`, `agent`, `provider`, `model`, `kind`, `steps`, tokens, `cost` y `priced_steps`, con clave primaria por dimensiones.

`createMetricsStore().rebuildMonthly()` recalcula la tabla desde `steps`. La API actual consulta `steps` directamente; la vista no depende de `monthly`.

### `meta`

Clave-valor para el estado de la ingesta:

- `source.liveFrom`: primera vez que se inició la suscripción en vivo.
- `source.backfillAt`: última finalización correcta del backfill.

## Privacidad

No se guardan prompts, argumentos, transcripciones, títulos de sesión, rutas absolutas ni IDs crudos.

- Sesión, padre y proyecto se guardan como hash SHA-256.
- El mensaje se deduplica por hash; nunca se guarda el ID original.
- El directorio se reduce a basename y se valida.
- Agente, proveedor, modelo y variante pasan por una lista de caracteres permitidos.
- El bloque de salud del plugin solo contiene contadores, latencias, tamaños y fechas; no contenido.

## Tokens y caché

OpenCode separa:

- `input`: tokens de entrada **no cacheados**.
- `cache.read`: tokens leídos de caché.
- `cache.write`: tokens escritos a caché.
- `output`: tokens generados.
- `reasoning`: tokens de razonamiento.

Por eso la API **no publica un total único de tokens**. Sumar `input` y `cache.read` sin conocer la semántica del proveedor puede duplicar conteos, y el total no distingue entrada, salida, razonamiento y caché. La vista y `/api/metrics` mantienen las cinco series separadas.

La tasa de acierto de caché es una medición exacta:

```text
cacheHitRate = cache.read / (input + cache.read + cache.write)
```

No se convierte a USD ni se presenta como ahorro económico.

## Coste y cobertura

`cost` es el coste reportado por OpenCode. No se calcula a partir de precios de modelos ni se inventan importes.

- `priced = 1` solo cuando el runtime reporta `cost > 0`.
- `costCoverage = pricedSteps / steps`.
- En la UI, si la cobertura es `0`, el coste se muestra como `—`; las tablas siempre muestran la cobertura junto al coste.
- Una cobertura baja significa que muchos pasos no tienen precio reportado, no que el coste sea cero.

## Retención

- **Detalle `steps`:** se conservan los últimos **90 días UTC**. La poda se ejecuta en cada ingesta.
- **Agregados `monthly`:** el diseño objetivo es **24 meses**. En 0.2.0 la tabla está preparada y `rebuildMonthly()` existe, pero no hay una poda automática de 24 meses ni se recalcula desde la API; la ventana efectiva depende del detalle disponible.

## Backfill

- Usa `ctx.session.list` con `limit`, `order: "desc"` y `cursor` opaco.
- Límite: 5000 sesiones o hasta alcanzar el corte de 90 días.
- Inserta una fila aproximada por sesión, con `source=backfill` y hash sintético `session:<id>`.
- El día se toma de `time.updated` de la sesión; es una aproximación, no un paso real.
- Omite sesiones que ya tienen filas `live` para no duplicar.
- `source.backfillAt` evita repetirlo. Si se borra esa clave con el plugin detenido, el siguiente arranque puede volver a intentarlo.
- No lee transcripciones ni mensajes: solo `Session.Info`.

## Ingesta en vivo

- Cola en memoria con flush debounced de **15 s** o **500 eventos**, lo que ocurra primero.
- Flush final al descargar el plugin y en el `exit` del proceso cuando es posible.
- Deduplicación por `message_hash`; reintentos y eventos repetidos no duplican filas.
- Si el proceso muere antes del flush, se puede perder el último lote.

## `/api/metrics`

```text
GET /api/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD&project=&agent=&provider=&model=&kind=
```

- `from`/`to` en UTC. Por defecto, últimos 30 días; máximo 90 días.
- `project` acepta el hash de proyecto o el basename del directorio.
- `agent`, `provider`, `model` y `kind` son filtros exactos.
- Top 50 por dimensión.
- Misma comprobación de host que `/api/data`; no requiere token.
- `400` para fechas o filtros inválidos; `500` con `{ "error": "..." }` si la base no se puede leer.

Respuesta:

```json
{
  "range": { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "days": 30 },
  "totals": {
    "steps": 0,
    "tokens": { "input": 0, "output": 0, "reasoning": 0, "cacheRead": 0, "cacheWrite": 0 },
    "cost": 0,
    "pricedSteps": 0,
    "costCoverage": 0,
    "cacheHitRate": 0
  },
  "series": [],
  "byAgent": [],
  "byModel": [],
  "byProject": [],
  "byKind": [],
  "plugin": {}
}
```

`series` rellena los días del rango con ceros. No existe `tokens.total` ni un total único de coste sin cobertura.

### Bloque `plugin`

`/api/metrics` añade contadores del propio plugin, en memoria:

`startedAt`, `uptimeMs`, `hooks`, `context`, `store`, `sse`, `requests`, `flush`, `errors`, `current` y `bytes`.

Incluye llamadas/errores/latencias de hooks, lecturas/escrituras del store, bytes, esperas de lock, clientes SSE, peticiones 2xx/4xx/5xx, pendientes/fallos de flush, errores por categoría y conteos actuales de checkpoints/TODOs/ámbitos. No incluye sessionIDs, prompts, rutas ni argumentos. Los contadores son de proceso: se reinician con el plugin.

## Requisitos

- **Node.js >= 24** (`engines`).
- `node:sqlite` (`DatabaseSync`), sin dependencias externas de base de datos.
- El plugin crea `metrics.db` al arrancar; no hace falta inicializarlo a mano.

## Troubleshooting

**No aparece `metrics.db`.** Comprueba Node 24, que el plugin esté cargado y que el directorio de datos sea escribible. La creación ocurre en `setup`.

**La vista está vacía.** La instrumentación empieza ahora: no se reconstruyen conversaciones antiguas. El backfill aproximado puede tardar unos segundos; espera al siguiente refresco o consulta el rango.

**El coste sale como `—` o con cobertura baja.** OpenCode no reportó precio para esos pasos. No se estima USD; usa `costCoverage` para saber qué proporción tiene precio.

**`400 Invalid metrics query`.** Revisa fechas `YYYY-MM-DD`, que `from <= to`, que el rango no supere 90 días y que los filtros existan.

**`500 Unable to read metrics`.** `metrics.db` puede estar corrupta o inaccesible. Con el plugin y la WebUI detenidos, renombra o elimina `metrics.db`, `metrics.db-wal` y `metrics.db-shm`; se recreará. `store-v1.json` no se toca.

**`Storage is locked`.** Otra operación mantiene el lock del store más de 5 s. Reintenta y revisa procesos concurrentes; no cambies la semántica de bloqueo.

**El backfill no se repite.** Es intencional por `source.backfillAt`. Si necesitas repetirlo, elimina esa clave de `meta` con el plugin detenido.

**SSE no refresca.** La WebUI observa `metrics.db` y `metrics.db-wal`. Si el navegador perdió la conexión, recupera la visibilidad o recarga; el endpoint `/api/events` no cambia.
