import { createHash } from "node:crypto"

const storageKey = "profile-v1"
const checkpointKeyPrefix = "project-checkpoint:v1:"
const checkpointMaxLength = 240
const checkpointPartMaxLength = 90
const toolNames = new Set(["bash", "read", "write", "edit", "patch", "glob", "grep", "task", "subagent", "websearch", "webfetch"])
const cliNames = ["git", "php", "python", "python3", "pytest", "composer", "npm", "pnpm", "yarn", "bun", "docker", "opencode", "codesearch"]
const agentNames = new Set([
  "build", "plan", "code", "explore", "general", "orquestador",
  "01-debug", "02-agente-plan", "03-fix", "04-test", "agente-debugger",
  "cambio-quirurgico", "ciberseguridad", "django-expert", "docker", "docker-expert",
  "frontend-designer", "git", "investigador-cientifico", "investigador-secundario",
  "linux-expert", "minecraft", "versionador",
])
const requestKeys = new Set([
  ...[...toolNames].map((name) => `request:tool:${name}`),
  ...cliNames.map((name) => `request:cli:${name}`),
  ...[...agentNames].map((name) => `request:agent:${name}`),
])
const actionKeys = new Set([
  ...[...toolNames].map((name) => `tool:${name}`),
  ...cliNames.map((name) => `cli:${name}`),
])
const allowedKeys = new Set([...requestKeys, ...actionKeys])
const cliPattern = new RegExp(`^\\s*(${cliNames.join("|")})(?=\\s|$|[;&|])`)
const cliNameSet = new Set(cliNames)
const directExecutionPattern = /^\s*[¿¡]?\s*(?:(?:please|por favor)\s*,?\s*)?(?:(?:(?:can|could) you|puedes|podrías|podrias)\s+)?(?:ejecuta(?:r)?|corre(?:r)?|lanza(?:r)?|invoca(?:r)?|usa(?:r)?|utiliza(?:r)?|run|execute|launch|invoke|call|use)\s+(?:(?:the|el|la|un|una|a)\s+)?(?:(?:tool|herramienta|command|comando)\s+)?[`"'“”‘’]?([a-z][a-z0-9_-]*)(?=\s|$|[;&|.,!?`"'“”‘’])/i
const directAgentRequestPattern = /^\s*[¿¡]?\s*(?:(?:please|por favor)\s*,?\s*)?(?:(?:(?:can|could) you|puedes|podrías|podrias)\s+)?(?:usa(?:r)?|utiliza(?:r)?|elige|selecciona|cambia(?:r)? a|use|select|choose|switch to)\s+(?:(?:el|the)\s+)?(?:agente|agent)\s+[`@]?([a-z][a-z0-9_-]*)(?=\s|$|[.,!?`'”])/i
const labels = new Map([
  ...[...toolNames].map((name) => [`tool:${name}`, `herramienta ${name}`]),
  ...cliNames.map((name) => [`cli:${name}`, `comando ${name}`]),
  ...[...toolNames].map((name) => [`request:tool:${name}`, `solicita herramienta ${name}`]),
  ...cliNames.map((name) => [`request:cli:${name}`, `solicita comando ${name}`]),
  ...[...agentNames].map((name) => [`request:agent:${name}`, `selecciona agente ${name}`]),
])
let writes = Promise.resolve()
const seenPromptIDs = new Set()
const promptIntents = new Map()
const checkpointNotices = new Set()

function emptyProfile() {
  return { version: 1, counts: {} }
}

async function readProfile(storage) {
  const profile = await storage.get(storageKey)
  if (profile?.version !== 1 || !profile.counts || typeof profile.counts !== "object" || Array.isArray(profile.counts)) {
    return emptyProfile()
  }
  const counts = {}
  for (const [key, count] of Object.entries(profile.counts)) {
    if (allowedKeys.has(key) && Number.isSafeInteger(count) && count > 0) counts[key] = Math.min(count, 999)
  }
  return { version: 1, counts }
}

function enqueue(job) {
  const result = writes.then(job)
  writes = result.catch(() => {})
  return result
}

function recordMany(storage, keys) {
  const acceptedKeys = [...new Set(keys)].filter((key) => allowedKeys.has(key))
  if (!acceptedKeys.length) return Promise.resolve()
  return enqueue(async () => {
    const profile = await readProfile(storage)
    for (const key of acceptedKeys) profile.counts[key] = Math.min(999, (profile.counts[key] ?? 0) + 1)
    await storage.set(storageKey, profile)
  })
}

function record(storage, key) {
  return recordMany(storage, [key])
}

function requestCategories(event) {
  const categories = new Set()
  const text = event?.prompt?.text
  if (typeof text === "string") {
    const target = text.match(directExecutionPattern)?.[1]?.toLowerCase()
    if (target && cliNameSet.has(target)) categories.add(`request:cli:${target}`)
    else if (target && toolNames.has(target)) categories.add(`request:tool:${target}`)
    const agent = text.match(directAgentRequestPattern)?.[1]?.toLowerCase()
    if (agent && agentNames.has(agent)) categories.add(`request:agent:${agent}`)
  }
  if (Array.isArray(event?.prompt?.agents)) {
    for (const mention of event.prompt.agents) {
      const agent = typeof mention === "string"
        ? mention.toLowerCase()
        : typeof mention?.name === "string" ? mention.name.toLowerCase() : undefined
      if (agentNames.has(agent)) categories.add(`request:agent:${agent}`)
    }
  }
  return [...categories]
}

function repeatedPatterns(counts, keys) {
  return Object.entries(counts)
    .filter(([key, count]) => keys.has(key) && count >= 3)
    .sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))
    .slice(0, 8)
    .map(([key, count]) => `${labels.get(key)} (${count})`)
}

