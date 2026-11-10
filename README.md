# Habit Memory

Plugin local de OpenCode para guardar hábitos agregados, checkpoints y TODOs vinculados a proyectos. No conserva el texto de las conversaciones ni de los prompts.

## Instalación

Requiere Node.js 20 o posterior. Desde el directorio del proyecto:

```sh
npm ci
npm run build
```

Añade la ruta del proyecto a `plugins` en la configuración de OpenCode:

```json
{
  "plugins": ["/ruta/absoluta/al/habit-memory-plugin"]
}
```

Los datos se guardan en `$XDG_DATA_HOME/habit-memory-plugin/store-v1.json`; si `XDG_DATA_HOME` no está definido, se usa `~/.local/share/habit-memory-plugin/store-v1.json`.

## WebUI

La interfaz local tiene vistas separadas para informes, checkpoints y TODOs por proyecto; los grupos muestran el directorio cuando se conoce. Se actualiza en vivo cuando cambia el store local, sin recargar la página. En OpenCode, `/habit-memory-ui` la inicia y muestra su dirección; `/habit-memory-ui-stop` la detiene. También se puede iniciar desde el proyecto con:

```sh
npm run ui
```

El puerto predeterminado es `43109`; se puede cambiar con `HABIT_MEMORY_UI_PORT`.

## Pruebas

```sh
npm test
```

Para configurar el servidor MCP local en clientes compatibles, consulta [`docs/mcp-setup.md`](docs/mcp-setup.md).
