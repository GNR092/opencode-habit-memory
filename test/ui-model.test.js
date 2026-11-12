import assert from 'node:assert/strict'
import test from 'node:test'
import { checkpointTitle, dailyTrend, groupCheckpoints, groupTodos, metricTokenTotal, metricsRange, projectDirectoryLabel, reportGroups, sortMetricRows, tokenBars, trendBars } from '../src/ui-model.js'

test('checkpoint groups expand by exact project and retain each context/checkpoint', () => {
  const first = { id: 'one', project: 'a / b', context: 'c' }
  const second = { id: 'two', project: 'a', context: 'b / c' }
  const third = { id: 'three', project: 'a / b', context: 'another-session' }
  const groups = groupCheckpoints([first, second, third])

  assert.equal(groups.length, 2)
  assert.equal(groups[0].key, 'a / b')
  assert.deepEqual([groups[0].project, groups[0].items], ['a / b', [first, third]])
  assert.deepEqual([groups[1].project, groups[1].items], ['a', [second]])
})

test('project groups choose the newest valid directory basename and localize the fallback', () => {
  const groups = groupCheckpoints([
    { id: 'old', project: 'p', context: 'a', projectDirectoryName: 'old-folder', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'new', project: 'p', context: 'b', projectDirectoryName: 'new-folder', createdAt: '2026-07-01T00:00:00.000Z' },
    { id: 'invalid', project: 'p', context: 'c', projectDirectoryName: '/absolute/path', createdAt: '2026-08-01T00:00:00.000Z' },
    { id: 'legacy', project: 'q', context: 'd', createdAt: '2026-08-01T00:00:00.000Z' },
  ])

  assert.equal(groups[0].directoryName, 'new-folder')
  assert.equal(groups[1].directoryName, '')
  assert.equal(projectDirectoryLabel(groups[0], 'es'), 'new-folder')
  assert.equal(projectDirectoryLabel(groups[1], 'es'), 'Directorio no disponible')
  assert.equal(projectDirectoryLabel(groups[1], 'en'), 'Directory unavailable')
  assert.equal(projectDirectoryLabel({ directoryName: '<img src=x onerror=alert(1)>' }, 'es'), '<img src=x onerror=alert(1)>')
})

test('TODOs group by exact project and status, hiding archived items by default', () => {
  const pending = { id: 'one', project: 'a / b', task: 'Pending task', status: 'pending' }
  const completed = { id: 'two', project: 'a / b', task: 'Done task', status: 'completed' }
  const archived = { id: 'three', project: 'a', task: 'Archived task', status: 'archived' }
  const todos = [pending, completed, archived]

  assert.deepEqual(groupTodos(todos).map(({ project, total, pending, completed, archived }) => [project, total, pending, completed, archived]), [
    ['a / b', 2, [pending], [completed], []],
  ])
  assert.deepEqual(groupTodos(todos, true).map(({ project, total, pending, completed, archived }) => [project, total, pending, completed, archived]), [
    ['a / b', 2, [pending], [completed], []],
    ['a', 1, [], [], [archived]],
  ])
})

test('TODO groups retain the newest project directory and accept a checkpoint fallback', () => {
  const groups = groupTodos([
    { id: 'old', project: 'p', task: 'Old task', status: 'pending', createdAt: '2026-01-01T00:00:00.000Z', projectDirectoryName: 'old-folder' },
    { id: 'new', project: 'p', task: 'New task', status: 'pending', createdAt: '2026-07-01T00:00:00.000Z', projectDirectoryName: 'new-folder' },
    { id: 'legacy', project: 'q', task: 'Legacy task', status: 'pending', createdAt: '2026-08-01T00:00:00.000Z' },
    { id: 'invalid', project: 'q', task: 'Invalid task', status: 'pending', createdAt: '2026-09-01T00:00:00.000Z', projectDirectoryName: '/absolute/path' },
  ], false, new Map([['q', 'fallback-folder']]))

  assert.equal(groups[0].directoryName, 'new-folder')
  assert.equal(groups[1].directoryName, 'fallback-folder')
})

test('checkpoint titles use bilingual fallback only when no valid title exists', () => {
  assert.equal(checkpointTitle({ summary: 'legacy' }, 'es'), 'Título no disponible')
  assert.equal(checkpointTitle({ sessionTitle: '  ' }, 'en'), 'Title unavailable')
  assert.equal(checkpointTitle({ sessionTitle: '<img src=x onerror=alert(1)>' }, 'es'), '<img src=x onerror=alert(1)>')
})

test('reports rank allowlisted tools and commands without blending labels', () => {
  const groups = reportGroups({
    'tool:bash': 4,
    'request:tool:bash': 3,
    'cli:npm': 2,
    'request:cli:git': 5,
    'request:agent:code': 1,
    'private:secret': 100,
  })

  assert.deepEqual(groups.map(({ key, total }) => [key, total]), [['tools', 7], ['commands', 7]])
  assert.deepEqual(groups[0].items.map(({ key, signal, count }) => [key, signal, count]), [
    ['tool:bash', 'activity', 4], ['request:tool:bash', 'request', 3],
  ])
  assert.equal(groups[1].items[0].key, 'request:cli:git')
})