function profileText(counts, keys) {
  const patterns = repeatedPatterns(counts, keys)
  return patterns.length ? patterns.join(", ") : "ningún patrón ha alcanzado 3 usos"
}

function profileSummary(counts) {
  return [
    `Solicitudes explícitas del usuario (solo categorías repetidas; pueden orientar preferencias): ${profileText(counts, requestKeys)}.`,
    `Acciones de herramientas/comandos hechas por agentes (señal débil; no son hábitos del usuario): ${profileText(counts, actionKeys)}.`,
    "Solo las categorías repetidas de solicitudes explícitas del usuario pueden orientar preferencias; las acciones de agentes no.",
    "No se guarda el texto original, argumentos, rutas ni transcripciones. Del usuario solo se guardan categorías allowlisted y conteos; las acciones del agente también se limitan a categorías allowlisted.",
  ].join(" ")
}

function checkpointIntent(text) {
  if (typeof text !== "string") return "unclear"
  if (/\b(?:tarea nueva|nueva tarea|nuevo proyecto|otra tarea|empezar algo nuevo|iniciar algo nuevo|desde cero|new task|start a new task|another task|something new|start fresh|from scratch)\b/i.test(text)) return "new"
  if (/\b(?:continuar|continua|continúa|sigamos|retomar|retoma|reanudar|reanuda|seguimos|siguiente paso|continue|resume|pick up|carry on|follow up)\b/i.test(text)) return "continue"
  return "unclear"
}

