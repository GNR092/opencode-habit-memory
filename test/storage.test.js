import assert from "node:assert/strict"
import test, { after, beforeEach } from "node:test"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const previousDataHome = process.env.XDG_DATA_HOME
const testDataHome = await mkdtemp(join(tmpdir(), "habit-memory-storage-"))
process.env.XDG_DATA_HOME = testDataHome
const { getData, saveCheckpoint, listCheckpoints, listCheckpointContexts, deleteCheckpoint, clearCheckpoints, importLegacy, storePath } = await import("../src/store.js")
beforeEach(async () => { await rm(storePath, { force: true }); await rm(`${storePath}.lock`, { force: true }) })
after(async () => {
  if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = previousDataHome
  await rm(testDataHome, { recursive: true, force: true })
})

test("retention, isolation, migration idempotence and scoped deletion", async () => {
  for (let i = 0; i < 23; i++) await saveCheckpoint("project-a", "ctx", `Checkpoint ${i}`)
  await saveCheckpoint("project-a", "other", "Other context")
  await saveCheckpoint("project-b", "ctx", "Other project")
  assert.equal((await listCheckpoints("project-a", "ctx")).length, 20)
  assert.equal((await listCheckpoints("project-a", "other")).length, 1)
  assert.deepEqual(await listCheckpointContexts("project-a"), ["ctx", "other"])
  const list = await listCheckpoints("project-a", "ctx")
  assert.equal(list.some((v) => v.summary === "Checkpoint 0"), false)
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
    const code = `const s=await import(${JSON.stringify(moduleUrl)}); await Promise.all(Array.from({length:12},(_,i)=>s.saveCheckpoint('parallel','ctx',${JSON.stringify(label)}+' '+i)))`
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: process.env, stdio: "ignore" })
      child.on("error", reject)
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)))
    })
  })
  await Promise.all(jobs)
  assert.equal((await listCheckpoints("parallel", "ctx")).length, 20)
  const data = await getData()
  assert.equal(data.version, 1)
})
