# AI Agent 调用说明

对外提供 AI Agent 对话接口，Agent 可代为执行**工具管理**操作：展示工具、启动工具、停止工具、重启工具、编辑工具配置。

基础 URL：`http://localhost:3070`（按实际部署地址替换）

---

## 1. 对话接口

### POST /api/agent/chat

Agent 完成工作后**一次性同步返回**结果（内部可能经历多轮工具调用，耗时从数秒到数十秒不等，请把客户端超时设置在 180 秒以上）。

**请求头**

```
Content-Type: application/json
```

**请求参数**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| sessionId | string | 是 | 会话 ID，**由调用方自己生成和维护**，长度 ≤ 128 字符。相同 sessionId 的多次调用会被视为同一会话 |
| message | string | 是 | 用户消息内容 |

**会话语义（重要）**

- 对话历史按**天**存储（每天一个 JSON 文件）。
- 同一 sessionId 再次调用时，Agent 自动带上**当天**该会话的历史消息作为上下文，因此支持多轮对话（如先问"有哪些工具"，再说"启动第一个"）。
- 跨天后，同一 sessionId 的上下文仅包含新一天的消息。
- 同一会话的并发调用不做排队，请调用方自行保证串行调用。

**响应示例**

```json
{
  "success": true,
  "sessionId": "demo-001",
  "date": "2026-09-25",
  "reply": "已启动项目管理工具。",
  "toolCalls": [
    {
      "name": "start_tool",
      "args": { "tool_name": "项目管理工具" },
      "result": { "success": true, "tool": "项目管理工具", "message": "工具已启动" }
    }
  ]
}
```

**响应字段**

| 字段 | 说明 |
|---|---|
| success | 是否成功 |
| sessionId | 回显会话 ID |
| date | 本次对话归属的日期（历史文件 `history/agent-<date>.json`） |
| reply | Agent 的最终文字回复 |
| toolCalls | 本轮实际执行的工具操作列表（可能为空数组），`name` 为操作名（`list_tools` / `start_tool` / `stop_tool` / `restart_tool` / `edit_tool`），`result.error` 存在表示该操作失败 |

**错误响应**

| 状态码 | 场景 | 示例 |
|---|---|---|
| 400 | 缺少 sessionId / message | `{"success": false, "error": "sessionId 必填"}` |
| 500 | LLM 调用失败或超时 | `{"success": false, "error": "LLM 调用超时（180秒），请稍后重试"}` |

---

## 2. 辅助接口（查询历史）

### GET /api/agent/history

查询某天的会话列表或某个会话的完整消息。

| 参数 | 说明 |
|---|---|
| date | 可选，格式 `YYYY-MM-DD`，默认今天 |
| sessionId | 可选，传入则返回该会话完整消息，否则返回会话摘要列表 |

**会话列表响应：**

```json
{
  "date": "2026-09-25",
  "sessions": [
    { "sessionId": "demo-001", "createdAt": "...", "updatedAt": "...", "messageCount": 4, "preview": "启动项目管理工具" }
  ]
}
```

**单会话响应**（带 sessionId）：返回 `{ date, sessionId, createdAt, updatedAt, messages[] }`，messages 中 assistant 消息可能含 `toolCalls` 元数据。会话不存在返回 404。

### GET /api/agent/dates

返回有历史记录的日期列表（倒序），如 `["2026-09-25", "2026-09-24"]`。

---

## 3. 调用示例

### Windows（PowerShell / CMD，注意用 curl.exe）

```powershell
curl.exe -X POST http://localhost:3070/api/agent/chat -H "Content-Type: application/json" -d "{\"sessionId\":\"demo-001\",\"message\":\"列出所有工具\"}"
```

### Python

```python
import requests

r = requests.post(
    "http://localhost:3070/api/agent/chat",
    json={"sessionId": "demo-001", "message": "启动项目管理工具"},
    timeout=300,   # Agent 需执行工具后再返回，超时要给足
)
data = r.json()
print(data["reply"])
```

### Node.js

```js
const res = await fetch('http://localhost:3070/api/agent/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'demo-001', message: '重启 Mock API工具' })
});
const data = await res.json();
console.log(data.reply);
```

### 多轮对话示例

```text
第1次调用: sessionId=demo-001, message="有哪些工具在运行？"
   → reply: "当前运行中的工具有：……"
第2次调用: sessionId=demo-001, message="把第一个停掉"
   → reply: "已停止花间辞AI助手。"   ← Agent 依托同会话历史理解"第一个"
```

---

## 4. 注意事项

1. **sessionId 由调用方维护**：建议用 UUID；重置会话只需换一个新的 sessionId。
2. **同步等待**：接口在 Agent 完成所有工具操作后才返回，请勿设置过短的超时。
3. **幂等性**：重复发送同一 message 会重复执行操作（如重复启动会返回"工具已在运行"的错误信息）。
4. **历史文件**：每份对话保存在服务端 `history/agent-YYYY-MM-DD.json`，删除文件即删除该天历史。
5. **界面**：浏览器打开 `http://localhost:3070/agent.html` 可使用同款对话界面，左侧可按天浏览历史会话。
