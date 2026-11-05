export function groupCheckpoints(checkpoints) {
  const groups = new Map()
  for (const item of checkpoints) {
    const key = JSON.stringify([item.project, item.context])
    if (!groups.has(key)) groups.set(key, { key, project: item.project, context: item.context, items: [] })
    groups.get(key).items.push(item)
  }
  return [...groups.values()]
}

export function groupPatterns(counts) {
  const groups = { requests: [], activity: [], other: [] }
  for (const [key, count] of Object.entries(counts)) {
    const parts = key.split(':')
    const request = parts.length === 3 && parts[0] === 'request' && ['tool', 'cli', 'agent'].includes(parts[1]) && parts[2]
    const activity = parts.length === 2 && ['tool', 'cli'].includes(parts[0]) && parts[1]
    const group = request ? 'requests' : activity ? 'activity' : 'other'
    groups[group].push({ key, count, kind: request ? parts[1] : activity ? parts[0] : '', name: request ? parts[2] : activity ? parts[1] : key })
  }
  return groups
}
