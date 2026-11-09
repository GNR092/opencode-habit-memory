import assert from "node:assert/strict"
import test, { after, beforeEach } from "node:test"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const previousDataHome = process.env.XDG_DATA_HOME
const testDataHome = await mkdtemp(join(tmpdir(), "habit-memory-storage-"))
process.env.XDG_DATA_HOME = testDataHome
const { clearHabits, getData, incrementHabitCounts, saveCheckpoint, updateCheckpoint, listCheckpoints, listCheckpointContexts, deleteCheckpoint, clearCheckpoints, importLegacy, storePath } = await import("../src/store.js")
const lockPath = `${storePath}.lock`
beforeEach(async () => { await rm(storePath, { force: true }); await rm(lockPath, { force: true }); await rm(`${lockPath}.recovery`, { force: true }) })
after(async () => {
  if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = previousDataHome
  await rm(testDataHome, { recursive: true, force: true })
})

test("checkpoint retention, isolation, migration idempotence and scoped deletion", async () => {
  for (let i = 0; i < 23; i++) await saveCheckpoint("project-a", "ctx", `Checkpoint ${i}`)
  await saveCheckpoint("project-a", "other", "Other context")
  await saveCheckpoint("project-b", "ctx", "Other project")
  assert.equal((await listCheckpoints("project-a", "ctx")).length, 23)
  assert.equal((await listCheckpoints("project-a", "other")).length, 1)
  assert.deepEqual(await listCheckpointContexts("project-a"), ["ctx", "other"])
  const list = await listCheckpoints("project-a", "ctx")
  assert.equal(list.some((v) => v.summary === "Checkpoint 0"), true)
  assert.equal(await deleteCheckpoint("project-a", "ctx", list[0].id), true)
  assert.equal((await listCheckpoints("project-b", "ctx")).length, 1)
  await clearCheckpoints("project-a", "ctx")
  assert.equal((await listCheckpoints("project-a", "ctx")).length, 0)
  await importLegacy({ version: 1, counts: { "request:cli:git": 4 } }, { version: 1, project: "legacy-project", summary: "Explicit legacy summary" })
  await importLegacy({ version: 1, counts: { "request:cli:git": 9 } }, { version: 1, project: "legacy-project", summary: "Different" })
  const data = await getData()
  assert.equal(data.habits.counts["request:cli:git"], 4)
  assert.equal(data.checkpoints.filter((c) => c.id === "legacy-legacy-project").length, 1)
  assert.equal(JSON.stringify(data).includes("transcript"), false)
})

test("independent processes preserve writes and atomic JSON remains readable", async () => {
  const moduleUrl = new URL("../src/store.js", import.meta.url).href
  const jobs = ["one", "two"].map((label) => {
    const code = `const s=await import(${JSON.stringify(moduleUrl)}); await Promise.all(Array.from({length:12},(_,i)=>Promise.all([s.saveCheckpoint('parallel','ctx',${JSON.stringify(label)}+' '+i),s.incrementHabitCounts(['tool:bash','request:cli:npm'])])))`
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: process.env, stdio: "ignore" })
      child.on("error", reject)
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)))
    })
  })
  await Promise.all(jobs)
  assert.equal((await listCheckpoints("parallel", "ctx")).length, 24)
  const data = await getData()
  assert.equal(data.version, 1)
  assert.equal(data.habits.counts["tool:bash"], 24)
  assert.equal(data.habits.counts["request:cli:npm"], 24)
  assert.equal(data.habits.daily[new Date().toISOString().slice(0, 10)]["tool:bash"], 24)
})

test("recovers stale empty and invalid-PID locks after the 120-second grace period", async () => {
  await mkdir(dirname(storePath), { recursive: true })
  for (const [index, contents] of ["", "not-a-pid"].entries()) {
    await writeFile(lockPath, contents)
    const stale = new Date(Date.now() - 120_001)
    await utimes(lockPath, stale, stale)
    assert.equal((await saveCheckpoint("recovery", "ctx", `recovered ${index}`)).summary, `recovered ${index}`)
    await assert.rejects(stat(lockPath), { code: "ENOENT" })
  }
})

