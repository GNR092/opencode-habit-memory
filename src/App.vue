<script>
import { computed, onMounted, ref, watch } from 'vue'
import { checkpointTitle, dailyTrend, groupCheckpoints, groupTodos, projectDirectoryLabel, reportGroups, trendBars } from './ui-model.js'

export default {
  setup() {
    const data = ref(null)
    const error = ref('')
    const language = ref('es')
    const theme = ref('dark')
    const busy = ref(false)
    const includeArchived = ref(false)
    const token = document.querySelector('meta[name="habit-token"]')?.content
    const t = (es, en) => language.value === 'es' ? es : en
    const scopes = computed(() => groupCheckpoints(data.value?.checkpoints ?? []))
    const todoGroups = computed(() => groupTodos(data.value?.todos ?? [], includeArchived.value))
    const todoStatuses = ['pending', 'completed', 'archived']
    const reports = computed(() => reportGroups(data.value?.habits.counts ?? {}))
    const trend = computed(() => dailyTrend(data.value?.habits.daily ?? {}))
    const bars = computed(() => trendBars(trend.value))
    const hasHabitData = computed(() => reports.value.some((group) => group.total > 0) || trend.value.length > 0)
    const kindLabel = (kind) => ({
      tool: t('Herramienta', 'Tool'),
      cli: t('Comando', 'Command'),
    }[kind] ?? '')
    const reportTitle = (key) => ({
      tools: t('Herramientas', 'Tools'),
      commands: t('Comandos', 'Commands'),
    }[key] ?? key)
    const signalLabel = (signal) => signal === 'request'
      ? t('solicitud explícita', 'explicit request')
      : t('uso observado', 'observed use')
    const todoStatusLabel = (status) => ({
      pending: t('Pendientes', 'Pending'),
      completed: t('Completados', 'Completed'),
      archived: t('Archivados', 'Archived'),
    }[status] ?? status)

    watch(language, (value) => { document.documentElement.lang = value })
    watch(theme, (value) => { document.documentElement.dataset.theme = value }, { immediate: true })

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

    function clearHabits() {
      return mutate('/api/habits/clear', { confirm: true }, t(
        '¿Borrar los conteos acumulados y tendencias de hábitos? Esta acción no se puede deshacer. Los checkpoints no se borrarán.',
        'Clear all accumulated habit counts and trends? This cannot be undone. Checkpoints will not be deleted.',
      ))
    }

    onMounted(load)
    return { data, error, language, theme, busy, includeArchived, t, scopes, todoGroups, todoStatuses, todoStatusLabel, reports, trend, bars, hasHabitData, reportTitle, signalLabel, kindLabel, checkpointTitle, projectDirectoryLabel, load, edit, removeCheckpoint, removeScope, clearHabits }
  },
}
</script>

