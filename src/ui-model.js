export function groupCheckpoints(checkpoints) {
  const groups = new Map()
  const directories = new Map()
  for (const item of checkpoints) {
    const key = item.project
    if (!groups.has(key)) groups.set(key, { key, project: item.project, items: [] })
    groups.get(key).items.push(item)
    const name = typeof item?.projectDirectoryName === 'string' ? item.projectDirectoryName.trim() : ''
    if (name && name.length <= 128 && !/[\\/\u0000-\u001f\u007f]/.test(name)) {
      const createdAt = typeof item?.createdAt === 'string' ? item.createdAt : ''
      if (!directories.has(key) || createdAt >= directories.get(key).createdAt) directories.set(key, { name, createdAt })
    }
  }
  return [...groups.values()].map((group) => ({ ...group, directoryName: directories.get(group.key)?.name ?? '' }))
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
