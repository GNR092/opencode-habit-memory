#!/usr/bin/env node
import { createInterface } from "node:readline"
import { getData, listCheckpoints, listCheckpointContexts, saveCheckpoint, deleteCheckpoint, clearCheckpoints } from "./store.js"
import { logCommandError } from "./error-log.js"

const tools = [
  { name: "habit_memory_get", description: "Get aggregated habit counts only.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "checkpoint_list", description: "List checkpoints for a project and context.", inputSchema: { type: "object", properties: { project: { type: "string", maxLength: 128 }, context: { type: "string", maxLength: 128 } }, required: ["project", "context"], additionalProperties: false } },
  { name: "checkpoint_projects", description: "List project scope hashes already present, for sharing plugin checkpoints across clients.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "checkpoint_contexts", description: "List checkpoint contexts for a project scope.", inputSchema: { type: "object", properties: { project: { type: "string", maxLength: 128 } }, required: ["project"], additionalProperties: false } },
  { name: "checkpoint_save", description: "Save an explicit short checkpoint; never pass prompts or transcripts.", inputSchema: { type: "object", properties: { project: { type: "string", maxLength: 128 }, context: { type: "string", maxLength: 128 }, summary: { type: "string", maxLength: 240 } }, required: ["project", "context", "summary"], additionalProperties: false } },
  { name: "checkpoint_delete", description: "Delete one checkpoint by ID.", inputSchema: { type: "object", properties: { project: { type: "string", maxLength: 128 }, context: { type: "string", maxLength: 128 }, id: { type: "string", maxLength: 80 } }, required: ["project", "context", "id"], additionalProperties: false } },
  { name: "checkpoint_clear", description: "Explicitly delete all checkpoints for one project/context.", inputSchema: { type: "object", properties: { project: { type: "string", maxLength: 128 }, context: { type: "string", maxLength: 128 }, confirm: { type: "boolean", const: true } }, required: ["project", "context", "confirm"], additionalProperties: false } },
]
const toolNames = new Set(tools.map(({ name }) => name))
const reply = (id, result, error) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error: { code: -32603, message: error.message } } : { result }) })}\n`)
async function call(name, a) {
  if (!a || Object.keys(a).some((k) => !({ habit_memory_get: [], checkpoint_list: ["project","context"], checkpoint_projects: [], checkpoint_contexts: ["project"], checkpoint_save: ["project","context","summary"], checkpoint_delete: ["project","context","id"], checkpoint_clear: ["project","context","confirm"] }[name] ?? []).includes(k))) throw new Error("Invalid tool arguments")
  if (name === "habit_memory_get" && Object.keys(a).length === 0) return (await getData()).habits
  if (name === "checkpoint_projects" && Object.keys(a).length === 0) return [...new Set((await getData()).checkpoints.map((c) => c.project))]
  if (name === "checkpoint_contexts") return listCheckpointContexts(a.project)
  if (name === "checkpoint_list") return (await listCheckpoints(a.project, a.context)).map(({ id, project, context, summary, createdAt }) => ({ id, project, context, summary, createdAt }))
  if (name === "checkpoint_save") return saveCheckpoint(a.project, a.context, a.summary)
  if (name === "checkpoint_delete") return deleteCheckpoint(a.project, a.context, a.id)
  if (name === "checkpoint_clear" && a.confirm === true) return clearCheckpoints(a.project, a.context)
  throw new Error("Unknown tool or explicit confirmation required")
}
const rl = createInterface({ input: process.stdin })
for await (const line of rl) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch (error) {
    logCommandError("habit-memory-mcp", "parse-request", error)
    reply(null, null, error)
    continue
  }
  try {
    if (msg.method === "initialize") reply(msg.id, { protocolVersion: msg.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "habit-memory", version: "1.0.0" } })
    else if (msg.method === "notifications/initialized" || msg.id === undefined) continue
    else if (msg.method === "ping") reply(msg.id, {})
    else if (msg.method === "tools/list") reply(msg.id, { tools })
    else if (msg.method === "tools/call") {
      const command = toolNames.has(msg.params?.name) ? `MCP ${msg.params.name}` : "MCP tools/call"
      try { const result = await call(msg.params?.name, msg.params?.arguments ?? {}); reply(msg.id, { content: [{ type: "text", text: JSON.stringify(result) }] }) }
      catch (error) {
        logCommandError(command, "execute", error)
        reply(msg.id, { content: [{ type: "text", text: error.message }], isError: true })
      }
    } else {
      const error = new Error("Method not found")
      logCommandError("habit-memory-mcp", "dispatch", error)
      reply(msg.id, null, error)
    }
  } catch (error) {
    logCommandError("habit-memory-mcp", "dispatch", error)
    reply(null, null, error)
  }
}
