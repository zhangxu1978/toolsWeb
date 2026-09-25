/**
 * AI Agent 模块
 * - 对接 config.json 中 agent 节点的 OpenAI 兼容 LLM 接口（function calling）
 * - 通过内部 HTTP 自调用，复用 server.js 已有的工具管理接口（列表/启动/停止/重启/编辑）
 * - 对话历史按天存 history/agent-YYYY-MM-DD.json，sessions 以 sessionId 为 key
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const CONFIG_FILE = path.join(__dirname, 'config.json');
const HISTORY_DIR = path.join(__dirname, 'history');
const MAX_TOOL_ROUNDS = 8;
const LLM_TIMEOUT_MS = 180000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

let selfPort = 3070;

function init(options) {
    if (options && options.port) {
        selfPort = options.port;
    }
}

function loadConfig() {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    const cfg = raw.agent;
    if (!cfg || !cfg.apiKey || !cfg.baseUrl || !cfg.model) {
        throw new Error('config.json 缺少 agent 配置（需要 apiKey / model / baseUrl）');
    }
    return cfg;
}

// ============ 日期与历史存储 ============

function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function historyFile(date) {
    return path.join(HISTORY_DIR, `agent-${date}.json`);
}

// 同一历史文件的串行写队列，避免并发写坏 JSON
const writeQueues = new Map();
function enqueueWrite(file, fn) {
    const prev = writeQueues.get(file) || Promise.resolve();
    const next = prev.then(fn, fn);
    writeQueues.set(file, next.catch(() => {}));
    return next;
}

function loadHistory(date) {
    const file = historyFile(date);
    if (!fs.existsSync(file)) {
        return { date, sessions: {} };
    }
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (!data || typeof data !== 'object' || !data.sessions) {
            throw new Error('bad format');
        }
        return { date: data.date || date, sessions: data.sessions };
    } catch (e) {
        return { date, sessions: {} };
    }
}

// 读-改-写整体入队
function updateHistory(date, mutator) {
    if (!fs.existsSync(HISTORY_DIR)) {
        fs.mkdirSync(HISTORY_DIR, { recursive: true });
    }
    const file = historyFile(date);
    return enqueueWrite(file, () => {
        let data;
        try {
            data = JSON.parse(fs.readFileSync(file, 'utf-8'));
            if (!data || typeof data !== 'object' || !data.sessions) {
                throw new Error('bad format');
            }
        } catch (e) {
            data = { date, sessions: {} };
        }
        mutator(data);
        fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
        return data;
    });
}

// ============ 内部 HTTP 自调用（复用 server.js 的接口） ============

function internalRequest(method, apiPath, body) {
    return new Promise((resolve, reject) => {
        const url = new URL(apiPath, `http://127.0.0.1:${selfPort}`);
        const payload = body === undefined ? null : JSON.stringify(body);
        const headers = { 'Content-Type': 'application/json' };
        if (payload) {
            headers['Content-Length'] = Buffer.byteLength(payload);
        }
        const req = http.request({
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method,
            headers
        }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                let parsed = data;
                try { parsed = JSON.parse(data); } catch (e) { /* 保持原文 */ }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        req.setTimeout(60000, () => req.destroy(new Error('内部请求超时')));
        if (payload) req.write(payload);
        req.end();
    });
}

// 按名称（精确 → 包含）或 id 解析工具
async function resolveTool(args) {
    const { status, body } = await internalRequest('GET', '/api/tools');
    if (status !== 200 || !Array.isArray(body)) {
        throw new Error('获取工具列表失败');
    }
    if (args.tool_id) {
        const tool = body.find(t => t.id === String(args.tool_id));
        return tool ? { tool } : { notFound: true };
    }
    const name = String(args.tool_name || '').trim();
    if (!name) {
        return { needName: true };
    }
    let matches = body.filter(t => t.name === name);
    if (matches.length === 0) {
        matches = body.filter(t => t.name.includes(name) || name.includes(t.name));
    }
    if (matches.length === 1) {
        return { tool: matches[0] };
    }
    if (matches.length > 1) {
        return { candidates: matches.map(t => ({ id: t.id, name: t.name, status: t.status })) };
    }
    return { notFound: true };
}

