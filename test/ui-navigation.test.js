import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { viewFromHash, viewIds, watchHashView } from '../src/ui-navigation.js'

test('native hash selects known views and defaults to reports', () => {
  assert.deepEqual(viewIds, ['reports', 'checkpoints', 'todos'])
  assert.deepEqual(viewIds.map((view) => viewFromHash(`#${view}`)), viewIds)
  assert.equal(viewFromHash(''), 'reports')
  assert.equal(viewFromHash('#inicio'), 'reports')
})

test('hash changes update the selected view and stop cleanly', () => {
  const listeners = new Set()
  const target = {
    location: { hash: '#reports' },
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  }
  const selected = []
  const stop = watchHashView(target, (view) => selected.push(view))

  for (const hash of ['#checkpoints', '#todos', '#reports']) {
    target.location.hash = hash
    for (const listener of listeners) listener()
  }

  assert.deepEqual(selected, ['reports', 'checkpoints', 'todos', 'reports'])
  stop()
  assert.equal(listeners.size, 0)
})

test('each navigation link marks only its matching visible view', async () => {
  const app = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8')
  for (const view of viewIds) {
    assert.ok(app.includes(`href="#${view}" :aria-current="activeView === '${view}' ? 'page' : undefined"`))
    assert.ok(app.includes(`id="${view}" v-show="activeView === '${view}'"`))
  }
  assert.match(app, /id="checkpoints"[\s\S]*?<section class="stat-strip checkpoint-summary"/)
})
