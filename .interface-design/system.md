# Sistema de interfaz — Habit Memory

## Intención y firma

Consola privada de observabilidad para quien abre la herramienta entre tareas y necesita identificar patrones, ámbitos y checkpoints, editar o borrar datos con seguridad y entender el uso de tokens y caché. Debe sentirse precisa, sobria y compacta; no es un dashboard financiero ni un producto de marketing. La firma son las filas de procedencia: cada renglón de hábito conserva su señal (**solicitud explícita** o **uso observado**) y su clave original, y cada checkpoint queda anclado a su **Proyecto** y **Contexto** dentro de un grupo identificado por **Directorio / Proyecto**. En Métricas, la firma se amplía con series de tokens separadas y una tasa de caché medida, nunca estimada.

## Dirección visual

- Tema oscuro por defecto y claro manual, alternados con el botón del masthead. Tokens en `src/ui.css` bajo `:root` y `:root[data-theme="light"]`. Oscuro: canvas `#0b1119`, superficie `#101923`, elevada `#141f2b`, tinta `#dce6ed`, secundario `#91a2b1`, teal `#59d6c8`, rojo `#ed8589`, serie de comandos `#b69af7`, series de tokens `#7cc7ff` (input), `#59d6c8` (caché) y `#f0b86e` (output). Claro: canvas `#f2f6f8`, superficie `#ffffff`, elevada `#e8eff2`, tinta `#172733`, secundario `#536a78`, teal `#087d75`, rojo `#a8323c`, serie de comandos `#6045a8`, series de tokens `#0b5f8a` (input), `#087d75` (caché) y `#8a4b00` (output). Líneas y bordes derivan de la tinta con `color-mix` (12/7 % en oscuro, 17/10 % en claro). Las series de tokens mantienen contraste AA en ambos temas.
- Profundidad solo por superficie y bordes de 1px, sin sombras. Teal indica foco, interacción y señal del producto; rojo queda para acciones destructivas; el morado distingue la segunda serie de la tendencia; azul, teal y ámbar distinguen input, caché y output en Métricas. Nada de ello es decoración.
- Tipografía base `14px/1.5 system-ui`; `ui-monospace` para IDs, claves y valores técnicos; cifras tabulares en conteos, tokens y totales.
- Espaciado compacto en rem, radios de `.25–.45rem` y encabezados con tracking negativo. Jerarquía de terminal: metadatos pequeños, encabezados precisos y densidad sin sacrificar legibilidad.
- Desktop (`≥45rem`): rail fijo de `13.5rem` del mismo canvas separado por borde derecho, con marca, navegación vertical y nota local al pie; contenido hasta `88rem`. Mobile: cabecera compacta con marca, navegación de cuatro vistas en cuatro columnas y nota local. El masthead agrupa eyebrow, título, intro y controles de idioma y tema.
- Español es el idioma inicial; selector manual ES/EN y botón de tema en el masthead. Solo se traduce la interfaz, nunca los datos guardados.

## Patrones de información

