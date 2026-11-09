import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('MCP exposes no operation for deleting aggregated habits', async () => {
  const home = await mkdtemp(join(tmpdir(), 'habit-memory-mcp-'))
  const previous = process.env.XDG_DATA_HOME
  const env = { ...process.env, XDG_DATA_HOME: home }
  process.env.XDG_DATA_HOME = home
  try {
    const store = await import('../src/store.js')
    await store.incrementHabitCounts(['tool:bash'])
    const privateTitle = 'Session title must stay local'
    await store.saveCheckpoint('project-hash', 'session-hash', 'Saved summary', privateTitle, 'private-project-directory')
    const child = spawn(process.execPath, [new URL('../src/mcp.js', import.meta.url).pathname], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.stdin.end([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'habit_memory_clear', arguments: { confirm: true } } }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'checkpoint_list', arguments: { project: 'project-hash', context: 'session-hash' } } }),
    ].join('\n') + '\n')
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })
    assert.equal(code, 0, stderr)
    const [list, attemptedClear, listed] = stdout.trim().split('\n').map(JSON.parse)
    assert.equal(list.result.tools.some(({ name }) => name === 'habit_memory_clear'), false)
    assert.equal(attemptedClear.result.isError, true)
    const checkpoints = JSON.parse(listed.result.content[0].text)
    assert.deepEqual(checkpoints.map(({ id, project, context, summary, createdAt }) => ({ id, project, context, summary, createdAt })), checkpoints)
    assert.equal(JSON.stringify(checkpoints).includes('sessionTitle'), false)
    assert.equal(JSON.stringify(checkpoints).includes(privateTitle), false)
    assert.equal(JSON.stringify(checkpoints).includes('projectDirectoryName'), false)
    assert.equal(JSON.stringify(checkpoints).includes('private-project-directory'), false)
    assert.equal(list.result.tools.find(({ name }) => name === 'checkpoint_save').inputSchema.properties.sessionTitle, undefined)
    assert.equal(list.result.tools.find(({ name }) => name === 'checkpoint_save').inputSchema.properties.projectDirectoryName, undefined)
    assert.deepEqual((await store.getData()).habits.counts, { 'tool:bash': 1 })
  } finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})
