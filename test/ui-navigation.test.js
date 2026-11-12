import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { viewFromHash, viewIds, watchHashView } from '../src/ui-navigation.js'

test('native hash selects known views and defaults to reports', () => {
  assert.deepEqual(viewIds, ['reports', 'checkpoints', 'todos', 'metrics'])
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

test('metrics view keeps filters, accessible charts, sortable tables and series colors', async () => {
  const app = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8')
  const css = await readFile(new URL('../src/ui.css', import.meta.url), 'utf8')
  for (const fragment of [
    'class="metrics-filters"',
    'v-model.number="rangeDays"',
    'aria-labelledby="metrics-heading"',
    'id="metrics-tokens-title"',
    'id="plugin-health-heading"',
    'class="plugin-health"',
    'pluginEmpty',
    'class="sort-button"',
    ':aria-sort="ariaSort(',
    '@click="toggleSort(',
    '<caption>',
    'scope="col"',
    'scope="row"',
  ]) assert.ok(app.includes(fragment), fragment)
  assert.equal((app.match(/class="sort-button"/g) ?? []).length, 12)
  assert.equal((app.match(/aria-sort="ariaSort\(/g) ?? []).length, 12)
  for (const leftover of ['metrics-cost-title', 'cost-line', 'reportedCost', 'coverageText', 'costChart']) assert.ok(!app.includes(leftover), leftover)
  assert.ok(!css.includes('.cost-line'))
  assert.ok(!css.includes('.cost-point'))
  assert.match(app, /\/api\/metrics\?/)
  for (const variable of ['--series-input', '--series-cache', '--series-output']) assert.ok(css.includes(variable), variable)
  assert.match(css, /\.metrics-table caption/)
  assert.match(css, /\.trend-chart \.input-series/)
  assert.match(css, /\.sort-button/)
  assert.match(css, /\.sort-indicator/)
})
