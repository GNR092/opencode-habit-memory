# Sistema de interfaz — Habit Memory

## Intención y firma

Consola privada de observabilidad para quien abre la herramienta entre tareas y necesita identificar patrones, ámbitos y checkpoints, y editar o borrar datos con seguridad. Debe sentirse precisa, sobria y compacta; no es un dashboard financiero. La firma son las filas de procedencia: cada checkpoint queda anclado al par real **Proyecto / Contexto**, y cada grupo de hábitos conserva su origen (**solicitudes explícitas** frente a **actividad de agentes · señal débil**).

## Dirección visual

- Tema oscuro es el predeterminado; tema claro queda disponible manualmente. Tokens fuente en `src/ui.css`: canvas `#0b1119`, superficie `#101923`, superficie elevada `#141f2b`, tinta `#dce6ed`, teal `#59d6c8`; rojo `#ed8589` solo para acciones destructivas. El claro define su propia pareja de tokens semánticos. Neutros secundarios, líneas y bordes derivan de tinta/superficie con `color-mix`.
- Profundidad por cambios mínimos de superficie y bordes finos, sin sombras dramáticas. Los contornos se mantienen discretos; teal indica foco, interacción y señal del producto, no decoración.
- Tipografía `system-ui` local para lectura compacta; `ui-monospace` para IDs y valores técnicos alineados. No cargar fuentes remotas ni dependencias.
- Ritmo en múltiplos de 4/8px, radios contenidos y cifras tabulares. Jerarquía de terminal: metadatos pequeños, encabezados precisos y densidad sin sacrificar legibilidad.
- Desktop: rail lateral del mismo canvas, dividido por una línea; contenido en canvas. Mobile: marca y anclas segmentadas en una cabecera compacta sin tapar contenido.
- Español es el idioma inicial; selector manual ES/EN. Solo traduce la interfaz, nunca los datos guardados.

## Patrones de información

- Navegación por anclas a **Patrones**, **Informes** y **Puntos guardados**, con indicador explícito de almacenamiento local.
- Los informes agrupan y ordenan conteos existentes por **Herramientas**, **Comandos** y **Actividad de agentes · señal débil**. Conservar en cada renglón la clave/señal original para distinguir solicitudes explícitas del uso observado.
- La tendencia es una gráfica SVG nativa de conteos allowlisted por día UTC, con historial móvil de 365 días. Debe indicar que empieza con la instrumentación nueva, sin fechas ni actividad fabricadas para los conteos legacy.
- El borrado de hábitos agregados se ofrece solo en la WebUI, como acción destructiva roja y confirmada; elimina acumulados y tendencia, pero no checkpoints.
- Separar **Solicitudes explícitas** de **Actividad de agentes · señal débil**, mostrando otras categorías solo si existen; no atribuir actividad observada como preferencia explícita.
- Cada ámbito conserva cantidad real, **Proyecto**, **Contexto**, resumen, fecha y acciones. Agrupar exclusivamente por el par real `(proyecto, contexto)`; no limitar ni fusionar ámbitos.
- Mantener edición, confirmaciones de borrado, estados de error/carga y acceso por teclado. Destructivo es rojo, distinto de la acción/foco teal y rotulado además de su color.

## Accesibilidad y límites

- Estructura semántica, controles etiquetados, foco visible, contraste AA, idioma del documento sincronizado y movimiento reducido; el gráfico ofrece título, descripción, leyenda y etiquetas textuales.
- No añadir dependencias, CDN, datos sintéticos, charts falsos, marca/terminología financiera ni iconografía decorativa. Las tendencias nunca contienen eventos raw, prompts, comandos literales o conversaciones.
- Componentes y breakpoints implementados: `src/App.vue` y `src/ui.css`.