test('daily series aggregates UTC tools and commands and produces native chart bars', () => {
  const series = dailyTrend({
    '2026-11-05': { 'tool:bash': 2, 'request:cli:npm': 3, 'request:agent:code': 1, 'raw:prompt': 900 },
    '2026-11-07': { 'request:tool:read': 4, 'cli:git': 2 },
  }, '2026-11-07')
  assert.deepEqual(series, [
    { date: '2026-11-05', tools: 2, commands: 3 },
    { date: '2026-11-07', tools: 4, commands: 2 },
  ])
  const bars = trendBars(series)
  assert.deepEqual(bars.map(({ date, key, count }) => [date, key, count]), [
    ['2026-11-05', 'tools', 2], ['2026-11-05', 'commands', 3],
    ['2026-11-07', 'tools', 4], ['2026-11-07', 'commands', 2],
  ])
  assert.ok(bars.every(({ x, y, width, height }) => [x, y, width, height].every(Number.isFinite)))
  assert.ok(bars.every(({ x, width }) => x >= 28 - 1e-6 && x + width <= 704 + 1e-6))
})

test('metrics range stays inside 7, 30 and 90 UTC days', () => {
  assert.deepEqual(metricsRange(7, '2026-11-11'), { from: '2026-11-05', to: '2026-11-11' })
  assert.deepEqual(metricsRange(30, '2026-11-11'), { from: '2026-10-13', to: '2026-11-11' })
  assert.deepEqual(metricsRange(90, '2026-11-11'), { from: '2026-08-14', to: '2026-11-11' })
  assert.deepEqual(metricsRange(4, '2026-11-11'), metricsRange(30, '2026-11-11'))
})

test('token bars handle empty, one day and the 90-day viewBox limits', () => {
  assert.deepEqual(tokenBars([]), [])
  const one = tokenBars([{ day: '2026-11-11', tokens: { input: 10, cacheRead: 20, output: 5 } }])
  assert.deepEqual(one.map(({ key, value }) => [key, value]), [['input', 10], ['cache', 20], ['output', 5]])
  const center = 28 + (720 - 28 - 16) / 2
  assert.ok(one.every(({ x, width }) => Math.abs(x + width / 2 - center) < 1e-6))
  assert.ok(one.every(({ x, y, width, height }) => [x, y, width, height].every(Number.isFinite)))
  assert.ok(one.every(({ x, width }) => x >= 28 - 1e-6 && x + width <= 704 + 1e-6))
  assert.ok(one.every(({ y, height }) => y >= 12 - 1e-6 && y + height <= 152 + 1e-6))
  assert.equal(one.find(({ key }) => key === 'input').y + one.find(({ key }) => key === 'input').height, 152)

  const many = tokenBars(Array.from({ length: 90 }, (_, index) => ({
    day: new Date(Date.UTC(2026, 7, 14 + index)).toISOString().slice(0, 10),
    tokens: { input: index + 1, cacheRead: index + 2, output: 3 },
  })))
  assert.equal(many.length, 270)
  assert.ok(many.every(({ x, y, width, height }) => [x, y, width, height].every(Number.isFinite)))
  assert.ok(many.every(({ x, width }) => x >= 28 - 1e-6 && x + width <= 704 + 1e-6))
  assert.ok(many.every(({ y, height }) => y >= 12 - 1e-6 && y + height <= 152 + 1e-6))
})

test('metric rows sort immutably with stable name tie-breaks', () => {
  const rows = [
    { key: 'beta', steps: 2, tokens: { input: 10, cacheRead: 5, output: 1, reasoning: 0, cacheWrite: 0 } },
    { key: 'alpha', steps: 2, tokens: { input: 1, cacheRead: 0, output: 0, reasoning: 0, cacheWrite: 0 } },
    { key: 'gamma', steps: 9, tokens: { input: 0, cacheRead: 0, output: 0, reasoning: 0, cacheWrite: 0 } },
  ]
  const original = rows.map(({ key }) => key)

  assert.deepEqual(sortMetricRows(rows, 'steps', 'desc').map(({ key }) => key), ['gamma', 'alpha', 'beta'])
  assert.deepEqual(sortMetricRows(rows, 'steps', 'asc').map(({ key }) => key), ['alpha', 'beta', 'gamma'])
  assert.deepEqual(sortMetricRows(rows, 'name', 'asc').map(({ key }) => key), ['alpha', 'beta', 'gamma'])
  assert.equal(metricTokenTotal(rows[0]), 16)
  assert.deepEqual(sortMetricRows(rows, 'tokens', 'desc').map(({ key }) => key), ['beta', 'alpha', 'gamma'])
  assert.deepEqual(sortMetricRows([{ key: 'a', name: 'Zulu' }, { key: 'b', name: 'Alfa' }], 'name', 'asc').map(({ key }) => key), ['b', 'a'])
  assert.deepEqual(rows.map(({ key }) => key), original)
  assert.deepEqual(sortMetricRows(undefined), [])
})
