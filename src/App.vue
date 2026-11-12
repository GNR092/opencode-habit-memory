<script>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { checkpointTitle, dailyTrend, groupCheckpoints, groupTodos, metricsRange, projectDirectoryLabel, reportGroups, sortMetricRows, tokenBars, trendBars } from './ui-model.js'
import { viewFromHash, watchHashView } from './ui-navigation.js'

export default {
  setup() {
    const data = ref(null)
    const error = ref('')
    const language = ref('es')
    const theme = ref('dark')
    const activeView = ref(viewFromHash(window.location.hash))
    const busy = ref(false)
    const includeArchived = ref(false)
    const metrics = ref(null)
    const metricsError = ref('')
    const metricsLoading = ref(false)
    const rangeDays = ref(30)
    const metricProject = ref('')
    const metricAgent = ref('')
    const metricProvider = ref('')
    const metricModel = ref('')
    const metricOptions = ref({ projects: [], agents: [], providers: [], models: [] })
    const token = document.querySelector('meta[name="habit-token"]')?.content
    const t = (es, en) => language.value === 'es' ? es : en
    const numberFormat = computed(() => new Intl.NumberFormat(language.value, { maximumFractionDigits: 0 }))
    const decimalFormat = computed(() => new Intl.NumberFormat(language.value, { maximumFractionDigits: 1 }))
    const compactFormat = computed(() => new Intl.NumberFormat(language.value, { notation: 'compact', maximumFractionDigits: 1 }))
    const percentFormat = computed(() => new Intl.NumberFormat(language.value, { style: 'percent', maximumFractionDigits: 1 }))
    const formatNumber = (value) => numberFormat.value.format(Number(value) || 0)
    const formatCompact = (value) => compactFormat.value.format(Number(value) || 0)
    const formatPercent = (value) => percentFormat.value.format(Number(value) || 0)
    const tokenBreakdown = (row) => {
      const tokens = row?.tokens ?? {}
      return [
        `${t('entrada', 'input')} ${formatCompact(tokens.input)}`,
        `${t('caché', 'cache')} ${formatCompact(tokens.cacheRead)}`,
        `${t('salida', 'output')} ${formatCompact(tokens.output)}`,
        `${t('raz.', 'reason.')} ${formatCompact(tokens.reasoning)}`,
      ].join(' · ')
    }
    const seriesLabel = (key) => ({
      input: t('Entrada sin caché', 'Uncached input'),
      cache: t('Caché leída', 'Cache read'),
      output: t('Salida', 'Output'),
    }[key] ?? key)
    const metricKindLabel = (kind) => ({
      primary: t('Principal', 'Primary'),
      subagent: t('Subagente', 'Subagent'),
      title: t('Título', 'Title'),
      compaction: t('Compactación', 'Compaction'),
      generate: t('Generación', 'Generate'),
      other: t('Otro', 'Other'),
    }[kind] ?? kind)
    const projectOptionLabel = (project) => project.directory || project.key
    const metricsEmpty = computed(() => Boolean(metrics.value) && metrics.value.totals?.steps === 0)
    const hasMetricFilters = computed(() => Boolean(metricProject.value || metricAgent.value || metricProvider.value || metricModel.value))
    const tokenChart = computed(() => tokenBars(metrics.value?.series ?? []))
    const firstMetricDay = computed(() => metrics.value?.series?.[0]?.day ?? '')
    const lastMetricDay = computed(() => metrics.value?.series?.at(-1)?.day ?? '')
    const cacheDenominator = computed(() => {
      const tokens = metrics.value?.totals?.tokens
      return tokens ? tokens.input + tokens.cacheRead + tokens.cacheWrite : 0
    })
    const sortTables = ['agent', 'model', 'project', 'kind']
    const sortState = ref(Object.fromEntries(sortTables.map((table) => [table, { key: 'steps', direction: 'desc' }])))
    const sortRows = (table, rows, nameOf = (row) => row?.key ?? '') => sortMetricRows(
      rows.map((row) => ({ ...row, name: nameOf(row) })),
      sortState.value[table].key,
      sortState.value[table].direction,
    )
    const agentRows = computed(() => sortRows('agent', metrics.value?.byAgent ?? []))
    const modelRows = computed(() => sortRows('model', metrics.value?.byModel ?? [], (row) => `${row.key ?? ''} ${row.provider ?? ''}`))
    const projectRows = computed(() => sortRows('project', metrics.value?.byProject ?? [], (row) => row.directory || row.key || ''))
    const kindRows = computed(() => sortRows('kind', metrics.value?.byKind ?? [], (row) => metricKindLabel(row.key)))
    function toggleSort(table, key) {
      const state = sortState.value[table]
      state.direction = state.key === key ? (state.direction === 'asc' ? 'desc' : 'asc') : (key === 'name' ? 'asc' : 'desc')
      state.key = key
    }
    const ariaSort = (table, key) => sortState.value[table].key !== key
      ? 'none'
      : sortState.value[table].direction === 'asc' ? 'ascending' : 'descending'
    const sortIndicator = (table, key) => sortState.value[table].key !== key
      ? ''
      : sortState.value[table].direction === 'asc' ? '↑' : '↓'
    const plugin = computed(() => metrics.value?.plugin ?? null)
    const pluginHooks = computed(() => Object.entries(plugin.value?.hooks ?? {}).map(([name, hook]) => ({
      name,
      invocations: Number(hook?.invocations) || 0,
      errors: Number(hook?.errors) || 0,
      p50: hook?.latency?.p50 ?? null,
      p95: hook?.latency?.p95 ?? null,
    })))
    const pluginErrors = computed(() => ["hooks", "store", "server", "collector"].map((key) => ({ key, count: Number(plugin.value?.errors?.[key]) || 0 })))
    const pluginHookCalls = computed(() => pluginHooks.value.reduce((sum, hook) => sum + hook.invocations, 0))
    const pluginHookErrors = computed(() => pluginHooks.value.reduce((sum, hook) => sum + hook.errors, 0))
    const pluginErrorTotal = computed(() => pluginErrors.value.reduce((sum, error) => sum + error.count, 0))
    const pluginCurrent = computed(() => plugin.value?.current ?? null)
    const pluginEmpty = computed(() => {
      const value = plugin.value
      if (!value) return true
      const hooks = Object.values(value.hooks ?? {}).some((hook) => (Number(hook?.invocations) || 0) > 0 || (Number(hook?.errors) || 0) > 0)
      const storage = (Number(value.store?.reads) || 0) + (Number(value.store?.writes) || 0) + (Number(value.store?.errors) || 0)
      const sse = (Number(value.sse?.clients) || 0) + (Number(value.sse?.peakClients) || 0) + (Number(value.sse?.refreshes) || 0)
      const requests = ["2xx", "4xx", "5xx"].some((key) => (Number(value.requests?.[key]) || 0) > 0)
      const context = (Number(value.context?.injections) || 0) + (Number(value.context?.injectedChars) || 0) + (Number(value.context?.notices?.checkpoint) || 0) + (Number(value.context?.notices?.todo) || 0)
      const current = value.current && Object.values(value.current).some((count) => (Number(count) || 0) > 0)
      const errors = (Number(value.errors?.hooks) || 0) + (Number(value.errors?.store) || 0) + (Number(value.errors?.server) || 0) + (Number(value.errors?.collector) || 0)
      const flush = (Number(value.flush?.failures) || 0) + (Number(value.flush?.pending) || 0)
      return !hooks && !storage && !sse && !requests && !context && !current && !errors && !flush
    })
    const formatMillis = (value) => value === null || value === undefined ? '—' : `${formatNumber(value)} ms`
    const formatBytes = (value) => {
      if (value === null || value === undefined) return '—'
      const bytes = Number(value)
      if (!Number.isFinite(bytes) || bytes < 0) return '—'
      if (bytes < 1024) return `${formatNumber(bytes)} B`
      if (bytes < 1024 * 1024) return `${decimalFormat.value.format(bytes / 1024)} KB`
      return `${decimalFormat.value.format(bytes / (1024 * 1024))} MB`
    }
    const formatTime = (value) => {
      if (!value) return '—'
      const date = new Date(value)
      return Number.isFinite(date.getTime()) ? date.toLocaleTimeString(language.value) : '—'
    }
    const pluginHookLabel = (name) => ({
      "session.prompt": t('Prompt de sesión', 'Session prompt'),
      "session.context": t('Contexto de sesión', 'Session context'),
      "tool.execute.after": t('Después de herramienta', 'After tool'),
      "shell.create.before": t('Antes de shell', 'Before shell'),
    }[name] ?? name)
    const pluginErrorLabel = (key) => ({
      hooks: t('Hooks', 'Hooks'),
      store: t('Almacenamiento', 'Storage'),
      server: t('Servidor', 'Server'),
      collector: t('Colector', 'Collector'),
    }[key] ?? key)
    const scopes = computed(() => groupCheckpoints(data.value?.checkpoints ?? []))
    const projectDirectories = computed(() => new Map(scopes.value.map(({ project, directoryName }) => [project, directoryName])))
    const todoGroups = computed(() => groupTodos(data.value?.todos ?? [], includeArchived.value, projectDirectories.value))
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
    watch([rangeDays, metricProject, metricAgent, metricProvider, metricModel], loadMetrics)

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

    function mergeMetricOptions(result) {
      const current = metricOptions.value
      const projects = new Map(current.projects.map((project) => [project.key, project]))
      for (const row of result?.byProject ?? []) if (row?.key) projects.set(row.key, { key: row.key, directory: row.directory || '' })
      const agents = new Set(current.agents)
      for (const row of result?.byAgent ?? []) if (row?.key) agents.add(row.key)
      const providers = new Set(current.providers)
      const models = new Set(current.models)
      for (const row of result?.byModel ?? []) {
        if (row?.key) models.add(row.key)
        if (row?.provider) providers.add(row.provider)
      }
      metricOptions.value = {
        projects: [...projects.values()].sort((a, b) => (a.directory || a.key).localeCompare(b.directory || b.key)),
        agents: [...agents].sort((a, b) => a.localeCompare(b)),
        providers: [...providers].sort((a, b) => a.localeCompare(b)),
        models: [...models].sort((a, b) => a.localeCompare(b)),
      }
    }

    let metricsRequest = 0
    async function loadMetrics() {
      const requestId = ++metricsRequest
      metricsLoading.value = true
      metricsError.value = ''
      try {
        const { from, to } = metricsRange(rangeDays.value)
        const params = new URLSearchParams({ from, to })
        if (metricProject.value) params.set('project', metricProject.value)
        if (metricAgent.value) params.set('agent', metricAgent.value)
        if (metricProvider.value) params.set('provider', metricProvider.value)
        if (metricModel.value) params.set('model', metricModel.value)
        const result = await request(`/api/metrics?${params}`)
        if (requestId !== metricsRequest) return
        metrics.value = result
        mergeMetricOptions(result)
      } catch (e) {
        if (requestId === metricsRequest) metricsError.value = e.message
      } finally {
        if (requestId === metricsRequest) metricsLoading.value = false
      }
    }

    function clearMetricFilters() {
      metricProject.value = ''
      metricAgent.value = ''
      metricProvider.value = ''
      metricModel.value = ''
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

    let stopWatchingHash = () => {}
    let eventSource, refreshTimer
    const refreshOnVisible = () => { if (!document.hidden) { load(); loadMetrics() } }
    onMounted(() => {
      stopWatchingHash = watchHashView(window, (view) => {
        activeView.value = view
        window.scrollTo(0, 0)
      })
      load()
      loadMetrics()
      if (typeof EventSource === 'function') {
        eventSource = new EventSource('/api/events')
        eventSource.onmessage = () => {
          clearTimeout(refreshTimer)
          refreshTimer = setTimeout(() => { load(); loadMetrics() }, 150)
        }
      }
      document.addEventListener('visibilitychange', refreshOnVisible)
    })
    onBeforeUnmount(() => {
      stopWatchingHash()
      eventSource?.close()
      clearTimeout(refreshTimer)
      metricsRequest++
      document.removeEventListener('visibilitychange', refreshOnVisible)
    })
    return { data, error, language, theme, activeView, busy, includeArchived, t, scopes, todoGroups, todoStatuses, todoStatusLabel, reports, trend, bars, hasHabitData, reportTitle, signalLabel, kindLabel, checkpointTitle, projectDirectoryLabel, load, edit, removeCheckpoint, removeScope, clearHabits, metrics, metricsError, metricsLoading, rangeDays, metricProject, metricAgent, metricProvider, metricModel, metricOptions, metricsEmpty, hasMetricFilters, tokenChart, firstMetricDay, lastMetricDay, cacheDenominator, formatNumber, formatCompact, formatPercent, tokenBreakdown, agentRows, modelRows, projectRows, kindRows, toggleSort, ariaSort, sortIndicator, seriesLabel, metricKindLabel, projectOptionLabel, clearMetricFilters, loadMetrics, plugin, pluginHooks, pluginErrors, pluginHookCalls, pluginHookErrors, pluginErrorTotal, pluginCurrent, pluginEmpty, formatMillis, formatBytes, formatTime, pluginHookLabel, pluginErrorLabel }
  },
}
</script>

<template>
  <div class="app-shell" id="inicio">
    <aside class="sidebar">
      <a class="brand" href="#reports">Habit Memory</a>
      <nav class="sidebar-nav" :aria-label="t('Navegación principal', 'Main navigation')">
        <a href="#reports" :aria-current="activeView === 'reports' ? 'page' : undefined">{{ t('Informes', 'Reports') }}</a>
        <a href="#checkpoints" :aria-current="activeView === 'checkpoints' ? 'page' : undefined">{{ t('Puntos guardados', 'Saved checkpoints') }}</a>
        <a href="#todos" :aria-current="activeView === 'todos' ? 'page' : undefined">{{ t('TODOs', 'TODOs') }}</a>
        <a href="#metrics" :aria-current="activeView === 'metrics' ? 'page' : undefined">{{ t('Métricas', 'Metrics') }}</a>
      </nav>
      <p class="local-note">{{ t('Tus datos permanecen en este equipo.', 'Your data stays on this machine.') }}</p>
    </aside>

    <div class="workspace">
      <header class="masthead">
        <div>
          <p class="eyebrow">{{ t('MEMORIA DE TRABAJO', 'WORKING MEMORY') }}</p>
          <h1>{{ t('Tu memoria de trabajo.', 'Your working memory.') }}</h1>
          <p class="intro">{{ t('Hábitos, puntos guardados, TODOs y métricas de uso de este equipo.', 'Stored habits, checkpoints, TODOs, and usage metrics on this machine.') }}</p>
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
        <p class="page-note">{{ t('Este índice contiene resúmenes, hábitos agregados, TODOs persistentes y métricas locales del complemento.', 'This index contains summaries, aggregate habits, persistent TODOs, and local metrics saved by the plugin.') }}</p>
        <p v-if="error" class="notice" role="alert">{{ error }} <button type="button" :disabled="busy" @click="load">{{ t('Reintentar', 'Retry') }}</button></p>
        <p v-if="busy" role="status">{{ t('Guardando cambios…', 'Saving changes…') }}</p>
        <p v-if="!data && !error" role="status">{{ t('Leyendo la memoria local…', 'Reading local memory…') }}</p>
        <template v-if="data">
          <section id="reports" v-show="activeView === 'reports'" aria-labelledby="reports-heading">
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

          <section id="checkpoints" v-show="activeView === 'checkpoints'" aria-labelledby="checkpoints-heading">
            <h2 id="checkpoints-heading">{{ t('Puntos guardados', 'Saved checkpoints') }}</h2>
            <section class="stat-strip checkpoint-summary" :aria-label="t('Resumen de la memoria', 'Memory overview')">
              <article class="stat-card">
                <span>{{ t('Puntos guardados', 'Saved checkpoints') }}</span>
                <strong>{{ data.checkpoints.length }}</strong>
              </article>
            </section>
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

          <section id="todos" v-show="activeView === 'todos'" aria-labelledby="todos-heading">
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
                    <span class="scope-caption">{{ t('Directorio', 'Directory') }} <strong class="scope-directory">{{ projectDirectoryLabel(group, language) }}</strong></span>
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

        <section id="metrics" v-show="activeView === 'metrics'" aria-labelledby="metrics-heading" :aria-busy="metricsLoading">
          <header class="report-heading">
            <div>
              <h2 id="metrics-heading">{{ t('Métricas de uso', 'Usage metrics') }}</h2>
              <p class="section-note">{{ t('Tokens y caché por agente, modelo y proyecto, medidos a partir del uso reportado por el runtime.', 'Tokens and cache by agent, model, and project, measured from usage reported by the runtime.') }}</p>
            </div>
          </header>

          <fieldset class="metrics-filters">
            <legend>{{ t('Filtros', 'Filters') }}</legend>
            <label class="metrics-filter">
              <span>{{ t('Rango', 'Range') }}</span>
              <select v-model.number="rangeDays">
                <option :value="7">{{ t('7 días', '7 days') }}</option>
                <option :value="30">{{ t('30 días', '30 days') }}</option>
                <option :value="90">{{ t('90 días', '90 days') }}</option>
              </select>
            </label>
            <label class="metrics-filter">
              <span>{{ t('Proyecto', 'Project') }}</span>
              <select v-model="metricProject">
                <option value="">{{ t('Todos los proyectos', 'All projects') }}</option>
                <option v-for="project in metricOptions.projects" :key="project.key" :value="project.key">{{ projectOptionLabel(project) }}</option>
              </select>
            </label>
            <label class="metrics-filter">
              <span>{{ t('Agente', 'Agent') }}</span>
              <select v-model="metricAgent">
                <option value="">{{ t('Todos los agentes', 'All agents') }}</option>
                <option v-for="agent in metricOptions.agents" :key="agent" :value="agent">{{ agent }}</option>
              </select>
            </label>
            <label class="metrics-filter">
              <span>{{ t('Proveedor', 'Provider') }}</span>
              <select v-model="metricProvider">
                <option value="">{{ t('Todos los proveedores', 'All providers') }}</option>
                <option v-for="provider in metricOptions.providers" :key="provider" :value="provider">{{ provider }}</option>
              </select>
            </label>
            <label class="metrics-filter">
              <span>{{ t('Modelo', 'Model') }}</span>
              <select v-model="metricModel">
                <option value="">{{ t('Todos los modelos', 'All models') }}</option>
                <option v-for="model in metricOptions.models" :key="model" :value="model">{{ model }}</option>
              </select>
            </label>
            <button type="button" class="metrics-reset" :disabled="!hasMetricFilters" @click="clearMetricFilters">{{ t('Limpiar filtros', 'Clear filters') }}</button>
          </fieldset>

          <p v-if="metricsError" class="notice" role="alert">{{ metricsError }} <button type="button" @click="loadMetrics">{{ t('Reintentar', 'Retry') }}</button></p>
          <p v-if="metricsLoading" role="status">{{ t('Leyendo métricas…', 'Reading metrics…') }}</p>
          <p v-else-if="metricsEmpty && !metricsError" class="empty-report metrics-empty">{{ t('La instrumentación empieza ahora. Aún no hay pasos registrados en este rango; el backfill aproximado puede tardar unos segundos.', 'Instrumentation starts now. No steps recorded in this range yet; approximate backfill may take a few seconds.') }}</p>

          <template v-if="metrics && !metricsEmpty">
            <div class="metrics-cards">
              <article class="metric-card"><span>{{ t('Pasos', 'Steps') }}</span><strong>{{ formatNumber(metrics.totals.steps) }}</strong><small>{{ t('registrados en el rango', 'recorded in range') }}</small></article>
              <article class="metric-card"><span>{{ t('Entrada sin caché', 'Uncached input') }}</span><strong>{{ formatCompact(metrics.totals.tokens.input) }}</strong><small>{{ t('tokens de entrada', 'input tokens') }}</small></article>
              <article class="metric-card"><span>{{ t('Caché leída', 'Cache read') }}</span><strong>{{ formatCompact(metrics.totals.tokens.cacheRead) }}</strong><small>{{ t('tokens reutilizados', 'reused tokens') }}</small></article>
              <article class="metric-card"><span>{{ t('Salida', 'Output') }}</span><strong>{{ formatCompact(metrics.totals.tokens.output) }}</strong><small>{{ t('tokens generados', 'generated tokens') }}</small></article>
              <article class="metric-card"><span>{{ t('Razonamiento', 'Reasoning') }}</span><strong>{{ formatCompact(metrics.totals.tokens.reasoning) }}</strong><small>{{ t('tokens de razonamiento', 'reasoning tokens') }}</small></article>
            </div>

            <article class="savings-panel">
              <div>
                <h3>{{ t('Ahorro medido por caché', 'Measured cache savings') }}</h3>
                <p class="section-note">{{ t(`cacheRead / (input + cacheRead + cacheWrite) = ${formatPercent(metrics.totals.cacheHitRate)}. Medición exacta de tokens reutilizados.`, `cacheRead / (input + cacheRead + cacheWrite) = ${formatPercent(metrics.totals.cacheHitRate)}. Exact measurement of reused tokens.`) }}</p>
              </div>
              <strong class="savings-rate">{{ formatPercent(metrics.totals.cacheHitRate) }}</strong>
              <p class="savings-detail">{{ formatCompact(metrics.totals.tokens.cacheRead) }} / {{ formatCompact(cacheDenominator) }} {{ t('tokens de entrada reutilizados', 'input tokens reused') }}</p>
            </article>

            <div class="metrics-charts">
              <article class="trend-panel">
                <h3>{{ t('Tokens por día · UTC', 'Tokens per day · UTC') }}</h3>
                <ul class="trend-legend" :aria-label="t('Leyenda del gráfico de tokens', 'Token chart legend')">
                  <li class="input-series">{{ seriesLabel('input') }}</li>
                  <li class="cache-series">{{ seriesLabel('cache') }}</li>
                  <li class="output-series">{{ seriesLabel('output') }}</li>
                </ul>
                <p v-if="!tokenChart.length" class="empty-report">{{ t('Sin tokens registrados en este rango.', 'No tokens recorded in this range.') }}</p>
                <template v-else>
                  <p class="section-note">{{ t(`Días: ${firstMetricDay} – ${lastMetricDay}.`, `Days: ${firstMetricDay} – ${lastMetricDay}.`) }}</p>
                  <svg class="trend-chart metrics-chart" viewBox="0 0 720 180" role="img" aria-labelledby="metrics-tokens-title metrics-tokens-desc">
                    <title id="metrics-tokens-title">{{ t('Tokens diarios por serie', 'Daily tokens by series') }}</title>
                    <desc id="metrics-tokens-desc">{{ t(`Barras apiladas de entrada sin caché, caché leída y salida para ${metrics.series.length} días UTC.`, `Stacked bars of uncached input, cache read, and output for ${metrics.series.length} UTC days.`) }}</desc>
                    <line x1="28" y1="152" x2="704" y2="152" class="chart-axis" />
                    <rect v-for="bar in tokenChart" :key="`${bar.day}-${bar.key}`" :class="`${bar.key}-series`"
                      :x="bar.x" :y="bar.y" :width="bar.width" :height="bar.height">
                      <title>{{ `${bar.day} · ${seriesLabel(bar.key)}: ${formatNumber(bar.value)}` }}</title>
                    </rect>
                    <text :x="metrics.series.length === 1 ? 366 : 28" y="173" :text-anchor="metrics.series.length === 1 ? 'middle' : 'start'">{{ firstMetricDay }}</text>
                    <text v-if="metrics.series.length > 1" x="704" y="173" text-anchor="end">{{ lastMetricDay }}</text>
                  </svg>
                </template>
              </article>

            </div>

            <p class="section-note metrics-tables-note">{{ t('Máximo 50 filas por dimensión. Ordena por nombre, pasos o tokens desde las cabeceras.', 'Up to 50 rows per dimension. Sort by name, steps, or tokens from the column headers.') }}</p>
            <div class="metrics-tables">
              <article class="metrics-table-panel">
                <table class="metrics-table">
                  <caption>{{ t('Por agente', 'By agent') }}</caption>
                  <thead><tr>
                    <th scope="col" :aria-sort="ariaSort('agent', 'name')">
                      <button type="button" class="sort-button" @click="toggleSort('agent', 'name')">{{ t('Agente', 'Agent') }}<span v-if="sortIndicator('agent', 'name')" class="sort-indicator" aria-hidden="true">{{ sortIndicator('agent', 'name') }}</span></button>
                    </th>
                    <th scope="col" :aria-sort="ariaSort('agent', 'steps')">
                      <button type="button" class="sort-button" @click="toggleSort('agent', 'steps')">{{ t('Pasos', 'Steps') }}<span v-if="sortIndicator('agent', 'steps')" class="sort-indicator" aria-hidden="true">{{ sortIndicator('agent', 'steps') }}</span></button>
                    </th>
                    <th scope="col" :aria-sort="ariaSort('agent', 'tokens')">
                      <button type="button" class="sort-button" @click="toggleSort('agent', 'tokens')">{{ t('Tokens', 'Tokens') }}<span v-if="sortIndicator('agent', 'tokens')" class="sort-indicator" aria-hidden="true">{{ sortIndicator('agent', 'tokens') }}</span></button>
                    </th>
                  </tr></thead>
                  <tbody>
                    <tr v-for="row in agentRows" :key="row.key ?? 'none'">
                      <th scope="row">{{ row.key || t('Sin agente', 'No agent') }}</th>
                      <td class="numeric">{{ formatNumber(row.steps) }}</td>
                      <td>{{ tokenBreakdown(row) }}</td>
                    </tr>
                  </tbody>
                </table>
                <p v-if="!metrics.byAgent.length" class="empty-report">{{ t('Sin datos por agente en este rango.', 'No agent data in this range.') }}</p>
              </article>

              <article class="metrics-table-panel">
                <table class="metrics-table">
                  <caption>{{ t('Por modelo y proveedor', 'By model and provider') }}</caption>
                  <thead><tr>
                    <th scope="col" :aria-sort="ariaSort('model', 'name')">
                      <button type="button" class="sort-button" @click="toggleSort('model', 'name')">{{ t('Modelo / proveedor', 'Model / provider') }}<span v-if="sortIndicator('model', 'name')" class="sort-indicator" aria-hidden="true">{{ sortIndicator('model', 'name') }}</span></button>
                    </th>
                    <th scope="col" :aria-sort="ariaSort('model', 'steps')">
                      <button type="button" class="sort-button" @click="toggleSort('model', 'steps')">{{ t('Pasos', 'Steps') }}<span v-if="sortIndicator('model', 'steps')" class="sort-indicator" aria-hidden="true">{{ sortIndicator('model', 'steps') }}</span></button>
                    </th>
                    <th scope="col" :aria-sort="ariaSort('model', 'tokens')">
                      <button type="button" class="sort-button" @click="toggleSort('model', 'tokens')">{{ t('Tokens', 'Tokens') }}<span v-if="sortIndicator('model', 'tokens')" class="sort-indicator" aria-hidden="true">{{ sortIndicator('model', 'tokens') }}</span></button>
                    </th>
                  </tr></thead>
                  <tbody>
                    <tr v-for="row in modelRows" :key="`${row.provider ?? ''}:${row.key ?? ''}`">
                      <th scope="row"><span>{{ row.key || t('Sin modelo', 'No model') }}</span><small class="row-sub">{{ row.provider || t('Sin proveedor', 'No provider') }}</small></th>
                      <td class="numeric">{{ formatNumber(row.steps) }}</td>
                      <td>{{ tokenBreakdown(row) }}</td>
                    </tr>
                  </tbody>
                </table>
                <p v-if="!metrics.byModel.length" class="empty-report">{{ t('Sin datos por modelo en este rango.', 'No model data in this range.') }}</p>
              </article>

              <article class="metrics-table-panel">
                <table class="metrics-table">
                  <caption>{{ t('Por proyecto', 'By project') }}</caption>
                  <thead><tr>
                    <th scope="col" :aria-sort="ariaSort('project', 'name')">
                      <button type="button" class="sort-button" @click="toggleSort('project', 'name')">{{ t('Proyecto / directorio', 'Project / directory') }}<span v-if="sortIndicator('project', 'name')" class="sort-indicator" aria-hidden="true">{{ sortIndicator('project', 'name') }}</span></button>
                    </th>
                    <th scope="col" :aria-sort="ariaSort('project', 'steps')">
                      <button type="button" class="sort-button" @click="toggleSort('project', 'steps')">{{ t('Pasos', 'Steps') }}<span v-if="sortIndicator('project', 'steps')" class="sort-indicator" aria-hidden="true">{{ sortIndicator('project', 'steps') }}</span></button>
                    </th>
                    <th scope="col" :aria-sort="ariaSort('project', 'tokens')">
                      <button type="button" class="sort-button" @click="toggleSort('project', 'tokens')">{{ t('Tokens', 'Tokens') }}<span v-if="sortIndicator('project', 'tokens')" class="sort-indicator" aria-hidden="true">{{ sortIndicator('project', 'tokens') }}</span></button>
                    </th>
                  </tr></thead>
                  <tbody>
                    <tr v-for="row in projectRows" :key="row.key ?? 'none'">
                      <th scope="row"><code class="project-hash">{{ row.key || '—' }}</code><small class="row-sub">{{ row.directory || t('Directorio no disponible', 'Directory unavailable') }}</small></th>
                      <td class="numeric">{{ formatNumber(row.steps) }}</td>
                      <td>{{ tokenBreakdown(row) }}</td>
                    </tr>
                  </tbody>
                </table>
                <p v-if="!metrics.byProject.length" class="empty-report">{{ t('Sin datos por proyecto en este rango.', 'No project data in this range.') }}</p>
              </article>

              <article class="metrics-table-panel">
                <table class="metrics-table">
                  <caption>{{ t('Por tipo de petición', 'By request type') }}</caption>
                  <thead><tr>
                    <th scope="col" :aria-sort="ariaSort('kind', 'name')">
                      <button type="button" class="sort-button" @click="toggleSort('kind', 'name')">{{ t('Tipo', 'Type') }}<span v-if="sortIndicator('kind', 'name')" class="sort-indicator" aria-hidden="true">{{ sortIndicator('kind', 'name') }}</span></button>
                    </th>
                    <th scope="col" :aria-sort="ariaSort('kind', 'steps')">
                      <button type="button" class="sort-button" @click="toggleSort('kind', 'steps')">{{ t('Pasos', 'Steps') }}<span v-if="sortIndicator('kind', 'steps')" class="sort-indicator" aria-hidden="true">{{ sortIndicator('kind', 'steps') }}</span></button>
                    </th>
                    <th scope="col" :aria-sort="ariaSort('kind', 'tokens')">
                      <button type="button" class="sort-button" @click="toggleSort('kind', 'tokens')">{{ t('Tokens', 'Tokens') }}<span v-if="sortIndicator('kind', 'tokens')" class="sort-indicator" aria-hidden="true">{{ sortIndicator('kind', 'tokens') }}</span></button>
                    </th>
                  </tr></thead>
                  <tbody>
                    <tr v-for="row in kindRows" :key="row.key">
                      <th scope="row">{{ metricKindLabel(row.key) }}</th>
                      <td class="numeric">{{ formatNumber(row.steps) }}</td>
                      <td>{{ tokenBreakdown(row) }}</td>
                    </tr>
                  </tbody>
                </table>
                <p v-if="!metrics.byKind.length" class="empty-report">{{ t('Sin datos por tipo en este rango.', 'No type data in this range.') }}</p>
              </article>
            </div>
          </template>

          <section class="plugin-health" aria-labelledby="plugin-health-heading">
            <header class="plugin-heading">
              <div>
                <h3 id="plugin-health-heading">{{ t('Salud del plugin', 'Plugin health') }}</h3>
                <p class="section-note">{{ t('Contadores en memoria de esta sesión del plugin; no se guardan en store-v1.json y no incluyen prompts, rutas, argumentos ni IDs de sesión.', 'In-memory counters for this plugin session; they are not saved in store-v1.json and contain no prompts, paths, arguments, or session IDs.') }}</p>
              </div>
            </header>
            <p v-if="pluginEmpty && !metricsLoading && !metricsError" class="empty-report">{{ t('Aún no hay actividad interna registrada. Los contadores aparecen cuando el plugin procesa hooks, storage o SSE.', 'No internal activity recorded yet. Counters appear when the plugin handles hooks, storage, or SSE.') }}</p>
            <template v-else-if="!pluginEmpty">
              <div class="metrics-cards">
                <article class="metric-card"><span>{{ t('Hooks', 'Hooks') }}</span><strong>{{ formatNumber(pluginHookCalls) }}</strong><small>{{ t('llamadas', 'calls') }} · {{ formatNumber(pluginHookErrors) }} {{ t('errores', 'errors') }}</small></article>
                <article class="metric-card"><span>{{ t('Almacenamiento', 'Storage') }}</span><strong>{{ formatNumber(plugin.store.reads) }} / {{ formatNumber(plugin.store.writes) }}</strong><small>{{ t('lecturas / escrituras', 'reads / writes') }}</small></article>
                <article class="metric-card"><span>{{ t('Contexto inyectado', 'Injected context') }}</span><strong>{{ formatNumber(plugin.context.injectedChars) }}</strong><small>{{ t('caracteres', 'characters') }} · {{ formatNumber(plugin.context.injections) }} {{ t('inyecciones', 'injections') }}</small></article>
                <article class="metric-card"><span>{{ t('SSE', 'SSE') }}</span><strong>{{ formatNumber(plugin.sse.clients) }}</strong><small>{{ t('clientes · pico', 'clients · peak') }} {{ formatNumber(plugin.sse.peakClients) }}</small></article>
                <article class="metric-card"><span>{{ t('Peticiones 2xx', '2xx requests') }}</span><strong>{{ formatNumber(plugin.requests['2xx']) }}</strong><small>4xx {{ formatNumber(plugin.requests['4xx']) }} · 5xx {{ formatNumber(plugin.requests['5xx']) }}</small></article>
                <article class="metric-card"><span>{{ t('Errores', 'Errors') }}</span><strong>{{ formatNumber(pluginErrorTotal) }}</strong><small>{{ t('contabilizados', 'counted') }}</small></article>
              </div>

              <div class="metrics-tables plugin-tables">
                <article class="metrics-table-panel">
                  <table class="metrics-table">
                    <caption>{{ t('Hooks del plugin', 'Plugin hooks') }}</caption>
                    <thead><tr><th scope="col">{{ t('Hook', 'Hook') }}</th><th scope="col">{{ t('Llamadas', 'Calls') }}</th><th scope="col">{{ t('Errores', 'Errors') }}</th><th scope="col">p50</th><th scope="col">p95</th></tr></thead>
                    <tbody>
                      <tr v-for="hook in pluginHooks" :key="hook.name">
                        <th scope="row">{{ pluginHookLabel(hook.name) }}</th>
                        <td class="numeric">{{ formatNumber(hook.invocations) }}</td>
                        <td class="numeric">{{ formatNumber(hook.errors) }}</td>
                        <td class="numeric">{{ formatMillis(hook.p50) }}</td>
                        <td class="numeric">{{ formatMillis(hook.p95) }}</td>
                      </tr>
                    </tbody>
                  </table>
                </article>

                <article class="metrics-table-panel">
                  <table class="metrics-table">
                    <caption>{{ t('Almacenamiento y memoria', 'Storage and memory') }}</caption>
                    <thead><tr><th scope="col">{{ t('Métrica', 'Metric') }}</th><th scope="col">{{ t('Valor', 'Value') }}</th></tr></thead>
                    <tbody>
                      <tr><th scope="row">{{ t('Bytes leídos / escritos', 'Bytes read / written') }}</th><td class="numeric">{{ formatBytes(plugin.store.bytesRead) }} / {{ formatBytes(plugin.store.bytesWritten) }}</td></tr>
                      <tr><th scope="row">{{ t('Esperas / timeouts de lock', 'Lock waits / timeouts') }}</th><td class="numeric">{{ formatNumber(plugin.store.lockWaits) }} / {{ formatNumber(plugin.store.lockTimeouts) }}</td></tr>
                      <tr><th scope="row">{{ t('Latencia de escritura p50 / p95', 'Write latency p50 / p95') }}</th><td class="numeric">{{ formatMillis(plugin.store.writeLatency.p50) }} / {{ formatMillis(plugin.store.writeLatency.p95) }}</td></tr>
                      <tr><th scope="row">{{ t('Tamaño store / metrics', 'Store / metrics size') }}</th><td class="numeric">{{ formatBytes(plugin.bytes.store) }} / {{ formatBytes(plugin.bytes.metrics) }}</td></tr>
                      <tr><th scope="row">{{ t('Avisos checkpoint / TODO', 'Checkpoint / TODO notices') }}</th><td class="numeric">{{ formatNumber(plugin.context.notices.checkpoint) }} / {{ formatNumber(plugin.context.notices.todo) }}</td></tr>
                    </tbody>
                  </table>
                </article>

                <article class="metrics-table-panel">
                  <table class="metrics-table">
                    <caption>{{ t('SSE, peticiones y flush', 'SSE, requests, and flush') }}</caption>
                    <thead><tr><th scope="col">{{ t('Métrica', 'Metric') }}</th><th scope="col">{{ t('Valor', 'Value') }}</th></tr></thead>
                    <tbody>
                      <tr><th scope="row">{{ t('Clientes SSE / pico', 'SSE clients / peak') }}</th><td class="numeric">{{ formatNumber(plugin.sse.clients) }} / {{ formatNumber(plugin.sse.peakClients) }}</td></tr>
                      <tr><th scope="row">{{ t('Refrescos SSE', 'SSE refreshes') }}</th><td class="numeric">{{ formatNumber(plugin.sse.refreshes) }}</td></tr>
                      <tr><th scope="row">{{ t('Peticiones 2xx / 4xx / 5xx', 'Requests 2xx / 4xx / 5xx') }}</th><td class="numeric">{{ formatNumber(plugin.requests['2xx']) }} / {{ formatNumber(plugin.requests['4xx']) }} / {{ formatNumber(plugin.requests['5xx']) }}</td></tr>
                      <tr><th scope="row">{{ t('Último flush', 'Last flush') }}</th><td class="numeric">{{ formatTime(plugin.flush.lastAt) }}</td></tr>
                      <tr><th scope="row">{{ t('Pendientes / fallos de flush', 'Flush pending / failures') }}</th><td class="numeric">{{ formatNumber(plugin.flush.pending) }} / {{ formatNumber(plugin.flush.failures) }}</td></tr>
                    </tbody>
                  </table>
                </article>

                <article class="metrics-table-panel">
                  <table class="metrics-table">
                    <caption>{{ t('Errores y estado actual', 'Errors and current state') }}</caption>
                    <thead><tr><th scope="col">{{ t('Categoría', 'Category') }}</th><th scope="col">{{ t('Valor', 'Value') }}</th></tr></thead>
                    <tbody>
                      <tr v-for="error in pluginErrors" :key="error.key"><th scope="row">{{ pluginErrorLabel(error.key) }}</th><td class="numeric">{{ formatNumber(error.count) }}</td></tr>
                      <tr><th scope="row">{{ t('Checkpoints / TODOs / ámbitos', 'Checkpoints / TODOs / scopes') }}</th><td class="numeric">{{ pluginCurrent ? `${formatNumber(pluginCurrent.checkpoints)} / ${formatNumber(pluginCurrent.todos)} / ${formatNumber(pluginCurrent.scopes)}` : '—' }}</td></tr>
                      <tr><th scope="row">{{ t('TODOs activos', 'Active TODOs') }}</th><td class="numeric">{{ pluginCurrent ? formatNumber(pluginCurrent.activeTodos) : '—' }}</td></tr>
                      <tr><th scope="row">{{ t('Activo desde', 'Active since') }}</th><td class="numeric">{{ formatTime(plugin.startedAt) }}</td></tr>
                    </tbody>
                  </table>
                </article>
              </div>
            </template>
          </section>
        </section>
      </main>
    </div>
  </div>
</template>
