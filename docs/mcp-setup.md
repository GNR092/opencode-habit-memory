# Uso interoperable

El plugin de OpenCode conserva sus hooks; sus hábitos y checkpoints se guardan en JSON bajo `$XDG_DATA_HOME/habit-memory-plugin/store-v1.json` (fallback `~/.local/share/habit-memory-plugin/store-v1.json`). Puede configurarse el mismo MCP local por stdio en clientes compatibles:

```json
{
  "mcpServers": {
    "habit-memory": {
      "command": "node",
      "args": ["/ruta/absoluta/al/plugin/src/mcp.js"]
    }
  }
}
```

En Claude Code puede añadirse con `claude mcp add --transport stdio habit-memory -- node /ruta/absoluta/al/plugin/src/mcp.js`. Para Antigravity, coloca la misma entrada bajo `mcpServers` en `.agents/mcp_config.json` del workspace. OpenCode usa una entrada local como esta dentro de `mcp` en una configuración de proyecto `opencode.json` (no se modifica ninguna configuración automáticamente):

```json
{
  "mcp": {
    "habit-memory": {
      "type": "local",
      "command": ["node", "/ruta/absoluta/al/plugin/src/mcp.js"],
      "enabled": true
    }
  }
}
```

Herramientas: `habit_memory_get`, `checkpoint_projects`, `checkpoint_contexts`, `checkpoint_list`, `checkpoint_save`, `checkpoint_delete` y `checkpoint_clear` (requiere `confirm: true`). El borrado de hábitos agregados solo está disponible en la WebUI local; no existe una herramienta MCP ni un comando para esa acción. Usa `checkpoint_projects` para obtener el hash de proyecto y `checkpoint_contexts` para descubrir contextos existentes, incluidos los scopes de sesión OpenCode. Las herramientas MCP admiten cualquier contexto neutral explícito para compartirlo entre clientes. Los clientes deben usar el mismo directorio XDG de datos. El store admite hasta 10 000 checkpoints y 2 MB en total. Los hábitos guardan únicamente categorías allowlisted: el acumulado por categoría se conserva hasta 999 y la serie nueva conserva buckets UTC de los últimos 365 días. El historial de tendencias empieza con la nueva instrumentación; no se asignan fechas retroactivas a conteos legacy. No se aceptan ni almacenan campos de conversación. La importación legacy lee únicamente `profile-v1` al iniciar y la clave explícita del checkpoint una vez por proyecto conocido, sin eliminar el origen.

Fuentes de configuración consultadas: [Claude Code MCP](https://code.claude.com/docs/en/mcp), [Antigravity MCP](https://www.antigravity.google/docs/mcp), [OpenCode MCP](https://opencode.ai/docs/mcp-servers/), [MCP TypeScript SDK stdio](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.html). El servidor implementa el intercambio MCP básico por stdio directamente, sin dependencia SDK. **No se ejecutó ni verificó en vivo en Claude Code, Antigravity u OpenCode**; las entradas anteriores son ejemplos de configuración documentada.