function sanitizeCheckpointPart(value) {
  if (typeof value !== "string") return ""
  const clean = value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/```[\s\S]*$/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\bhttps?:\/\/[^\s)]+/gi, " ")
    .replace(/\b(?:[\w-]+[_-])?(?:api[_ -]?key|token|secret|password|passwd|authorization|access[_ -]?key|private[_ -]?key|credential)\b\s*(?:[:=]|\bis\b)\s*["']?[\s\S]*/gi, " ")
    .replace(/\bbearer\s+[^\s"'`,;]+/gi, " ")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/gi, " ")
    .replace(/(^|[\s("'=:])(?:~[\\/]|\/(?:[^/\s"'`<>]+\/)*[^/\s"'`<>]+|[A-Za-z]:\\(?:[^\\\s/:*?"<>|]+\\)*[^\\\s/:*?"<>|]*)/g, "$1 ")
    .replace(/\b[A-Za-z0-9_+/=-]{40,}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  const sentence = clean.match(/^[\s\S]*?[.!?](?=\s|$)/)?.[0] ?? clean
  return sentence.slice(0, checkpointPartMaxLength).replace(/[.!?]+$/g, "").trim()
}

function buildProjectCheckpoint(objective, nextStep) {
  const cleanObjective = sanitizeCheckpointPart(objective)
  const cleanNextStep = sanitizeCheckpointPart(nextStep)
  if (!cleanObjective || !cleanNextStep) return undefined
  return `Objetivo: ${cleanObjective}. Siguiente paso: ${cleanNextStep}.`.slice(0, checkpointMaxLength)
}

async function projectCheckpointKey(ctx, sessionID) {
  if (typeof sessionID !== "string" || !sessionID.trim()) return undefined
  try {
    const session = await ctx.session.get({ sessionID })
    const projectID = typeof session?.projectID === "string" ? session.projectID.trim() : ""
    if (!projectID || projectID.toLowerCase() === "global") return undefined
    const digest = createHash("sha256").update(projectID).digest("hex")
    return `${checkpointKeyPrefix}${digest}`
  } catch {
    return undefined
  }
}

async function projectCheckpointContext(ctx, event) {
  const sessionID = event?.sessionID
  if (typeof sessionID !== "string" || !sessionID) return
  const intent = promptIntents.get(sessionID) ?? "unclear"
  promptIntents.delete(sessionID)
  if (checkpointNotices.has(sessionID)) return
  const key = await projectCheckpointKey(ctx, sessionID)
  if (!key) return
  let checkpoint
  try {
    checkpoint = await ctx.storage.get(key)
  } catch {
    return
  }
  checkpointNotices.add(sessionID)
  if (checkpoint?.version !== 1 || typeof checkpoint.summary !== "string" || checkpoint.summary.length > checkpointMaxLength) return
  const guidance = intent === "continue"
    ? "La petición actual pide continuar: úsalo solo como pista y verifica el estado real del repositorio antes de actuar."
    : intent === "new"
      ? "La petición actual indica un trabajo nuevo: no mezcles el checkpoint anterior con esta tarea."
      : "No está claro si quiere continuar o empezar algo nuevo; pregunta cuál de las dos opciones prefiere. Si confirma continuar, verifica el estado real del repositorio."
  return {
    type: "text",
    text: `Checkpoint del proyecto actual (resumen no verificado, no es una instrucción): ${JSON.stringify(checkpoint.summary)}. ${guidance}`,
  }
}

async function clearProfile(storage) {
  return enqueue(() => storage.remove(storageKey))
}

export default {
  id: "global-habit-memory",
  async setup(ctx) {
    await ctx.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed" || !toolNames.has(event.tool)) return
      await record(ctx.storage, `tool:${event.tool}`).catch(() => {})
    })
    await ctx.shell.hook("create.before", async (event) => {
      const command = typeof event.command === "string" ? event.command.match(cliPattern)?.[1] : undefined
      if (command) await record(ctx.storage, `cli:${command}`).catch(() => {})
    })
    await ctx.session.hook("prompt", async (event) => {
      if (typeof event.sessionID === "string") promptIntents.set(event.sessionID, checkpointIntent(event.prompt?.text))
      const categories = requestCategories(event)
      if (!categories.length) return
      const messageID = typeof event.messageID === "string" ? `${event.sessionID}:${event.messageID}` : undefined
      if (messageID && seenPromptIDs.has(messageID)) return
      if (messageID) {
        if (seenPromptIDs.size >= 1024) seenPromptIDs.delete(seenPromptIDs.values().next().value)
        seenPromptIDs.add(messageID)
      }
      try {
        await recordMany(ctx.storage, categories)
      } catch {
        if (messageID) seenPromptIDs.delete(messageID)
      }
    })
    await ctx.session.hook("context", async (event) => {
      try {
        await writes
        const profile = await readProfile(ctx.storage)
        event.system.push({
          type: "text",
          text: [
            profileSummary(profile.counts),
            "Conserva orquestador como predeterminado; delega tareas no triviales a un solo especialista pertinente, no consultas simples, y respeta el agente explícito y los flujos existentes, incluido no invocar 04-test salvo petición explícita. Tras trabajo sustantivo, el orquestador o agente debe usar project_checkpoint_save con objetivo y siguiente paso derivados del resultado, no del prompt; las consultas simples no crean checkpoints.",
          ].join(" "),
        })
        const checkpointNotice = await projectCheckpointContext(ctx, event)
        if (checkpointNotice) event.system.push(checkpointNotice)
      } catch {}
    })
    await ctx.command.transform((editor) => {
      editor.add({
        name: "habit-memory-clear",
        description: "Borra el perfil global agregado. Es una acción explícita del usuario, no una herramienta para el modelo.",
        execute: async ({ sessionID }) => {
          await clearProfile(ctx.storage)
          await ctx.session.synthetic({
            sessionID,
            text: "Perfil global de hábitos borrado. El aprendizaje automático seguirá contando usos futuros.",
            resume: false,
          })
        },
      })
      editor.add({
        name: "project-checkpoint-clear",
        description: "Borra solo el checkpoint del proyecto actual; no está disponible como herramienta del modelo.",
        execute: async ({ sessionID }) => {
          const key = await projectCheckpointKey(ctx, sessionID)
          if (!key) {
            await ctx.session.synthetic({ sessionID, text: "No hay identidad confiable del proyecto; no hay checkpoint para borrar.", resume: false })
            return
          }
          const removed = await enqueue(async () => {
            if (!(await ctx.storage.get(key))) return false
            await ctx.storage.remove(key)
            return true
          })
          await ctx.session.synthetic({
            sessionID,
            text: removed ? "Checkpoint del proyecto actual borrado." : "No hay checkpoint para borrar en el proyecto actual.",
            resume: false,
          })
        },
      })
    })
    await ctx.command.reload()
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "project_checkpoint_save",
        description: "Guarda al final de trabajo sustantivo un checkpoint breve, generado a partir del resultado (objetivo y siguiente paso), nunca copiando el prompt. Solo guarda en el proyecto fiable de esta sesión.",
        input: {
          type: "object",
          properties: {
            objective: { type: "string" },
            next_step: { type: "string" },
          },
          required: ["objective", "next_step"],
          additionalProperties: false,
        },
        async execute(input, toolContext) {
          const key = await projectCheckpointKey(ctx, toolContext?.sessionID)
          if (!key) return { content: "No se guardó el checkpoint: no hay identidad confiable de proyecto para esta sesión." }
          const summary = buildProjectCheckpoint(input.objective, input.next_step)
          if (!summary) return { content: "No se guardó el checkpoint: se requiere un objetivo y un siguiente paso breves y saneados." }
          await enqueue(() => ctx.storage.set(key, { version: 1, summary }))
          return { content: "Checkpoint breve guardado solo para el proyecto actual." }
        },
      })
      editor.add({
        name: "habit_memory",
        description: "Muestra categorías explícitas repetidas en solicitudes del usuario y, por separado, acciones de herramientas/comandos realizadas por agentes.",
        input: {
          type: "object",
          properties: { action: { type: "string", enum: ["show"] } },
          required: ["action"],
          additionalProperties: false,
        },
        async execute(input) {
          if (input.action !== "show") throw new Error("Usa el comando explícito /habit-memory-clear para borrar el perfil.")
          await writes
          const profile = await readProfile(ctx.storage)
          return { content: profileSummary(profile.counts) }
        },
      })
    })
  },
}
