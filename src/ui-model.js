function directoryName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  return name && name.length <= 128 && !/[\\/\u0000-\u001f\u007f]/.test(name) ? name : ''
}

export function groupCheckpoints(checkpoints) {
  const groups = new Map()
  const directories = new Map()
  for (const item of checkpoints) {
    const key = item.project
    if (!groups.has(key)) groups.set(key, { key, project: item.project, items: [] })
    groups.get(key).items.push(item)
    const name = directoryName(item?.projectDirectoryName)
    if (name) {
      const createdAt = typeof item?.createdAt === 'string' ? item.createdAt : ''
      if (!directories.has(key) || createdAt >= directories.get(key).createdAt) directories.set(key, { name, createdAt })
    }
  }
  return [...groups.values()].map((group) => ({ ...group, directoryName: directories.get(group.key)?.name ?? '' }))
}

export function groupTodos(todos = [], includeArchived = false, directories = new Map()) {
  const groups = new Map()
  const names = new Map()
  for (const todo of todos) {
    if (!includeArchived && todo.status === 'archived') continue
    if (!groups.has(todo.project)) groups.set(todo.project, { key: todo.project, project: todo.project, total: 0, pending: [], completed: [], archived: [] })
    const group = groups.get(todo.project)
    const name = directoryName(todo.projectDirectoryName)
    if (name) {
      const createdAt = typeof todo.createdAt === 'string' ? todo.createdAt : ''
      if (!names.has(todo.project) || createdAt >= names.get(todo.project).createdAt) names.set(todo.project, { name, createdAt })
    }
    group[todo.status].push(todo)
    group.total++
  }
  return [...groups.values()].map((group) => ({ ...group, directoryName: names.get(group.key)?.name ?? directories.get(group.key) ?? '' }))
}

export function projectDirectoryLabel(scope, language = 'es') {
  return typeof scope?.directoryName === 'string' && scope.directoryName.trim()
    ? scope.directoryName
    : language === 'es' ? 'Directorio no disponible' : 'Directory unavailable'
}

export function checkpointTitle(item, language = 'es') {
  return typeof item?.sessionTitle === 'string' && item.sessionTitle.trim()
    ? item.sessionTitle
    : language === 'es' ? 'Título no disponible' : 'Title unavailable'
}

function reportCategory(key) {
  const match = /^(request:)?(tool|cli):([^:]+)$/.exec(key)
  if (!match) return null
  return {
    group: match[2] === 'tool' ? 'tools' : 'commands',
    kind: match[2],
    name: match[3],
    signal: match[1] ? 'request' : 'activity',
  }
}

export function reportGroups(counts = {}) {
  const groups = Object.fromEntries(['tools', 'commands'].map((key) => [key, { key, total: 0, items: [] }]))
  for (const [key, count] of Object.entries(counts)) {
    const category = reportCategory(key)
    if (!category || !Number.isSafeInteger(count) || count < 1) continue
    const group = groups[category.group]
    group.total += count
    group.items.push({ key, name: category.name, kind: category.kind, signal: category.signal, count })
  }
  for (const group of Object.values(groups)) group.items.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
  return Object.values(groups)
}

export function dailyTrend(daily = {}, today = new Date().toISOString().slice(0, 10)) {
  const cutoff = new Date(`${today}T00:00:00.000Z`)
  cutoff.setUTCDate(cutoff.getUTCDate() - 364)
  const oldest = cutoff.toISOString().slice(0, 10)
  return Object.entries(daily).filter(([date]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= oldest && date <= today && new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date).sort(([a], [b]) => a.localeCompare(b)).map(([date, counts]) => {
    const row = { date, tools: 0, commands: 0 }
    for (const [key, count] of Object.entries(counts ?? {})) {
      const category = reportCategory(key)
      if (category && Number.isSafeInteger(count) && count > 0) row[category.group] += count
    }
    return row
  }).filter(({ tools, commands }) => tools + commands > 0)
}

function metricDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
}

export function metricsRange(days, today = new Date().toISOString().slice(0, 10)) {
  const allowed = [7, 30, 90]
  const span = allowed.includes(Number(days)) ? Number(days) : 30
  const to = metricDate(today) ? today : new Date().toISOString().slice(0, 10)
  const from = new Date(`${to}T00:00:00.000Z`)
  from.setUTCDate(from.getUTCDate() - (span - 1))
  return { from: from.toISOString().slice(0, 10), to }
}