- Navegación por vistas SPA mediante hash —**Informes**, **Puntos guardados**, **TODOs** y **Métricas**— con direct links, historial atrás/adelante, `aria-current` y nota explícita de almacenamiento local; solo la vista activa muestra su contenido. Informes es la vista predeterminada.
- La WebUI se suscribe a `/api/events` por SSE y refresca el store y las métricas cuando cambia `store-v1.json` o `metrics.db`, sin recargar; al recuperar la visibilidad revalida por si la conexión se perdió. El watcher ignora `-shm` para evitar que las lecturas read-only disparen SSE en bucle.
- Los informes presentan dos tarjetas, **Herramientas** y **Comandos**, con total teal y ranking descendente. Cada renglón rotula su señal (**solicitud explícita** / **uso observado**), su tipo y nombre, y conserva la clave original en mono.
- La tendencia es una gráfica SVG nativa de barras agrupadas por día UTC, con ventana móvil de 365 días y series teal (herramientas) y morada (comandos). Incluye leyenda, título y descripción, y declara que empieza con la instrumentación nueva, sin fechas ni actividad fabricadas para los conteos legacy.
- **Métricas** ofrece filtros de rango 7/30/90 días y por proyecto, agente, proveedor y modelo; cada cambio vuelve a consultar `/api/metrics`. Tiene estados de carga, error con **Reintentar** y vacío con el mensaje de que la instrumentación empieza ahora. Las opciones de filtro se acumulan para no perder la selección al aplicar otro filtro.
- Las tarjetas de Métricas muestran pasos, entrada sin caché, caché leída, salida y razonamiento. El coste y su cobertura siguen en `/api/metrics`, pero no se muestran en la vista.
- El panel de ahorro presenta `cacheHitRate = cache.read / (input + cache.read + cache.write)` como medición exacta de tokens reutilizados. No se estima ningún ahorro económico.
- Las series de Métricas son cinco campos separados: `input`, `output`, `reasoning`, `cacheRead`, `cacheWrite`. No hay un total único de tokens. La gráfica apila input, caché leída y salida; es la única gráfica de la vista.
- Las tablas de Métricas cubren agente, modelo/proveedor, proyecto (hash + directorio) y tipo de petición, con pasos y tokens. Se limitan a 50 filas por dimensión. Cada tabla ordena de forma independiente por nombre, pasos o tokens: por defecto pasos descendente, la misma cabecera alterna y una columna nueva empieza en ascendente para el nombre y descendente para las cifras; el desempate es alfabético. Las cabeceras son botones nativos con `aria-sort` e indicador ↑/↓.
- **Salud del plugin** muestra contadores en memoria: hooks, storage, contexto inyectado, SSE, peticiones 2xx/4xx/5xx, flush y errores, además de checkpoints/TODOs/ámbitos actuales. Es una sección de diagnóstico, no un panel de negocio; si el bloque `plugin` no existe o está vacío se muestra un estado vacío claro.
- Los puntos guardados se agrupan por proyecto. El resumen de cada grupo muestra **Directorio**, **Proyecto** y cantidad real; cada entrada conserva título de sesión, resumen, **Contexto**, fecha y acciones de editar/eliminar. La lista no se limita ni se recorta.
- Los TODOs se agrupan por proyecto y estado —pendientes, completados y archivados—, muestran el **Directorio** del proyecto cuando se conoce y ofrecen casilla para incluir archivados.
- Mantener edición, confirmaciones de borrado, estados de error/carga/guardado y acceso por teclado. Destructivo es rojo, distinto de la acción/foco teal y rotulado además de su color.

## Privacidad y contrato de datos

- `metrics.db` usa hashes SHA-256 para sesión, padre y proyecto, y un hash de mensaje para deduplicar. El directorio se reduce a basename saneado.
- No se guardan prompts, argumentos, transcripciones, títulos de sesión, rutas absolutas ni IDs crudos.
- El bloque `plugin` de `/api/metrics` solo expone contadores, latencias, tamaños y fechas; nunca contenido.
- Variables de privacidad del contrato, no tokens visuales: `session_hash`, `parent_hash`, `project_hash`, `message_hash`, `directory` (basename), y etiquetas allowlisted de agente/proveedor/modelo/variante. La UI consume agregados y conteos; no recibe los valores originales.
- `store-v1.json` no se modifica para métricas; los contadores del plugin son de proceso y se reinician con él.

## Accesibilidad y límites

- Estructura semántica, controles etiquetados, `<fieldset>`/`<legend>` en filtros, `<caption>` y `scope` en tablas, foco visible de 2px, contraste AA, idioma del documento sincronizado y movimiento reducido.
- Las gráficas SVG son nativas, con `role="img"`, `<title>`, `<desc>`, leyenda y tooltip por barra. No hay charts falsos ni librerías de gráficas.
- No añadir dependencias, CDN, datos sintéticos, marca/terminología financiera ni iconografía decorativa. Las tendencias y métricas nunca contienen eventos raw, prompts, comandos literales o conversaciones.
- Breakpoints de `30rem` (panel de ahorro a una columna), `45rem` y `68rem` (tablas de Métricas a dos columnas); la gráfica de tokens ocupa el ancho disponible. Componentes implementados en `src/App.vue`, `src/ui-model.js` y `src/ui.css`.
