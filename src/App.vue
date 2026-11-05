<script>
import { computed, onMounted, ref, watch } from 'vue'
import { groupCheckpoints, groupPatterns } from './ui-model.js'

export default {
  setup() {
    const data = ref(null)
    const error = ref('')
    const language = ref('es')
    const busy = ref(false)
    const token = document.querySelector('meta[name="habit-token"]')?.content
    const t = (es, en) => language.value === 'es' ? es : en
    const scopes = computed(() => groupCheckpoints(data.value?.checkpoints ?? []))
    const patterns = computed(() => groupPatterns(data.value?.habits.counts ?? {}))
    const patternSections = computed(() => [
      { key: 'requests', title: t('Solicitudes explícitas', 'Explicit requests'), items: patterns.value.requests },
      { key: 'activity', title: t('Actividad de agentes · señal débil', 'Agent activity · weak signal'), items: patterns.value.activity },
      { key: 'other', title: t('Otras categorías', 'Other categories'), items: patterns.value.other },
    ].filter((section) => section.items.length))
    const kindLabel = (kind) => ({
      tool: t('Herramienta', 'Tool'),
      cli: t('Comando', 'Command'),
      agent: t('Agente', 'Agent'),
    }[kind] ?? '')

    watch(language, (value) => { document.documentElement.lang = value })

    async function request(path, body) {
      const response = await fetch(path, {
        method: body ? 'POST' : 'GET',
        cache: 'no-store',
        headers: body ? { 'content-type': 'application/json', origin: location.origin, 'x-habit-token': token } : {},
        body: body && JSON.stringify(body),
      })
      if (!response.ok) throw new Error(`${t('El servidor local rechazó la solicitud', 'The local server rejected the request')} (${response.status}).`)
      return body ? null : response.json()
    }

    async function load() {
      try { data.value = await request('/api/data'); error.value = '' } catch (e) { error.value = e.message }
    }

    async function mutate(path, body, confirmText) {
      if (busy.value || (confirmText && !confirm(confirmText))) return
      busy.value = true
      error.value = ''
      try { await request(path, body); await load() } catch (e) { error.value = e.message } finally { busy.value = false }
    }

    async function edit(item) {
      if (busy.value) return
      const summary = prompt(t('Resumen del punto guardado', 'Checkpoint summary'), item.summary)
      if (summary === null) return
      if (!summary.trim() || summary.length > 240) { error.value = t('Escribe entre 1 y 240 caracteres.', 'Enter 1–240 characters.'); return }
      await mutate('/api/checkpoint/edit', { project: item.project, context: item.context, id: item.id, summary })
    }

    function removeCheckpoint(item) {
      return mutate('/api/checkpoint/delete', { project: item.project, context: item.context, id: item.id },
        t('¿Eliminar este punto guardado?', 'Delete this checkpoint?'))
    }

    function removeScope(scope) {
      const message = t(
        `¿Eliminar todos los puntos de este contexto (${scope.items.length})?\nProyecto: ${JSON.stringify(scope.project)}\nContexto: ${JSON.stringify(scope.context)}`,
        `Delete all checkpoints in this context (${scope.items.length})?\nProject: ${JSON.stringify(scope.project)}\nContext: ${JSON.stringify(scope.context)}`,
      )
      return mutate('/api/scope/delete', { project: scope.project, context: scope.context }, message)
    }

    onMounted(load)
    return { data, error, language, busy, t, scopes, patternSections, kindLabel, load, edit, removeCheckpoint, removeScope }
  },
}
</script>