// ============ Agent 工具定义与执行 ============

const TOOL_DEFINITIONS = [
    {
        type: 'function',
        function: {
            name: 'list_tools',
            description: '展示所有已登记的工具及运行状态（status: running 运行中 / stopped 已停止）。用户询问有哪些工具、某个工具是否在运行时调用。',
            parameters: {
                type: 'object',
                properties: {
                    keyword: { type: 'string', description: '可选，按工具名称或分类过滤的关键字' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'start_tool',
            description: '启动一个工具。',
            parameters: {
                type: 'object',
                properties: {
                    tool_name: { type: 'string', description: '工具名称，支持模糊匹配' },
                    tool_id: { type: 'string', description: '工具ID，与 tool_name 二选一' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'stop_tool',
            description: '停止一个正在运行的工具。',
            parameters: {
                type: 'object',
                properties: {
                    tool_name: { type: 'string', description: '工具名称，支持模糊匹配' },
                    tool_id: { type: 'string', description: '工具ID，与 tool_name 二选一' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'restart_tool',
            description: '重启一个工具（先停止再启动）。',
            parameters: {
                type: 'object',
                properties: {
                    tool_name: { type: 'string', description: '工具名称，支持模糊匹配' },
                    tool_id: { type: 'string', description: '工具ID，与 tool_name 二选一' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'edit_tool',
            description: '编辑工具配置，只传入需要修改的字段。修改后不自动重启工具。',
            parameters: {
                type: 'object',
                properties: {
                    tool_name: { type: 'string', description: '要修改的工具名称，支持模糊匹配' },
                    tool_id: { type: 'string', description: '工具ID，与 tool_name 二选一' },
                    name: { type: 'string', description: '新的工具名称' },
                    command: { type: 'string', description: '启动命令；"其他"类型可用 ; 分隔，前面是启动命令，后面是停止命令' },
                    workDir: { type: 'string', description: '运行目录' },
                    healthCheckUrl: { type: 'string', description: '健康检查 URL' },
                    homeUrl: { type: 'string', description: '首页地址' },
                    category: { type: 'string', enum: ['work', 'life', 'general'], description: '分类' },
                    autoStart: { type: 'boolean', description: '服务启动时是否自动启动该工具' },
                    hidden: { type: 'boolean', description: '是否隐藏' }
                }
            }
        }
    }
];

async function executeTool(name, args) {
    args = args || {};
    try {
        if (name === 'list_tools') {
            const { status, body } = await internalRequest('GET', '/api/tools');
            if (status !== 200 || !Array.isArray(body)) {
                return { error: '获取工具列表失败' };
            }
            let list = body.map(t => ({
                id: t.id,
                name: t.name,
                type: t.type,
                category: t.category,
                status: t.status,
                health: t.health ? t.health.status : undefined,
                autoStart: !!t.autoStart,
                command: t.command,
                workDir: t.workDir
            }));
            if (args.keyword) {
                const kw = String(args.keyword).toLowerCase();
                list = list.filter(t =>
                    (t.name || '').toLowerCase().includes(kw) ||
                    (t.category || '').toLowerCase().includes(kw));
            }
            return { count: list.length, tools: list };
        }

        if (name === 'start_tool' || name === 'stop_tool' || name === 'restart_tool') {
            const r = await resolveTool(args);
            if (r.needName) return { error: '缺少 tool_name 或 tool_id 参数' };
            if (r.notFound) return { error: `未找到工具 "${args.tool_name || args.tool_id}"，可先调用 list_tools 查看现有工具` };
            if (r.candidates) return { error: '该名称匹配到多个工具，请指定更准确的名称', candidates: r.candidates };
            const action = name === 'start_tool' ? 'start' : name === 'stop_tool' ? 'stop' : 'restart';
            const { status, body } = await internalRequest('POST', `/api/tools/${r.tool.id}/${action}`);
            if (status === 200) {
                return { success: true, tool: r.tool.name, message: body.message || '操作成功' };
            }
            return { success: false, tool: r.tool.name, error: (body && body.error) || `操作失败（HTTP ${status}）` };
        }

        if (name === 'edit_tool') {
            const r = await resolveTool(args);
            if (r.needName) return { error: '缺少 tool_name 或 tool_id 参数' };
            if (r.notFound) return { error: `未找到工具 "${args.tool_name || args.tool_id}"，可先调用 list_tools 查看现有工具` };
            if (r.candidates) return { error: '该名称匹配到多个工具，请指定更准确的名称', candidates: r.candidates };
            const allowed = ['name', 'command', 'workDir', 'healthCheckUrl', 'homeUrl', 'category', 'autoStart', 'hidden'];
            const fields = {};
            for (const k of allowed) {
                if (args[k] !== undefined) fields[k] = args[k];
            }
            if (Object.keys(fields).length === 0) {
                return { error: '未提供要修改的字段，可修改：name, command, workDir, healthCheckUrl, homeUrl, category, autoStart, hidden' };
            }
            const { status, body } = await internalRequest('PUT', `/api/tools/${r.tool.id}`, fields);
            if (status === 200) {
                return {
                    success: true,
                    message: '修改成功（如需生效可重启该工具）',
                    tool: { id: body.id, name: body.name, command: body.command, workDir: body.workDir, healthCheckUrl: body.healthCheckUrl }
                };
            }
            return { success: false, error: (body && body.error) || `修改失败（HTTP ${status}）` };
        }

        return { error: `未知的工具函数: ${name}` };
    } catch (err) {
        return { error: err.message };
    }
}

// ============ LLM 调用 ============

// MiniMax 等模型会把思考过程以 <think>...</think> 混在 content 里，对外一律剥离
function stripThink(s) {
    return String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function buildSystemPrompt() {
    const now = new Date();
    const time = `${todayStr()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    return [
        '你是"百宝箱"工具管家的 AI 助手，帮助用户管理本机登记的工具。',
        '你可以：展示工具列表及运行状态、启动工具、停止工具、重启工具、编辑工具配置。',
        `当前时间：${time}`,
        '规则：',
        '1. 用户提到的工具名称模糊或可能重名时，先调用 list_tools 确认，再执行操作。',
        '2. 启动/停止/重启/编辑必须通过调用对应函数完成，绝不允许在未调用函数的情况下声称操作成功。',
        '3. 调用函数时 tool_name 必须传具体的工具名称或 tool_id，即使用户用了"它/第一个"等代词，也要根据上下文换算成具体名称，禁止把代词直接传参。',
        '4. 操作完成后，用简洁的中文一句话汇报结果；失败时说明原因。',
        '5. 与工具管理无关的问题，直接用中文简短回答。',
        '6. 工具的启动命令若含 ";"，前半是启动命令，后半是停止命令。'
    ].join('\n');
}

async function callLLM(messages) {
    const cfg = loadConfig();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    try {
        const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${cfg.apiKey}`
            },
            body: JSON.stringify({
                model: cfg.model,
                messages,
                tools: TOOL_DEFINITIONS,
                temperature: typeof cfg.temperature === 'number' ? cfg.temperature : 0.1
            }),
            signal: controller.signal
        });
        const text = await res.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            throw new Error(`LLM 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
        }
        if (!res.ok) {
            const msg = (data && data.error && (data.error.message || data.error)) || `HTTP ${res.status}`;
            throw new Error(`LLM 调用失败：${msg}`);
        }
        const choice = data.choices && data.choices[0];
        if (!choice || !choice.message) {
            throw new Error('LLM 返回格式异常');
        }
        return choice.message;
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error(`LLM 调用超时（${LLM_TIMEOUT_MS / 1000}秒），请稍后重试`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

// ============ 主流程 ============

async function chat(sessionId, message) {
    if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
        throw Object.assign(new Error('sessionId 必填'), { statusCode: 400 });
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
        throw Object.assign(new Error('message 必填'), { statusCode: 400 });
    }
    sessionId = sessionId.trim().slice(0, 128);
    message = message.trim();

    const date = todayStr();
    const history = loadHistory(date);
    const session = history.sessions[sessionId] || {
        sessionId,
        createdAt: new Date().toISOString(),
        updatedAt: '',
        messages: []
    };

    // 上下文 = system + 当天该会话历史（仅 user/assistant 文本）+ 本条新消息
    const llmMessages = [{ role: 'system', content: buildSystemPrompt() }];
    for (const m of session.messages) {
        if (m.role === 'user' || m.role === 'assistant') {
            llmMessages.push({ role: m.role, content: stripThink(m.content) });
        }
    }
    llmMessages.push({ role: 'user', content: message });

    const toolCallsMeta = [];
    let lastMessage = null;
    let corrected = false;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        lastMessage = await callLLM(llmMessages);
        const calls = lastMessage.tool_calls || [];
        if (calls.length === 0) {
            // 防幻觉纠错：用户要求执行操作、模型却未调用任何函数就声称成功时，提醒一次并重试
            const actionIntent = /启动|停止|重启|修改|编辑|改成|改为|更新/.test(message);
            const claimSuccess = /成功|已完成|已启动|已停止|已重启|已修改|已更新/.test(stripThink(lastMessage.content));
            if (!corrected && toolCallsMeta.length === 0 && actionIntent && claimSuccess) {
                corrected = true;
                llmMessages.push({
                    role: 'user',
                    content: '（系统提醒：你上一条回复声称操作成功，但你尚未调用任何函数。工具操作必须通过函数调用完成，请立即调用对应的函数。）'
                });
                continue;
            }
            break;
        }
        llmMessages.push({
            role: 'assistant',
            content: lastMessage.content || '',
            tool_calls: calls
        });
        for (let i = 0; i < calls.length; i++) {
            const call = calls[i];
            const fnName = call.function && call.function.name;
            let args = {};
            try {
                args = call.function && call.function.arguments
                    ? JSON.parse(call.function.arguments)
                    : {};
            } catch (e) {
                args = { _raw: call.function && call.function.arguments };
            }
            const result = await executeTool(fnName, args);
            toolCallsMeta.push({ name: fnName, args, result });
            llmMessages.push({
                role: 'tool',
                tool_call_id: call.id || `call_${round}_${i}`,
                content: JSON.stringify(result)
            });
        }
    }

    let replyText = stripThink(lastMessage && lastMessage.content);
    if (!replyText) {
        replyText = toolCallsMeta.length > 0
            ? `已执行 ${toolCallsMeta.length} 项操作（达到单轮工具调用上限）。`
            : '（无回复内容）';
    }

    const nowIso = new Date().toISOString();
    await updateHistory(date, (data) => {
        const s = data.sessions[sessionId] || session;
        s.sessionId = sessionId;
        s.createdAt = s.createdAt || nowIso;
        s.updatedAt = nowIso;
        s.messages.push({ role: 'user', content: message, ts: Date.now() });
        const assistantMsg = { role: 'assistant', content: replyText, ts: Date.now() };
        if (toolCallsMeta.length > 0) {
            assistantMsg.toolCalls = toolCallsMeta;
        }
        s.messages.push(assistantMsg);
        data.sessions[sessionId] = s;
    });

    return { sessionId, date, reply: replyText, toolCalls: toolCallsMeta };
}

// ============ 历史查询 ============

function getHistory(date, sessionId) {
    const d = date && DATE_RE.test(date) ? date : todayStr();
    const data = loadHistory(d);
    if (sessionId) {
        const s = data.sessions[sessionId];
        if (!s) return null;
        return { date: d, sessionId, createdAt: s.createdAt, updatedAt: s.updatedAt, messages: s.messages };
    }
    const sessions = Object.values(data.sessions)
        .map(s => ({
            sessionId: s.sessionId,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            messageCount: (s.messages || []).length,
            preview: ((s.messages || []).find(m => m.role === 'user') || {}).content || ''
        }))
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return { date: d, sessions };
}

function listDates() {
    if (!fs.existsSync(HISTORY_DIR)) return [];
    return fs.readdirSync(HISTORY_DIR)
        .filter(f => /^agent-\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .map(f => f.slice(6, 16))
        .filter(d => DATE_RE.test(d))
        .sort()
        .reverse();
}

module.exports = { init, chat, getHistory, listDates };
