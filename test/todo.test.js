import assert from "node:assert/strict"
import test, { after } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const previousDataHome = process.env.XDG_DATA_HOME
const testDataHome = await mkdtemp(join(tmpdir(), "habit-memory-todos-"))
process.env.XDG_DATA_HOME = testDataHome
const plugin = (await import("../index.js")).default
const { getData, storePath } = await import("../src/store.js")
after(async () => {
  if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = previousDataHome
  await rm(testDataHome, { recursive: true, force: true })
})

test("project TODO tools resume pending work and keep updates scoped", async () => {
  const projectBySession = new Map([
    ["todo-save", "project-a"],
    ["todo-resume", "project-a"],
    ["todo-new", "project-a"],
    ["todo-completed", "project-a"],
    ["todo-other", "project-b"],
  ])
  const directoryBySession = new Map([["todo-save", "/home/gener/projects/habit-memory"]])
  const hooks = new Map(), tools = new Map(), commands = new Map(), values = new Map()
  const ctx = {
    storage: {
      async get(key) { return structuredClone(values.get(key)) },
      async set(key, value) { values.set(key, structuredClone(value)) },
    },
    tool: {
      async hook(name, callback) { hooks.set(`tool:${name}`, callback) },
      async transform(callback) { callback({ add(definition) { tools.set(definition.name, definition) } }) },
    },
    shell: { async hook(name, callback) { hooks.set(`shell:${name}`, callback) } },
    session: {
      async hook(name, callback) { hooks.set(`session:${name}`, callback) },
      async get({ sessionID }) { return { projectID: projectBySession.get(sessionID), location: { directory: directoryBySession.get(sessionID) } } },
      async synthetic() {},
    },
    command: {
      async transform(callback) { callback({ add(definition) { commands.set(definition.name, definition) } }) },
      async reload() {},
    },
  }

  await rm(storePath, { force: true })
  await rm(`${storePath}.lock`, { force: true })
  await plugin.setup(ctx)
  const list = tools.get("project_todo_list"), create = tools.get("project_todo_create")
  const update = tools.get("project_todo_update"), archive = tools.get("project_todo_archive")
  assert.ok(list && create && update && archive)

  const created = JSON.parse((await create.execute({ task: "Implement a durable TODO" }, { sessionID: "todo-save" })).content)
  assert.equal(created.status, "pending")
  assert.equal((await getData()).todos.find(({ id }) => id === created.id).projectDirectoryName, "habit-memory")
  assert.deepEqual(JSON.parse((await list.execute({}, { sessionID: "todo-other" })).content), [])

  const prompt = hooks.get("session:prompt")
  await prompt({ sessionID: "todo-resume", messageID: "continue", prompt: { text: "Continúa el trabajo", agents: [] } })
  const resumed = { sessionID: "todo-resume", system: [] }
  await hooks.get("session:context")(resumed)
  const resumedText = resumed.system.map(({ text }) => text ?? "").join(" ")
  assert.match(resumedText, /Implement a durable TODO/)
  assert.match(resumedText, /project_todo_update inmediatamente/)
  assert.match(resumedText, /verifica el estado real del repositorio/)

  await prompt({ sessionID: "todo-new", messageID: "new", prompt: { text: "Inicia una tarea nueva", agents: [] } })
  const fresh = { sessionID: "todo-new", system: [] }
  await hooks.get("session:context")(fresh)
  assert.doesNotMatch(fresh.system.map(({ text }) => text ?? "").join(" "), /Implement a durable TODO/)

  assert.match((await update.execute({ id: created.id, status: "completed" }, { sessionID: "todo-save" })).content, /actualizado/)
  const completed = JSON.parse((await list.execute({}, { sessionID: "todo-resume" })).content)
  assert.equal(completed[0].status, "completed")
  assert.match((await archive.execute({ id: created.id }, { sessionID: "todo-save" })).content, /archivado/)
  assert.deepEqual(JSON.parse((await list.execute({}, { sessionID: "todo-save" })).content), [])
  assert.equal(JSON.parse((await list.execute({ include_archived: true }, { sessionID: "todo-save" })).content)[0].status, "archived")
})