<template>
  <div class="app-shell" id="inicio">
    <aside class="sidebar">
      <a class="brand" href="#inicio">Habit Memory</a>
      <nav class="sidebar-nav" :aria-label="t('Navegación principal', 'Main navigation')">
        <a href="#reports">{{ t('Informes', 'Reports') }}</a>
        <a href="#checkpoints">{{ t('Puntos guardados', 'Saved checkpoints') }}</a>
        <a href="#todos">{{ t('TODOs', 'TODOs') }}</a>
      </nav>
      <p class="local-note">{{ t('Tus datos permanecen en este equipo.', 'Your data stays on this machine.') }}</p>
    </aside>

    <div class="workspace">
      <header class="masthead">
        <div>
          <p class="eyebrow">{{ t('MEMORIA DE TRABAJO', 'WORKING MEMORY') }}</p>
          <h1>{{ t('Tu memoria de trabajo.', 'Your working memory.') }}</h1>
          <p class="intro">{{ t('Hábitos, puntos guardados y TODOs de este equipo.', 'Stored habits, checkpoints, and TODOs on this machine.') }}</p>
        </div>
        <div class="masthead-controls">
          <label class="language"><span>{{ t('Idioma', 'Language') }}</span>
            <select v-model="language">
              <option value="es">ES</option>
              <option value="en">EN</option>
            </select>
          </label>
          <button class="theme-toggle" type="button" :aria-pressed="theme === 'light'"
            :aria-label="theme === 'dark' ? t('Cambiar a tema claro', 'Switch to light theme') : t('Cambiar a tema oscuro', 'Switch to dark theme')"
            @click="theme = theme === 'dark' ? 'light' : 'dark'">
            {{ theme === 'dark' ? t('Claro', 'Light') : t('Oscuro', 'Dark') }}
          </button>
        </div>
      </header>

      <main>
        <p class="page-note">{{ t('Este índice contiene resúmenes, hábitos agregados y TODOs persistentes del complemento.', 'This index contains summaries, aggregate habits, and persistent TODOs saved by the plugin.') }}</p>
        <p v-if="error" class="notice" role="alert">{{ error }} <button type="button" :disabled="busy" @click="load">{{ t('Reintentar', 'Retry') }}</button></p>
        <p v-if="busy" role="status">{{ t('Guardando cambios…', 'Saving changes…') }}</p>
        <p v-if="!data && !error" role="status">{{ t('Leyendo la memoria local…', 'Reading local memory…') }}</p>
        <template v-if="data">
          <section class="stat-strip" :aria-label="t('Resumen de la memoria', 'Memory overview')">
            <article class="stat-card">
              <span>{{ t('Puntos guardados', 'Saved checkpoints') }}</span>
              <strong>{{ data.checkpoints.length }}</strong>
            </article>
          </section>

          <section id="reports" aria-labelledby="reports-heading">
            <header class="report-heading">
              <div>
                <h2 id="reports-heading">{{ t('Informes de actividad', 'Activity reports') }}</h2>
                <p class="section-note">{{ t('Conteos acumulados heredados incluidos; las tendencias empiezan con la instrumentación nueva y no reconstruyen el pasado.', 'Includes legacy accumulated counts; trends start with the new instrumentation and do not reconstruct the past.') }}</p>
              </div>
              <button type="button" class="action-delete" :disabled="busy || !hasHabitData" @click="clearHabits">{{ t('Borrar hábitos', 'Clear habits') }}</button>
            </header>
            <div class="report-grid">
              <article v-for="group in reports" :key="group.key" class="report-card">
                <header class="report-card-head">
                  <h3>{{ reportTitle(group.key) }}</h3>
                  <strong class="report-total">{{ group.total }}</strong>
                </header>
                <ol v-if="group.items.length" class="report-ranking">
                  <li v-for="item in group.items" :key="item.key">
                    <div class="report-label">
                      <span>{{ signalLabel(item.signal) }} · {{ kindLabel(item.kind) }} · {{ item.name }}</span>
                      <code>{{ item.key }}</code>
                    </div>
                    <strong>{{ item.count }}</strong>
                  </li>
                </ol>
                <p v-else class="empty-report">{{ t('Sin conteos.', 'No counts yet.') }}</p>
              </article>
            </div>

            <div class="trend-panel">
              <h3>{{ t('Tendencia diaria · UTC', 'Daily trend · UTC') }}</h3>
              <p v-if="!trend.length" class="empty-report">{{ t('Aún no hay actividad diaria. La serie comienza ahora; los conteos anteriores no tienen fecha asignada.', 'No daily activity yet. The series starts now; earlier counts have no assigned date.') }}</p>
              <template v-else>
                <p class="section-note">{{ t(`Días registrados: ${trend[0].date} – ${trend.at(-1).date}.`, `Recorded days: ${trend[0].date} – ${trend.at(-1).date}.`) }}</p>
                <ul class="trend-legend" :aria-label="t('Leyenda del gráfico', 'Chart legend')">
                  <li class="tools-series">{{ t('Herramientas', 'Tools') }}</li>
                  <li class="commands-series">{{ t('Comandos', 'Commands') }}</li>
                </ul>
                <svg class="trend-chart" viewBox="0 0 720 180" role="img" aria-labelledby="trend-title trend-desc">
                  <title id="trend-title">{{ t('Conteos diarios por categoría', 'Daily counts by category') }}</title>
                  <desc id="trend-desc">{{ t(`Gráfico de barras con ${trend.length} días registrados en UTC; no hay historial anterior a la instrumentación.`, `Bar chart with ${trend.length} recorded days in UTC; there is no history before instrumentation.`) }}</desc>
                  <line x1="28" y1="152" x2="704" y2="152" class="chart-axis" />
                  <rect v-for="bar in bars" :key="`${bar.date}-${bar.key}`" :class="`${bar.key}-series`"
                    :x="bar.x" :y="bar.y" :width="bar.width" :height="bar.height">
                    <title>{{ `${bar.date} · ${reportTitle(bar.key)}: ${bar.count}` }}</title>
                  </rect>
                  <text :x="trend.length === 1 ? 360 : 28" y="173" :text-anchor="trend.length === 1 ? 'middle' : 'start'">{{ trend[0].date }}</text>
                  <text v-if="trend.length > 1" x="704" y="173" text-anchor="end">{{ trend.at(-1).date }}</text>
                </svg>
              </template>
            </div>
          </section>

          <section id="checkpoints" aria-labelledby="checkpoints-heading">
            <h2 id="checkpoints-heading">{{ t('Puntos guardados', 'Saved checkpoints') }}</h2>
            <p v-if="!scopes.length">{{ t('No hay puntos guardados.', 'No checkpoints saved.') }}</p>
            <div v-else class="scope-list">
              <details v-for="scope in scopes" :key="scope.key" class="scope">
                <summary class="project-summary">
                  <div class="scope-provenance">
                    <span class="scope-caption">{{ t('Directorio', 'Directory') }} <strong class="scope-directory">{{ projectDirectoryLabel(scope, language) }}</strong></span>
                    <span class="scope-caption">{{ t('Proyecto', 'Project') }} · {{ scope.items.length }} {{ scope.items.length === 1 ? t('punto', 'checkpoint') : t('puntos', 'checkpoints') }}</span>
                    <code>{{ scope.project }}</code>
                  </div>
                </summary>
                <div class="project-checkpoints">
                  <div v-for="item in scope.items" :key="item.id" class="entry">
                    <div class="entry-content">
                      <h3 class="entry-title">{{ checkpointTitle(item, language) }}</h3>
                      <p class="entry-summary">{{ item.summary }}</p>
                      <p class="entry-context"><span>{{ t('Contexto', 'Context') }}</span> <code>{{ item.context }}</code></p>
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
              </details>
            </div>
          </section>

          <section id="todos" aria-labelledby="todos-heading">
            <header class="report-heading todo-heading">
              <div>
                <h2 id="todos-heading">{{ t('TODOs por proyecto', 'TODOs by project') }}</h2>
                <p class="section-note">{{ t('Tareas persistentes agrupadas por proyecto y estado.', 'Persistent tasks grouped by project and status.') }}</p>
              </div>
              <label class="include-archived">
                <input v-model="includeArchived" type="checkbox">
                <span>{{ t('Incluir archivados', 'Include archived') }}</span>
              </label>
            </header>
            <p v-if="!todoGroups.length" class="empty-report">
              {{ includeArchived ? t('No hay TODOs guardados.', 'No TODOs saved.') : t('No hay TODOs activos. Incluye los archivados para verlos.', 'No active TODOs. Include archived items to see them.') }}
            </p>
            <div v-else class="scope-list">
              <details v-for="group in todoGroups" :key="group.key" class="scope todo-project">
                <summary class="project-summary">
                  <div class="scope-provenance">
                    <span class="scope-caption">{{ t('Proyecto', 'Project') }} · {{ group.total }} {{ group.total === 1 ? t('tarea', 'task') : t('tareas', 'tasks') }}</span>
                    <code>{{ group.project }}</code>
                  </div>
                </summary>
                <div class="todo-status-list">
                  <template v-for="status in todoStatuses" :key="status">
                    <section v-if="group[status].length" class="todo-status">
                      <h3 class="todo-status-heading"><span>{{ todoStatusLabel(status) }}</span><span>{{ group[status].length }}</span></h3>
                      <ul class="todo-items">
                        <li v-for="todo in group[status]" :key="todo.id">{{ todo.task }}</li>
                      </ul>
                    </section>
                  </template>
                </div>
              </details>
            </div>
          </section>
        </template>
      </main>
    </div>
  </div>
</template>