<template>
  <header class="masthead">
    <p class="eyebrow">HABIT MEMORY · {{ t('SOLO LOCAL', 'LOCAL ONLY') }}</p>
    <h1>{{ t('Tu memoria de trabajo.', 'Your working memory.') }}</h1>
    <p class="intro">{{ t('Hábitos y puntos guardados en este equipo.', 'Stored habits and checkpoints, on this machine.') }}</p>
    <label class="language">{{ t('Idioma', 'Language') }}
      <select v-model="language">
        <option value="es">Español</option>
        <option value="en">English</option>
      </select>
    </label>
  </header>

  <main>
    <p class="intro">{{ t('Este índice contiene solo resúmenes y hábitos agregados guardados por el complemento.', 'This index contains only summaries and aggregate habits saved by the plugin.') }}</p>
    <p v-if="error" class="notice" role="alert">{{ error }} <button type="button" :disabled="busy" @click="load">{{ t('Reintentar', 'Retry') }}</button></p>
    <p v-if="busy" role="status">{{ t('Guardando cambios…', 'Saving changes…') }}</p>
    <p v-if="!data && !error" role="status">{{ t('Leyendo la memoria local…', 'Reading local memory…') }}</p>
    <template v-if="data">
      <p class="totals">{{ Object.keys(data.habits.counts).length }} {{ t('patrones', 'patterns') }} · {{ data.checkpoints.length }} {{ t('puntos guardados', 'checkpoints') }}</p>

      <section aria-labelledby="patterns-heading">
        <h2 id="patterns-heading">{{ t('Patrones observados', 'Patterns observed') }}</h2>
        <p class="section-note">{{ t('Conteos agregados; la actividad de agentes es una señal débil.', 'Aggregate counts; agent activity is a weak signal.') }}</p>
        <p v-if="!patternSections.length">{{ t('Aún no hay patrones registrados.', 'No patterns recorded yet.') }}</p>
        <div v-else class="pattern-sections">
          <section v-for="section in patternSections" :key="section.key" class="pattern-section">
            <h3>{{ section.title }}</h3>
            <ul class="pattern-list">
              <li v-for="pattern in section.items" :key="pattern.key" class="habit">
                <div class="habit-label">
                  <span>{{ pattern.kind ? `${kindLabel(pattern.kind)} · ${pattern.name}` : pattern.key }}</span>
                  <code v-if="pattern.kind">{{ pattern.key }}</code>
                </div>
                <div class="habit-count"><strong>{{ pattern.count }}</strong> {{ pattern.count === 1 ? t('vez', 'time') : t('veces', 'times') }}</div>
              </li>
            </ul>
          </section>
        </div>
      </section>

      <section aria-labelledby="checkpoints-heading">
        <h2 id="checkpoints-heading">{{ t('Puntos guardados', 'Saved checkpoints') }}</h2>
        <p v-if="!scopes.length">{{ t('No hay puntos guardados.', 'No checkpoints saved.') }}</p>
        <div v-else class="scope-list">
          <article v-for="scope in scopes" :key="scope.key" class="scope">
            <header class="scope-head">
              <div class="scope-provenance">
                <p class="scope-caption">{{ t('Ámbito', 'Scope') }} · {{ scope.items.length }} {{ scope.items.length === 1 ? t('punto', 'checkpoint') : t('puntos', 'checkpoints') }}</p>
                <dl class="scope-identifiers">
                  <div><dt>{{ t('Proyecto', 'Project') }}</dt><dd><code>{{ scope.project }}</code></dd></div>
                  <div><dt>{{ t('Contexto', 'Context') }}</dt><dd><code>{{ scope.context }}</code></dd></div>
                </dl>
              </div>
              <button type="button" class="action-delete scope-delete" :disabled="busy"
                :aria-label="`${t('Eliminar contexto. Proyecto:', 'Delete context. Project:')} ${JSON.stringify(scope.project)}. ${t('Contexto:', 'Context:')} ${JSON.stringify(scope.context)}`"
                @click="removeScope(scope)">{{ t('Eliminar contexto', 'Delete context') }}</button>
            </header>
            <div class="entry-list">
              <div v-for="item in scope.items" :key="item.id" class="entry">
                <div class="entry-content">
                  <p class="entry-summary">{{ item.summary }}</p>
                  <time :datetime="item.createdAt">{{ new Date(item.createdAt).toLocaleString(language) }}</time>
                </div>
                <div class="entry-actions">
                  <button type="button" class="action-edit" :disabled="busy"
                    :aria-label="`${t('Editar punto guardado', 'Edit checkpoint')}: ${item.summary}`"
                    @click="edit(item)">{{ t('Editar', 'Edit') }}</button>
                  <button type="button" class="action-delete" :disabled="busy"
                    :aria-label="`${t('Eliminar punto guardado', 'Delete checkpoint')}: ${item.summary}`"
                    @click="removeCheckpoint(item)">{{ t('Eliminar', 'Delete') }}</button>
                </div>
              </div>
            </div>
          </article>
        </div>
      </section>
    </template>
  </main>
</template>
