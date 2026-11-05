import assert from 'node:assert/strict'
import test from 'node:test'
import { groupCheckpoints, groupPatterns } from '../src/ui-model.js'

test('checkpoint groups preserve the exact project and context pair', () => {
  const first = { id: 'one', project: 'a / b', context: 'c' }
  const second = { id: 'two', project: 'a', context: 'b / c' }
  const third = { id: 'three', project: 'a / b', context: 'c' }
  const groups = groupCheckpoints([first, second, third])

  assert.equal(groups.length, 2)
  assert.notEqual(groups[0].key, groups[1].key)
  assert.deepEqual([groups[0].project, groups[0].context, groups[0].items], ['a / b', 'c', [first, third]])
  assert.deepEqual([groups[1].project, groups[1].context, groups[1].items], ['a', 'b / c', [second]])
})

test('pattern groups retain category, technical key and count', () => {
  const groups = groupPatterns({ 'request:tool:grep': 3, 'request:agent:code': 1, 'tool:read': 8, 'cli:npm': 2, unknown: 4 })

  assert.deepEqual(groups.requests, [
    { key: 'request:tool:grep', count: 3, kind: 'tool', name: 'grep' },
    { key: 'request:agent:code', count: 1, kind: 'agent', name: 'code' },
  ])
  assert.deepEqual(groups.activity, [
    { key: 'tool:read', count: 8, kind: 'tool', name: 'read' },
    { key: 'cli:npm', count: 2, kind: 'cli', name: 'npm' },
  ])
  assert.deepEqual(groups.other, [{ key: 'unknown', count: 4, kind: '', name: 'unknown' }])
})
