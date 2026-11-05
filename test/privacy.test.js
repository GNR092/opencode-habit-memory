import assert from "node:assert/strict"
import test, { after, beforeEach } from "node:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const previousDataHome = process.env.XDG_DATA_HOME
const testDataHome = await mkdtemp(join(tmpdir(), "habit-memory-privacy-"))
process.env.XDG_DATA_HOME = testDataHome
const plugin = (await import("../index.js")).default
const { getData, saveHabitCounts, storePath } = await import("../src/store.js")
beforeEach(async () => { await rm(storePath, { force: true }); await rm(`${storePath}.lock`, { force: true }) })
after(async () => {
  if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = previousDataHome
  await rm(testDataHome, { recursive: true, force: true })
})

test("counts explicit user requests without persisting prompt data or clearing storage", async () => {
  await saveHabitCounts({})
  const values = new Map()
  const removeCalls = []
  const hooks = new Map()
  const tools = new Map()
  const commands = new Map()
  const storageReads = []
  const storageWrites = []
  const ctx = {
    storage: {
      async get(key) { storageReads.push(key); return structuredClone(values.get(key)) },
      async set(key, value) { storageWrites.push(key); values.set(key, structuredClone(value)) },
      async remove(key) { removeCalls.push(key); values.delete(key) },
    },
    tool: {
      async hook(name, callback) { hooks.set(`tool:${name}`, callback) },
      async transform(callback) { callback({ add(definition) { tools.set(definition.name, definition) } }) },
    },
    shell: { async hook(name, callback) { hooks.set(`shell:${name}`, callback) } },
    session: {
      async hook(name, callback) { hooks.set(`session:${name}`, callback) },
      async get({ sessionID }) { return { projectID: `test-${sessionID}` } },
      async synthetic() {},
    },
    command: {
      async transform(callback) { callback({ add(definition) { commands.set(definition.name, definition) } }) },
      async reload() {},
    },
  }

  await plugin.setup(ctx)
  const promptHook = hooks.get("session:prompt")
  for (let index = 0; index < 3; index++) {
    await promptHook({
      sessionID: "test-session",
      messageID: `explicit-${index}`,
      prompt: { text: `Por favor, ejecuta \`git status\` en /private/project token=secret-${index}`, agents: [] },
    })
    await hooks.get("tool:execute.after")({
      status: "completed",
      tool: "bash",
      input: { command: "git status --short /private/project", token: `secret-${index}` },
      result: { content: "private-output" },
    })
  }
  await promptHook({
    sessionID: "test-session",
    messageID: "casual-mention",
    prompt: { text: "¿Qué significa git status en /private/project?", agents: [] },
  })
  for (let index = 0; index < 3; index++) {
    await promptHook({
      sessionID: "test-session",
      messageID: `tool-request-${index}`,
      prompt: { text: "Usa la herramienta websearch para buscar esto", agents: [] },
    })
  }
  await promptHook({
    sessionID: "test-session",
    messageID: "subagent-request",
    prompt: { text: "Usa la herramienta subagent para delegar", agents: [] },
  })
  await promptHook({
    sessionID: "test-session",
    messageID: "explicit-0",
    prompt: { text: "Por favor, ejecuta `git status --short` en /private/project token=secret-0", agents: [] },
  })
  await promptHook({
    sessionID: "test-session",
    messageID: "manual-agent",
    prompt: { text: "Revisa esto", agents: [{ name: "code" }] },
  })
  await promptHook({
    sessionID: "test-session",
    messageID: "agent-directive",
    prompt: { text: "Usa el agente @explore para revisar", agents: [] },
  })
  for (let index = 0; index < 3; index++) {
    await promptHook({
      sessionID: "test-session",
      messageID: `specialized-agent-${index}`,
      prompt: { text: "Revisa esto", agents: [{ name: "django-expert" }] },
    })
  }
  await promptHook({
    sessionID: "test-session",
    messageID: "unallowlisted-agent",
    prompt: { text: "Revisa esto", agents: [{ name: "private-agent-secret" }] },
  })

  const profile = (await getData()).habits
  assert.equal(profile.counts["request:cli:git"], 3)
  assert.equal(profile.counts["request:tool:websearch"], 3)
  assert.equal(profile.counts["request:tool:subagent"], 1)
  assert.equal(profile.counts["request:agent:code"], 1)
  assert.equal(profile.counts["request:agent:explore"], 1)
  assert.equal(profile.counts["request:agent:django-expert"], 3)
  assert.equal(profile.counts["tool:bash"], 3)
  const serialized = JSON.stringify(profile)
  for (const secret of ["git status", "private", "secret-", "token", "private-agent-secret"]) {
    assert.equal(serialized.includes(secret), false)
  }

  await saveHabitCounts({ ...profile.counts, "request:cli:npm": 5 })
  const shown = await tools.get("habit_memory").execute({ action: "show" })
  assert.match(shown.content, /Solicitudes explícitas del usuario/)
  assert.match(shown.content, /solicita comando git \(3\)/)
  assert.match(shown.content, /solicita herramienta websearch \(3\)/)
  assert.match(shown.content, /selecciona agente django-expert \(3\)/)
  assert.match(shown.content, /Acciones de herramientas\/comandos hechas por agentes \(señal débil; no son hábitos del usuario\): herramienta bash \(3\)/)
  assert.match(shown.content, /solicita comando npm \(5\)/)
  assert.deepEqual(storageReads, ["profile-v1"])
  assert.deepEqual(storageWrites, [])
  assert.equal(commands.has("habit-memory-clear"), true)
  await commands.get("habit-memory-clear").execute({ sessionID: "test-session" })
  assert.deepEqual((await getData()).habits.counts, {})
  assert.deepEqual(storageWrites, [])
  assert.deepEqual(removeCalls, [])
})