export function tokenBars(series = [], options = {}) {
  if (!Array.isArray(series) || !series.length) return []
  const rows = series.filter((row) => row && metricDate(row.day))
  if (!rows.length) return []
  const width = options.width ?? 720
  const height = options.height ?? 180
  const left = options.left ?? 28
  const right = options.right ?? 16
  const top = options.top ?? 12
  const bottom = options.bottom ?? 28
  const plotWidth = width - left - right
  const plotHeight = height - top - bottom
  const max = Math.max(1, ...rows.map((row) => {
    const tokens = row.tokens ?? {}
    return Number(tokens.input || 0) + Number(tokens.cacheRead || 0) + Number(tokens.output || 0)
  }))
  const slot = plotWidth / rows.length
  const barWidth = Math.max(1, Math.min(28, slot * .62))
  return rows.flatMap((row, index) => {
    const x = rows.length === 1 ? left + (plotWidth - barWidth) / 2 : left + index * slot + (slot - barWidth) / 2
    const values = [
      ['input', Number(row.tokens?.input || 0)],
      ['cache', Number(row.tokens?.cacheRead || 0)],
      ['output', Number(row.tokens?.output || 0)],
    ]
    let cursor = top + plotHeight
    return values.map(([key, value]) => {
      const heightValue = Math.max(0, value) / max * plotHeight
      const y = Math.max(top, cursor - heightValue)
      const bar = { day: row.day, key, value, x, y, width: barWidth, height: cursor - y }
      cursor -= heightValue
      return bar
    }).filter(({ value, height: barHeight }) => value > 0 && barHeight > 0)
  })
}

export function metricTokenTotal(row) {
  const tokens = row?.tokens ?? {}
  return ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite']
    .reduce((total, field) => total + (Number(tokens[field]) || 0), 0)
}

export function sortMetricRows(rows = [], key = 'steps', direction = 'desc') {
  if (!Array.isArray(rows)) return []
  const column = key === 'name' || key === 'tokens' ? key : 'steps'
  const factor = direction === 'asc' ? 1 : -1
  const nameOf = (row) => String(row?.name ?? row?.key ?? '')
  const providerOf = (row) => String(row?.provider ?? '')
  const valueOf = (row) => column === 'tokens'
    ? metricTokenTotal(row)
    : column === 'steps' ? Number(row?.steps) || 0 : 0
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const byName = nameOf(a.row).localeCompare(nameOf(b.row))
      const primary = column === 'name' ? byName * factor : (valueOf(a.row) - valueOf(b.row)) * factor
      if (primary) return primary
      if (column === 'name') return providerOf(a.row).localeCompare(providerOf(b.row)) || a.index - b.index
      return byName || providerOf(a.row).localeCompare(providerOf(b.row)) || a.index - b.index
    })
    .map(({ row }) => row)
}

export function trendBars(series) {
  if (!series.length) return []
  const width = 720, height = 180, left = 28, right = 16, top = 12, bottom = 28
  const days = series.map(({ date }) => Date.parse(`${date}T00:00:00.000Z`))
  const distinctDays = days.at(-1) !== days[0]
  const span = distinctDays ? Math.round((days.at(-1) - days[0]) / 86_400_000) : 1
  const max = Math.max(1, ...series.flatMap(({ tools, commands }) => [tools, commands]))
  const plotWidth = width - left - right, plotHeight = height - top - bottom
  const slot = plotWidth / (span + 1), barWidth = Math.max(.5, slot * .18)
  const groupWidth = barWidth * 2
  return series.flatMap((row, index) => {
    const progress = distinctDays ? ((days[index] - days[0]) / 86_400_000) / span : .5
    const center = left + groupWidth / 2 + progress * (plotWidth - groupWidth)
    return ['tools', 'commands'].map((key, offset) => {
      const barHeight = row[key] / max * plotHeight
      return { date: row.date, key, count: row[key], x: center + (offset - 1) * barWidth, y: top + plotHeight - barHeight, width: barWidth, height: barHeight }
    }).filter(({ count }) => count > 0)
  })
}
