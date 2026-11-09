import assert from 'node:assert/strict'
import test from 'node:test'
import { checkpointTitle, dailyTrend, groupCheckpoints, projectDirectoryLabel, reportGroups, trendBars } from '../src/ui-model.js'

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