test("checkpoint notices are suppressed until the oldest session is evicted", async () => {
  await saveHabitCounts({})
  const values = new Map()
  const hooks = new Map()
  const tools = new Map()
  const marker = "FIFO notice marker"
  const ctx = {
    storage: {
      async get(key) { return structuredClone(values.get(key)) },
      async set(key, value) { values.set(key, structuredClone(value)) },
    },
    tool: {
      async hook(name, callback) { hooks.set(`tool:${name}`, callback) },
      async transform(callback) { callback({ add(definition) { tools.set(definition.name, definition) } }) },
    },
    shell: { async hook() {} },
    session: {
      async hook(name, callback) { hooks.set(`session:${name}`, callback) },
      async get() { return { projectID: "checkpoint-notice-fifo-test" } },
      async synthetic() {},
    },
    command: {
      async transform(callback) { callback({ add() {} }) },
      async reload() {},
    },
  }

  await plugin.setup(ctx)
  await tools.get("project_checkpoint_save").execute(
    { objective: marker, next_step: "Verify retention" },
    { sessionID: "checkpoint-notice-oldest" },
  )
  const contextFor = async (sessionID) => {
    const event = { sessionID, system: [] }
    await hooks.get("session:context")(event)
    return event.system.some((part) => part.text.includes(marker))
  }

  assert.equal(await contextFor("checkpoint-notice-oldest"), true)
  assert.equal(await contextFor("checkpoint-notice-oldest"), false)
  for (let index = 0; index < 1023; index++) {
    await contextFor(`checkpoint-notice-${index}`)
  }
  assert.equal(await contextFor("checkpoint-notice-oldest"), false)
  await contextFor("checkpoint-notice-overflow")
  assert.equal(await contextFor("checkpoint-notice-oldest"), true)
})