test("fails closed while another process holds the recovery claim", async () => {
  await mkdir(dirname(storePath), { recursive: true })
  await writeFile(lockPath, "")
  const stale = new Date(Date.now() - 120_001)
  await utimes(lockPath, stale, stale)
  await writeFile(`${lockPath}.recovery`, "in progress")
  const before = await stat(lockPath)
  const pending = saveCheckpoint("recovery", "ctx", "wait for claim")
  await new Promise((resolve) => setTimeout(resolve, 100))
  const current = await stat(lockPath)
  assert.equal(current.ino, before.ino)
  assert.equal(await readFile(lockPath, "utf8"), "")
  await rm(`${lockPath}.recovery`, { force: true })
  assert.equal((await pending).summary, "wait for claim")
})

test("does not reclaim a young invalid-PID lock or a stale lock with a live PID", async () => {
  await mkdir(dirname(storePath), { recursive: true })
  for (const [contents, age] of [["not-a-pid", 90_000], [String(process.pid), 120_001]]) {
    await writeFile(lockPath, contents)
    if (age > 120_000) {
      const stale = new Date(Date.now() - age)
      await utimes(lockPath, stale, stale)
    }
    const before = await stat(lockPath)
    let pending
    try {
      pending = saveCheckpoint("protected", "ctx", "wait for owner")
      await new Promise((resolve) => setTimeout(resolve, 100))
      const current = await stat(lockPath)
      assert.equal(current.ino, before.ino)
      assert.equal(await readFile(lockPath, "utf8"), contents)
    } finally {
      await rm(lockPath, { force: true })
      await pending?.catch(() => {})
    }
  }
})

test("concurrent processes recover one stale invalid-PID lock without losing writes", async () => {
  await mkdir(dirname(storePath), { recursive: true })
  await writeFile(lockPath, "invalid")
  const stale = new Date(Date.now() - 120_001)
  await utimes(lockPath, stale, stale)
  const moduleUrl = new URL("../src/store.js", import.meta.url).href
  const jobs = ["one", "two"].map((label) => {
    const code = `const s=await import(${JSON.stringify(moduleUrl)}); await Promise.all(Array.from({length:8},(_,i)=>s.saveCheckpoint('recovery-race','ctx',${JSON.stringify(label)}+' '+i)))`
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: process.env, stdio: "ignore" })
      child.on("error", reject)
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)))
    })
  })
  await Promise.all(jobs)
  assert.equal((await listCheckpoints("recovery-race", "ctx")).length, 16)
  assert.equal((await getData()).checkpoints.length, 16)
})

test("legacy stores without daily history read unchanged and gain no invented dates", async () => {
  const legacy = { version: 1, habits: { version: 1, counts: { "request:cli:git": 7 }, legacyImported: true }, checkpoints: [{ id: "legacy", project: "p", context: "c", summary: "saved", createdAt: "2020-01-01T00:00:00.000Z" }] }
  const raw = JSON.stringify(legacy)
  await mkdir(dirname(storePath), { recursive: true })
  await writeFile(storePath, raw)
  const data = await getData()
  assert.deepEqual(data.habits.counts, legacy.habits.counts)
  assert.deepEqual(data.habits.daily, {})
  assert.deepEqual(data.checkpoints, legacy.checkpoints)
  assert.equal(await readFile(storePath, "utf8"), raw)
})

test("checkpoint titles are optional, bounded, preserved on edit, and absent from legacy records", async () => {
  const legacy = { version: 1, habits: { version: 1, counts: {} }, checkpoints: [{ id: "legacy", project: "p", context: "c", summary: "saved", createdAt: "2020-01-01T00:00:00.000Z" }] }
  await mkdir(dirname(storePath), { recursive: true })
  await writeFile(storePath, JSON.stringify(legacy))
  assert.equal(Object.hasOwn((await getData()).checkpoints[0], "sessionTitle"), false)

  const untitled = await saveCheckpoint("p", "c", "MCP checkpoint")
  assert.equal(Object.hasOwn(untitled, "sessionTitle"), false)
  const titled = await saveCheckpoint("p", "c", "OpenCode checkpoint", "  Session title  ")
  assert.equal(titled.sessionTitle, "Session title")
  assert.equal(await updateCheckpoint("p", "c", titled.id, "Edited summary"), true)
  assert.equal((await listCheckpoints("p", "c")).find(({ id }) => id === titled.id).sessionTitle, "Session title")
  for (const invalid of [" ", "x".repeat(201), 42]) {
    const record = await saveCheckpoint("p", "c", "Still saved", invalid)
    assert.equal(Object.hasOwn(record, "sessionTitle"), false)
  }

  const data = await getData()
  data.checkpoints.find(({ id }) => id === titled.id).sessionTitle = "x".repeat(201)
  await writeFile(storePath, JSON.stringify(data))
  await assert.rejects(getData(), /Invalid checkpoint data/)
})

