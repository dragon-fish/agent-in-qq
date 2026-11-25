import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

type Frame = Record<string, any>
type RequestId = number | string
type PendingRequest = {
  resolve(value: any): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

class AppServer {
  private readonly child = spawn(process.env.QQ_CODEX_PATH || 'codex', ['app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
    // The coding engine uses its own saved login and config.
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !['QQ_APP_ID', 'QQ_CLIENT_SECRET'].includes(key))),
  })
  private readonly lines = createInterface({ input: this.child.stdout })
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 0
  private stopped = false

  onNotification: (method: string, params: Frame) => void = () => {}
  onRequest: (method: string, params: Frame) => Promise<unknown> = async () => {
    throw new Error('Request has no active Codex conversation')
  }
  onClose: (error?: Error) => void = () => {}

  constructor() {
    this.lines.on('line', line => this.receive(line))
    this.child.on('error', error => this.close(error))
    this.child.stdin.on('error', error => this.close(error))
    this.child.once('exit', (code, signal) => this.close(new Error(`Codex App Server exited (${signal ?? code})`)))
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'agent-in-qq', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    })
    this.send({ method: 'initialized' })
  }

  request<T = Frame>(method: string, params: Frame = {}): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Codex App Server is closed'))
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex App Server timed out: ${method}`))
      }, 60_000)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ id, method, params })
    })
  }

  private send(message: Frame) {
    if (!this.stopped) this.child.stdin.write(JSON.stringify(message) + '\n')
  }

  private receive(line: string) {
    let message: Frame
    try {
      message = JSON.parse(line)
    } catch {
      this.close(new Error('Invalid JSON from Codex App Server'))
      return
    }

    const { id, method, params, error, result } = message
    if (typeof method === 'string') {
      if (typeof id === 'number' || typeof id === 'string') {
        void this.respond(id, method, params ?? {})
      } else {
        this.onNotification(method, params ?? {})
      }
      return
    }
    const request = this.pending.get(id)
    if (!request) return
    this.pending.delete(id)
    clearTimeout(request.timer)
    if (error) request.reject(new Error(error.message))
    else request.resolve(result)
  }

  private async respond(id: RequestId, method: string, params: Frame) {
    try {
      const result = await this.onRequest(method, params)
      this.send({ id, result })
    } catch (error) {
      this.send({ id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } })
    }
  }

  close(error?: Error) {
    if (this.stopped) return
    this.stopped = true
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error ?? new Error('Codex App Server is closed'))
    }
    this.pending.clear()
    this.lines.close()
    this.child.stdin.end()
    if (this.child.pid && this.child.exitCode === null && this.child.signalCode === null) this.child.kill()
    this.onClose(error)
  }
}

type InputBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { media_type: string; data: string } }

export type AgentInput = {
  uuid: string
  message: { content: string | InputBlock[] }
}

type InputQueue = AsyncIterable<AgentInput> & {
  peekBuffered(index: number): AgentInput | undefined
  removeBuffered(uuid: string): void
}

type Tool = Pick<SdkMcpToolDefinition, 'name' | 'description'> & {
  inputSchema: z.ZodRawShape
  handler(args: Record<string, unknown>, extra: unknown): ReturnType<SdkMcpToolDefinition['handler']>
}

type CodexOptions = {
  cwd: string
  resume: string | null
  instructions: string
  mode: string
  groupChat: boolean
  tools: Tool[]
  approve(name: string, input: Record<string, unknown>): Promise<boolean>
  cancelInteraction(): void
}

type ActiveTurn = {
  inputs: string[]
  id?: string
  compact: boolean
  pendingSteers: Set<string>
  steering: boolean
  steerRejected: boolean
  started: Promise<void>
  markStarted(): void
  finish(): void
}

type ContextUsage = { model: string; totalTokens: number; maxTokens: number; percentage?: number }

export const CODEX_DEFAULT_MODE = 'workspace-write'
export const CODEX_FULL_ACCESS = 'danger-full-access'

export function codexModes(groupChat: boolean) {
  return [
    { value: 'read-only', label: '只读', desc: '只读沙箱，额外权限需审批' },
    {
      value: CODEX_DEFAULT_MODE, label: '工作区可写',
      desc: groupChat ? '工作区外写入及网络访问由 Codex 自动审批' : '工作区外写入及网络访问需审批',
    },
    { value: CODEX_FULL_ACCESS, label: '完整访问', desc: '按本机账号权限运行，Codex 按需请求审批' },
  ]
}

export function initialCodexMode(groupChat: boolean, savedMode?: string, envMode?: string) {
  // Group full access requires an explicit choice for that conversation.
  const mode = savedMode ?? (groupChat && envMode === CODEX_FULL_ACCESS ? undefined : envMode)
  return codexModes(groupChat).find(option => option.value === mode)?.value ?? CODEX_DEFAULT_MODE
}

function sandboxPolicy(mode: string) {
  if (mode === 'read-only') return { type: 'readOnly', networkAccess: false }
  if (mode === CODEX_FULL_ACCESS) return { type: 'dangerFullAccess' }
  return {
    type: 'workspaceWrite',
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  }
}

function inputFor(message: AgentInput) {
  const content = message.message.content
  const blocks = typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content
  return blocks.map(block =>
    block.type === 'text'
      ? { type: 'text', text: block.text, text_elements: [] }
      : { type: 'image', url: `data:${block.source.media_type};base64,${block.source.data}` },
  )
}

export async function checkCodex() {
  const server = new AppServer()
  try {
    await server.initialize()
  } finally {
    server.close()
  }
}

/**
 * App Server owns one conversation for the same lifetime as the Claude query.
 * The emitted envelopes feed the bridge's existing text, tool and turn renderer.
 */
export class CodexSession implements AsyncIterable<Frame> {
  private readonly rpc = new AppServer()
  private readonly frames = new Readable({ objectMode: true, read() {} })
  private readonly tools: Map<string, Tool>
  private readonly streamed = new Set<string>()
  private readonly toolsInProgress = new Map<string, { name: string; input: Frame }>()
  private active: ActiveTurn | null = null
  private threadId: string | null = null
  private threadPath: string | null = null
  private threadPersisted = false
  private model: string | undefined
  private defaultModel: string | undefined
  private context: ContextUsage | null = null
  private closed = false
  private error: Error | undefined
  private mode: string

  constructor(private readonly options: CodexOptions, private readonly messages: InputQueue) {
    this.tools = new Map(options.tools.map(tool => [tool.name, tool]))
    this.mode = options.mode
    this.rpc.onRequest = (method, params) => this.serverRequest(method, params)
    this.rpc.onNotification = (method, params) => this.notification(method, params)
    this.rpc.onClose = error => {
      this.closed = true
      this.error = error
      this.options.cancelInteraction()
      this.active?.markStarted()
      this.active?.finish()
      this.active = null
      this.frames.push(null)
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Frame> {
    void this.run().catch(error => this.rpc.close(error instanceof Error ? error : new Error(String(error))))
    try {
      for await (const frame of this.frames) yield frame
      if (this.error) throw this.error
    } finally {
      this.close()
    }
  }

  close() {
    this.rpc.close()
  }

  async interrupt() {
    const active = this.active
    if (!active || !this.threadId) return
    await active.started
    if (this.active === active && active.id) {
      await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: active.id })
    }
  }

  inputAvailable() {
    const active = this.active
    if (!active?.id || !this.threadId || active.compact || active.steering || active.steerRejected) return
    void this.steerQueued(active, this.threadId, active.id)
  }

  private async steerQueued(active: ActiveTurn, threadId: string, turnId: string) {
    active.steering = true
    try {
      while (this.active === active) {
        // Unconfirmed inputs stay at the head of the queue, ready for the next turn if needed.
        const message = this.messages.peekBuffered(active.pendingSteers.size)
        if (!message || message.message.content === '/compact') return
        active.pendingSteers.add(message.uuid)
        await this.rpc.request('turn/steer', {
          threadId,
          expectedTurnId: turnId,
          clientUserMessageId: message.uuid,
          input: inputFor(message),
        })
      }
    } catch {
      // The turn may already be ending on the server. Keep FIFO order for the next turn.
      active.steerRejected = true
    } finally {
      active.steering = false
    }
  }

  async setModel(model: string | undefined) {
    const models = await this.supportedModels()
    const hit = models.find(row => row.value === (model ?? this.defaultModel))
    if (!hit) throw new Error(model ? `未知 Codex 模型 ${model}` : 'Codex 未提供默认模型')
    this.model = hit.value
  }

  async supportedModels() {
    const result = await this.rpc.request('model/list')
    const models = result.data as Array<{ model: string; displayName: string; description: string; isDefault: boolean }>
    this.defaultModel = models.find(model => model.isDefault)?.model
    return models.map(model => ({ value: model.model, displayName: model.displayName, description: model.description }))
  }

  async setPermissionMode(mode: string) {
    this.mode = mode
  }

  async getContextUsage() {
    return {
      ...this.context,
      model: this.model ?? this.context?.model,
    }
  }

  async usage() {
    const result = await this.rpc.request('account/rateLimits/read')
    const limits = result.rateLimits
    const convert = (window: Frame | null) => window && ({
      utilization: window.usedPercent,
      resets_at: window.resetsAt === null ? null : new Date(window.resetsAt * 1000).toISOString(),
    })
    const windows = [limits.primary, limits.secondary]
    return {
      rate_limits: {
        five_hour: convert(windows.find(window => window?.windowDurationMins === 300) ?? null),
        seven_day: convert(windows.find(window => window?.windowDurationMins === 10_080) ?? null),
      },
    }
  }

  private emit(frame: Frame) {
    if (!this.closed) this.frames.push(frame)
  }

  private streamEvent(event: Frame) {
    this.emit({ type: 'stream_event', event })
  }

  private get approvalsReviewer() {
    return this.options.groupChat && this.mode === CODEX_DEFAULT_MODE ? 'auto_review' : 'user'
  }

  private async run() {
    await this.rpc.initialize()
    const params = {
      cwd: this.options.cwd,
      sandbox: this.mode,
      approvalPolicy: 'on-request',
      approvalsReviewer: this.approvalsReviewer,
      developerInstructions: this.options.instructions,
    }
    const resume = this.options.resume
    const started = resume
      ? await this.rpc.request('thread/resume', { ...params, threadId: resume, excludeTurns: true })
      : await this.rpc.request('thread/start', {
          ...params,
          dynamicTools: [...this.tools.values()].map(tool => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            inputSchema: zodToJsonSchema(z.object(tool.inputSchema), { $refStrategy: 'none' }),
          })),
        })
    this.threadId = started.thread.id
    this.threadPath = started.thread.path
    this.threadPersisted = Boolean(resume)
    this.model ??= started.model
    this.emit({ type: 'system', subtype: 'init' })
    this.persistThread()

    for await (const message of this.messages) {
      if (this.closed) break
      await this.runTurn(message)
      if (this.closed) break
    }
  }

  private persistThread() {
    // App Server allocates a path at thread/start, but it only writes the
    // rollout once a turn begins. A reserved id cannot be resumed.
    if (this.threadPersisted || !this.threadPath || !existsSync(this.threadPath)) return
    this.threadPersisted = true
    this.emit({ type: 'system', subtype: 'init', session_id: this.threadId })
  }

  private async runTurn(message: AgentInput) {
    let finish!: () => void
    const done = new Promise<void>(resolve => { finish = resolve })
    const compact = message.message.content === '/compact'
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const active: ActiveTurn = {
      inputs: [message.uuid], compact, pendingSteers: new Set(), steering: false, steerRejected: false,
      started, markStarted, finish,
    }
    this.active = active
    this.emit({ type: 'command_lifecycle', state: 'started', command_uuid: message.uuid })
    try {
      if (compact) {
        await this.rpc.request('thread/compact/start', { threadId: this.threadId })
      } else {
        const result = await this.rpc.request('turn/start', {
          threadId: this.threadId,
          input: inputFor(message),
          model: this.model,
          approvalPolicy: 'on-request',
          approvalsReviewer: this.approvalsReviewer,
          sandboxPolicy: sandboxPolicy(this.mode),
        })
        if (this.active === active) {
          active.id ??= result.turn.id
          this.inputAvailable()
        }
        this.persistThread()
      }
      await done
    } catch (error) {
      this.finishTurn(active, 'failed', error instanceof Error ? error.message : String(error))
    }
  }

  private finishTurn(turn: ActiveTurn, status: string, message?: string) {
    if (this.active !== turn) return
    this.active = null
    this.options.cancelInteraction()
    if (turn.compact) {
      this.emit(status === 'completed'
        ? { type: 'system', subtype: 'compact_boundary', compact_metadata: { post_tokens: this.context?.totalTokens } }
        : { type: 'system', subtype: 'status', compact_result: 'failed', compact_error: message })
    } else if (status === 'failed') {
      this.emit({ type: 'agent_error', message: message ?? 'Codex 轮次失败' })
    }
    this.streamed.clear()
    this.toolsInProgress.clear()
    this.emit({ type: 'result', subtype: status, user_message_uuids: turn.inputs })
    turn.markStarted()
    turn.finish()
  }

  private notification(method: string, params: Frame) {
    const active = this.active
    if (params.threadId !== this.threadId || !active) return
    const id = params.turnId ?? params.turn?.id
    if (id && active.id && id !== active.id) return
    switch (method) {
      case 'turn/started':
        active.id = params.turn.id
        active.markStarted()
        this.inputAvailable()
        break
      case 'item/agentMessage/delta':
        if (!this.streamed.has(params.itemId)) {
          this.streamed.add(params.itemId)
          this.streamEvent({ type: 'content_block_start', content_block: { type: 'text' } })
        }
        this.streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: params.delta } })
        break
      case 'item/started':
        if (params.item.type === 'userMessage') this.takeUserMessage(active, params.item)
        else this.startTool(params.item)
        break
      case 'item/completed':
        if (params.item.type === 'userMessage') this.takeUserMessage(active, params.item)
        else this.completeItem(params.item)
        break
      case 'thread/tokenUsage/updated': {
        const maxTokens = params.tokenUsage.modelContextWindow ?? 0
        const totalTokens = params.tokenUsage.last.totalTokens
        this.context = {
          model: this.model ?? '',
          totalTokens,
          maxTokens,
          percentage: maxTokens ? (totalTokens / maxTokens) * 100 : undefined,
        }
        this.emit({ type: 'agent_context', totalTokens })
        break
      }
      case 'turn/completed':
        this.persistThread()
        if (params.turn.status !== 'inProgress') this.finishTurn(active, params.turn.status, params.turn.error?.message)
        break
    }
  }

  private takeUserMessage(active: ActiveTurn, item: Frame) {
    this.persistThread()
    const uuid = item.clientId
    if (typeof uuid !== 'string' || !active.pendingSteers.delete(uuid)) return
    this.messages.removeBuffered(uuid)
    active.inputs.push(uuid)
    this.emit({ type: 'command_lifecycle', state: 'started', command_uuid: uuid, steered: true })
  }

  private startTool(item: Frame) {
    let tool: { name: string; input: Frame }
    switch (item.type) {
      case 'commandExecution':
        tool = { name: 'Bash', input: { command: item.command } }
        break
      case 'fileChange':
        tool = { name: 'Edit', input: { file_path: item.changes?.map((change: Frame) => change.path).join(', '), changes: item.changes } }
        break
      case 'dynamicToolCall':
        tool = { name: `mcp__qq__${item.tool}`, input: item.arguments }
        break
      case 'mcpToolCall':
        tool = { name: `mcp__${item.server}__${item.tool}`, input: item.arguments }
        break
      default:
        return
    }
    this.toolsInProgress.set(item.id, tool)
    this.emit({ type: 'agent_tool', id: item.id, ...tool })
  }

  private completeItem(item: Frame) {
    if (item.type === 'agentMessage') {
      const streamed = this.streamed.delete(item.id)
      this.emit({ type: 'agent_text', text: item.text, streamed })
      return
    }
    if (!this.toolsInProgress.delete(item.id)) return
    const output = item.type === 'commandExecution' ? item.aggregatedOutput : undefined
    this.emit({ type: 'agent_tool_result', id: item.id, output })
  }

  private async serverRequest(method: string, params: Frame): Promise<unknown> {
    const active = this.active
    if (!active || params.threadId !== this.threadId || (active.id && active.id !== params.turnId)) {
      throw new Error('Request does not belong to the active QQ turn')
    }
    switch (method) {
      case 'item/commandExecution/requestApproval':
        return { decision: await this.options.approve('Bash', {
          command: params.command, cwd: params.cwd, reason: params.reason, network: params.networkApprovalContext,
        }) ? 'accept' : 'decline' }
      case 'item/fileChange/requestApproval':
        return { decision: await this.options.approve('Edit', {
          changes: this.toolsInProgress.get(params.itemId)?.input.changes, reason: params.reason, grantRoot: params.grantRoot,
        }) ? 'accept' : 'decline' }
      case 'item/permissions/requestApproval': {
        const allowed = await this.options.approve('Permissions', {
          cwd: params.cwd, reason: params.reason, permissions: params.permissions,
        })
        return { permissions: allowed ? params.permissions : {}, scope: 'turn' }
      }
      case 'item/tool/call':
        return this.callTool(params.tool, params.arguments)
      case 'item/tool/requestUserInput': {
        const answers: Record<string, { answers: string[] }> = Object.create(null)
        for (const question of params.questions) {
          if (this.active !== active) break
          if (question.isSecret || !question.options || question.options.length < 2) continue
          const { contentItems } = await this.callTool('qq_ask', {
            question: question.question,
            details: question.options.map((option: Frame) => `- ${option.label}：${option.description}`).join('\n'),
            options: question.options.map((option: Frame) => option.label),
          })
          const text = contentItems.find(item => item.type === 'inputText')?.text
          if (!text) continue
          let answer = text
          try {
            const parsed = JSON.parse(text)
            if (parsed && typeof parsed === 'object' && 'choice' in parsed) answer = parsed.choice
          } catch {
            // Private-chat answers are plain text.
          }
          if (answer && this.active === active) answers[question.id] = { answers: [answer] }
        }
        return { answers }
      }
      case 'mcpServer/elicitation/request':
        return { action: 'decline', content: null }
      default:
        throw new Error(`Unsupported Codex server request: ${method}`)
    }
  }

  private async callTool(name: string, args: unknown) {
    const tool = this.tools.get(name)
    try {
      if (!tool) throw new Error(`Unknown QQ tool: ${name}`)
      const input = z.object(tool.inputSchema).parse(args)
      const result = await tool.handler(input, {})
      return {
        success: !result.isError,
        contentItems: result.content.flatMap((item): Array<{ type: string; text?: string; imageUrl?: string }> => {
          if (item.type === 'text') return [{ type: 'inputText', text: item.text }]
          if (item.type === 'image') return [{ type: 'inputImage', imageUrl: `data:${item.mimeType};base64,${item.data}` }]
          return []
        }),
      }
    } catch (error) {
      return { success: false, contentItems: [{ type: 'inputText', text: String(error) }] }
    }
  }
}

export async function listCodexSessions(cwd: string) {
  const rpc = new AppServer()
  try {
    await rpc.initialize()
    type Thread = { id: string; updatedAt: number; name: string | null; preview: string; originator: string }
    type ThreadPage = { data: Thread[]; nextCursor: string | null }
    const threads: Thread[] = []
    let cursor: string | null = null
    do {
      const result: ThreadPage = await rpc.request<ThreadPage>('thread/list', {
        cwd: realpathSync(cwd), cursor, limit: 50, sortKey: 'updated_at',
      })
      threads.push(...result.data.filter(thread => thread.originator === 'agent-in-qq'))
      cursor = result.nextCursor
    } while (cursor && threads.length < 6)
    return threads.slice(0, 6).map(thread => ({
      sessionId: thread.id,
      lastModified: thread.updatedAt * 1000,
      customTitle: thread.name,
      summary: thread.preview,
    }))
  } finally {
    rpc.close()
  }
}
