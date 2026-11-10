# Sistema de interfaz — Habit Memory

## Intención y firma

Consola privada de observabilidad para quien abre la herramienta entre tareas y necesita identificar patrones, ámbitos y checkpoints, y editar o borrar datos con seguridad. Debe sentirse precisa, sobria y compacta; no es un dashboard financiero. La firma son las filas de procedencia: cada renglón de hábito conserva su señal (**solicitud explícita** o **uso observado**) y su clave original, y cada checkpoint queda anclado a su **Proyecto** y **Contexto** dentro de un grupo identificado por **Directorio / Proyecto**.

## Dirección visual

- Tema oscuro por defecto y claro manual, alternados con el botón del masthead. Tokens en `src/ui.css` bajo `:root` y `:root[data-theme="light"]`. Oscuro: canvas `#0b1119`, superficie `#101923`, elevada `#141f2b`, tinta `#dce6ed`, secundario `#91a2b1`, teal `#59d6c8`, rojo `#ed8589`, serie de comandos `#b69af7`. Claro: canvas `#f2f6f8`, superficie `#ffffff`, elevada `#e8eff2`, tinta `#172733`, secundario `#536a78`, teal `#087d75`, rojo `#a8323c`, serie de comandos `#6045a8`. Líneas y bordes derivan de la tinta con `color-mix` (12/7 % en oscuro, 17/10 % en claro).
- Profundidad solo por superficie y bordes de 1px, sin sombras. Teal indica foco, interacción y señal del producto; rojo queda para acciones destructivas; el morado distingue la segunda serie de la tendencia. Nada de ello es decoración.
- Tipografía base `14px/1.5 system-ui`; `ui-monospace` para IDs, claves y valores técnicos; cifras tabulares en conteos y totales.
- Espaciado compacto en rem, radios de `.25–.45rem` y encabezados con tracking negativo. Jerarquía de terminal: metadatos pequeños, encabezados precisos y densidad sin sacrificar legibilidad.
- Desktop (`≥45rem`): rail fijo de `13.5rem` del mismo canvas separado por borde derecho, con marca, navegación vertical y nota local al pie; contenido hasta `88rem`. Mobile: cabecera compacta con marca, navegación en tres columnas y nota local. El masthead agrupa eyebrow, título, intro y controles de idioma y tema.
- Español es el idioma inicial; selector manual ES/EN y botón de tema en el masthead. Solo se traduce la interfaz, nunca los datos guardados.

## Patrones de información

- Navegación por vistas SPA mediante hash —**Informes**, **Puntos guardados** y **TODOs**— con direct links, historial atrás/adelante, `aria-current` y nota explícita de almacenamiento local; solo la vista activa muestra su contenido.
- La WebUI se suscribe a `/api/events` por SSE y refresca los datos al cambiar el store local, sin recargar; al recuperar la visibilidad revalida por si la conexión se perdió.
- Los informes presentan dos tarjetas, **Herramientas** y **Comandos**, con total teal y ranking descendente. Cada renglón rotula su señal (**solicitud explícita** / **uso observado**), su tipo y nombre, y conserva la clave original en mono.
- La tendencia es una gráfica SVG nativa de barras agrupadas por día UTC, con ventana móvil de 365 días y series teal (herramientas) y morada (comandos). Incluye leyenda, título y descripción, y declara que empieza con la instrumentación nueva, sin fechas ni actividad fabricadas para los conteos legacy.
- El borrado de hábitos agregados se ofrece solo en la WebUI, como acción destructiva roja y confirmada; elimina acumulados y tendencia, pero no checkpoints.
- Los puntos guardados se agrupan por proyecto. El resumen de cada grupo muestra **Directorio**, **Proyecto** y cantidad real; cada entrada conserva título de sesión, resumen, **Contexto**, fecha y acciones de editar/eliminar. La lista no se limita ni se recorta.
- Los TODOs se agrupan por proyecto y estado —pendientes, completados y archivados—, muestran el **Directorio** del proyecto cuando se conoce y ofrecen casilla para incluir archivados.
- Mantener edición, confirmaciones de borrado, estados de error/carga/guardado y acceso por teclado. Destructivo es rojo, distinto de la acción/foco teal y rotulado además de su color.

## Accesibilidad y límites

- Estructura semántica, controles etiquetados, foco visible de 2px, contraste AA, idioma del documento sincronizado y movimiento reducido; el gráfico ofrece título, descripción, leyenda y tooltip por barra.
- No añadir dependencias, CDN, datos sintéticos, charts falsos, marca/terminología financiera ni iconografía decorativa. Las tendencias nunca contienen eventos raw, prompts, comandos literales o conversaciones.
- Breakpoints de `45rem` y `68rem` y componentes implementados en `src/App.vue`, `src/ui-model.js` y `src/ui.css`.