test("checkpoint project directory names are optional, basename-only, and legacy-safe", async () => {
  const legacy = { version: 1, habits: { version: 1, counts: {} }, checkpoints: [{ id: "legacy", project: "p", context: "c", summary: "saved", createdAt: "2020-01-01T00:00:00.000Z" }] }
  await mkdir(dirname(storePath), { recursive: true })
  await writeFile(storePath, JSON.stringify(legacy))
  assert.equal(Object.hasOwn((await getData()).checkpoints[0], "projectDirectoryName"), false)

  const named = await saveCheckpoint("p", "c", "Named checkpoint", undefined, "  My Project  ")
  assert.equal(named.projectDirectoryName, "My Project")
  assert.equal(await updateCheckpoint("p", "c", named.id, "Edited summary"), true)
  assert.equal((await listCheckpoints("p", "c")).find(({ id }) => id === named.id).projectDirectoryName, "My Project")

  for (const invalid of ["/home/alice/project", "a/b", "a\\b", "x".repeat(129), " ", ".", "..", 42]) {
    const record = await saveCheckpoint("p", "c", "Still saved", undefined, invalid)
    assert.equal(Object.hasOwn(record, "projectDirectoryName"), false)
  }

  const data = await getData()
  data.checkpoints.find(({ id }) => id === named.id).projectDirectoryName = "/home/alice/project"
  await writeFile(storePath, JSON.stringify(data))
  await assert.rejects(getData(), /Invalid checkpoint data/)
})

test("daily counters roll over in UTC and retain only the latest 365 days", async () => {
  const RealDate = globalThis.Date
  let now = "2024-01-01T00:00:00.000Z"
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])) }
    static now() { return new RealDate(now).getTime() }
  }
  try {
    const categories = ["tool:bash", "request:tool:read", "cli:npm", "request:cli:git", "request:agent:code"]
    await incrementHabitCounts(categories)
    assert.deepEqual(Object.keys((await getData()).habits.daily["2024-01-01"]).sort(), [...categories].sort())
    now = "2024-01-02T00:05:00.000Z"
    await incrementHabitCounts(categories)
    const rollover = await getData()
    assert.deepEqual(Object.keys(rollover.habits.daily["2024-01-02"]).sort(), [...categories].sort())
    for (const key of categories) assert.equal(rollover.habits.counts[key], 2)
    for (let day = 2; day <= 365; day++) {
      now = new RealDate(RealDate.UTC(2024, 0, 1 + day)).toISOString()
      await incrementHabitCounts(["tool:bash"])
    }
    const data = await getData()
    assert.equal(Object.keys(data.habits.daily).length, 365)
    assert.equal(Object.hasOwn(data.habits.daily, "2024-01-01"), false)
    assert.equal(data.habits.daily["2024-01-02"]["request:agent:code"], 1)
    assert.equal(data.habits.daily["2024-12-31"]["tool:bash"], 1)
    assert.equal(data.habits.counts["tool:bash"], 366)
  } finally { globalThis.Date = RealDate }
})

test("clearing habits atomically preserves checkpoints and legacy-import protection", async () => {
  await importLegacy({ version: 1, counts: { "request:cli:git": 8 } })
  await incrementHabitCounts(["tool:bash"])
  await saveCheckpoint("keep", "ctx", "checkpoint")
  await clearHabits()
  const cleared = await getData()
  assert.deepEqual(cleared.habits.counts, {})
  assert.deepEqual(cleared.habits.daily, {})
  assert.equal(cleared.habits.legacyImported, true)
  assert.equal(cleared.checkpoints.length, 1)
  await importLegacy({ version: 1, counts: { "request:cli:git": 99 } })
  assert.deepEqual((await getData()).habits.counts, {})
})

test("daily history rejects invalid dates and non-allowlisted keys", async () => {
  await mkdir(dirname(storePath), { recursive: true })
  await writeFile(storePath, JSON.stringify({ version: 1, habits: { version: 1, counts: {}, daily: { "2024-02-30": { "tool:bash": 1 } } }, checkpoints: [] }))
  await assert.rejects(getData(), /Invalid daily habit data/)
})