test("project checkpoints stay isolated, sanitized, and clear only their project", async () => {
  await saveHabitCounts({})
  const values = new Map()
  const projectBySession = new Map([
    ["save-a", "project-a-id"],
    ["save-a-parallel", "project-a-id"],
    ["read-b", "project-b-id"],
    ["save-b", "project-b-id"],
    ["read-b2", "project-b-id"],
    ["read-a-new", "project-a-id"],
    ["read-a-continue", "project-a-id"],
    ["read-a-unclear", "project-a-id"],
    ["clear-a", "project-a-id"],
    ["global-session", "global"],
  ])
  const hooks = new Map()
  const tools = new Map()
  const commands = new Map()
  const reads = []
  const writes = []
  const removals = []
  const syntheticCalls = []
  const ctx = {
    storage: {
      async get(key) { reads.push(key); return structuredClone(values.get(key)) },
      async set(key, value) { writes.push(key); values.set(key, structuredClone(value)) },
      async remove(key) { removals.push(key); values.delete(key) },
    },
    tool: {
      async hook(name, callback) { hooks.set(`tool:${name}`, callback) },
      async transform(callback) { callback({ add(definition) { tools.set(definition.name, definition) } }) },
    },
    shell: { async hook(name, callback) { hooks.set(`shell:${name}`, callback) } },
    session: {
      async hook(name, callback) { hooks.set(`session:${name}`, callback) },
      async get({ sessionID }) {
        const projectID = projectBySession.get(sessionID)
        return projectID ? { projectID } : {}
      },
      async synthetic(input) { syntheticCalls.push(input) },
    },
    command: {
      async transform(callback) { callback({ add(definition) { commands.set(definition.name, definition) } }) },
      async reload() {},
    },
  }

  await plugin.setup(ctx)
  const save = tools.get("project_checkpoint_save")
  const promptHook = hooks.get("session:prompt")
  const contextHook = hooks.get("session:context")
  const clear = commands.get("project-checkpoint-clear")
  assert.ok(save)
  assert.ok(clear)
  assert.equal(tools.has("project-checkpoint-clear"), false)

  await save.execute({
    objective: "Implementar panel de métricas desde /home/alice/project con api_key=sk-live-secret-123 client_secret=another-secret y ```js\nconsole.log('no persistir')\n```",
    next_step: "Ejecutar pruebas en /Users/alice/private y password=topsecret-value; password is hunter two words.",
  }, { sessionID: "save-a" })
  const projectA = createHash("sha256").update("project-a-id").digest("hex")
  const contextA = `session-${createHash("sha256").update("save-a").digest("hex")}`
  const checkpointA = (await getData()).checkpoints.find((c) => c.project === projectA && c.context === contextA)
  assert.ok(checkpointA)
  assert.ok(checkpointA.summary.length <= 240)
  assert.match(checkpointA.summary, /Objetivo: Implementar panel de métricas/)
  assert.match(checkpointA.summary, /Siguiente paso: Ejecutar pruebas/)
  assert.equal(JSON.stringify(checkpointA).includes("project-a-id"), false)
  for (const secret of ["/home/alice", "/Users/alice", "api_key", "sk-live-secret", "client_secret", "another-secret", "password", "topsecret", "hunter", "two words", "console.log", "no persistir"]) {
    assert.equal(checkpointA.summary.includes(secret), false)
  }
  await save.execute({ objective: "Sesión paralela", next_step: "No sobrescribir" }, { sessionID: "save-a-parallel" })
  const contextParallel = `session-${createHash("sha256").update("save-a-parallel").digest("hex")}`
  const checkpointParallel = (await getData()).checkpoints.find((c) => c.project === projectA && c.context === contextParallel)
  assert.ok(checkpointParallel)
  assert.notEqual(checkpointParallel.id, checkpointA.id)

  const contextFor = async (sessionID) => {
    const event = { sessionID, system: [] }
    await contextHook(event)
    return event.system.map((part) => part.text).filter(Boolean).join(" ")
  }
  const promptFor = async (sessionID, messageID, text, agents = []) => {
    const event = { sessionID, messageID, prompt: { text, agents } }
    await promptHook(event)
    return event
  }

  const bBeforeSave = await contextFor("read-b")
  assert.equal(bBeforeSave.includes(checkpointA.summary), false)
  await save.execute({ objective: "Implementar servicio B", next_step: "Validar pruebas" }, { sessionID: "save-b" })
  const projectB = createHash("sha256").update("project-b-id").digest("hex")
  const contextB = `session-${createHash("sha256").update("save-b").digest("hex")}`
  const checkpointB = (await getData()).checkpoints.find((c) => c.project === projectB && c.context === contextB)
  assert.ok(checkpointB)
  assert.notEqual(contextA, contextB)
  const bSessionText = await contextFor("read-b2")
  assert.doesNotMatch(bSessionText, /Implementar servicio B/)
  assert.equal(bSessionText.includes(checkpointA.summary), false)

  const newRequest = "Inicia una tarea nueva: prepara un informe distinto."
  const admittedNewRequest = await promptFor("read-a-new", "new-request", newRequest)
  assert.equal(admittedNewRequest.prompt.text, newRequest)
  await save.execute({ objective: "Implementar panel de métricas", next_step: "Validar estado" }, { sessionID: "read-a-new" })
  const newSessionText = await contextFor("read-a-new")
  assert.match(newSessionText, /Objetivo: Implementar panel de métricas/)
  assert.match(newSessionText, /trabajo nuevo/)
  assert.doesNotMatch(newSessionText, /pregunta cuál de las dos opciones/)
  assert.equal((await contextFor("read-a-new")).includes(checkpointA.summary), false)

  await promptFor("read-a-continue", "continue-request", "Continúa desde el checkpoint anterior.")
  await save.execute({ objective: "Continuar tarea", next_step: "Verificar repo" }, { sessionID: "read-a-continue" })
  const continueText = await contextFor("read-a-continue")
  assert.match(continueText, /verifica el estado real del repositorio/)
  assert.doesNotMatch(continueText, /pregunta cuál de las dos opciones/)

  await promptFor("read-a-unclear", "unclear-request", "¿Puedes ayudarme con esto?")
  await save.execute({ objective: "Trabajo abierto", next_step: "Preguntar alcance" }, { sessionID: "read-a-unclear" })
  const unclearText = await contextFor("read-a-unclear")
  assert.match(unclearText, /No está claro si quiere continuar o empezar algo nuevo/)
  assert.equal((await contextFor("read-a-unclear")).includes(checkpointA.summary), false)

  const checkpointReadsBeforeMissingIdentity = reads.filter((key) => key.startsWith("project-checkpoint:v1:")).length
  const writesBeforeMissingIdentity = writes.length
  await save.execute({ objective: "No guardar", next_step: "Nada" }, { sessionID: "missing-project" })
  assert.equal(writes.length, writesBeforeMissingIdentity)
  await contextFor("global-session")
  assert.equal(reads.filter((key) => key.startsWith("project-checkpoint:v1:")).length, checkpointReadsBeforeMissingIdentity)

  await clear.execute({ sessionID: "save-a" })
  const dataAfterClear = await getData()
  assert.equal(dataAfterClear.checkpoints.some((c) => c.id === checkpointA.id), false)
  assert.equal(dataAfterClear.checkpoints.some((c) => c.id === checkpointB.id), true)
  assert.equal(dataAfterClear.checkpoints.some((c) => c.id === checkpointParallel.id), true)
  assert.deepEqual(removals, [])
  assert.deepEqual(writes, [])
  assert.deepEqual(reads, ["profile-v1", "project-checkpoint:v1:" + projectA, "project-checkpoint:v1:" + projectB])
  await clear.execute({ sessionID: "global-session" })
  assert.deepEqual(removals, [])
  assert.match(syntheticCalls.at(-1).text, /no hay checkpoint para borrar/i)
})
