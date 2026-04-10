# 工具管理服务 API 文档

基础URL: `http://localhost:3070`

---

## 1. 获取所有工具列表

### GET /api/tools

获取所有工具列表，包含每个工具的运行状态和健康检查信息。

**响应示例:**
```json
[
  {
    "id": "1234567890",
    "name": "MySQL",
    "type": "database",
    "workDir": "C:/mysql",
    "command": "mysqld",
    "healthCheckUrl": "http://localhost:3306",
    "homeUrl": "http://localhost:3306",
    "services": [
      { "name": "数据库服务", "description": "主数据库实例" }
    ],
    "hidden": false,
    "status": "running",
    "health": {
      "status": "healthy",
      "message": "服务正常"
    }
  }
]
```

---

## 2. 获取运行中的服务信息

### GET /api/tools/info

获取当前正在运行的服务信息，过滤掉未运行和隐藏的工具。

**响应示例:**
```json
[
  {
    "toolName": "MySQL",
    "toolStatus": "running",
    "services": [
      { "name": "数据库服务", "description": "主数据库实例" }
    ]
  }
]
```

---

## 3. 获取运行中的工具

### GET /api/running-tools

获取所有正在运行的工具列表。

**响应示例:**
```json
[
  {
    "toolName": "MySQL",
    "toolStatus": "running",
    "services": [
      { "name": "数据库服务", "description": "主数据库实例" }
    ]
  }
]
```

---

## 4. 创建新工具

### POST /api/tools

创建一个新的工具配置。

**请求体:**
```json
{
  "name": "工具名称",
  "type": "工具类型",
  "workDir": "工作目录路径",
  "command": "启动命令",
  "healthCheckUrl": "健康检查URL（可选）",
  "homeUrl": "主页URL（可选）",
  "services": [
    { "name": "服务名称", "description": "服务描述" }
  ],
  "hidden": false
}
```

**响应示例:**
```json
{
  "id": "1234567890",
  "name": "工具名称",
  "type": "工具类型",
  "workDir": "工作目录路径",
  "command": "启动命令",
  "healthCheckUrl": "",
  "homeUrl": "",
  "services": [],
  "hidden": false,
  "status": "stopped"
}
```

---

## 5. 更新工具

### PUT /api/tools/:id

更新指定工具的配置信息。

**参数:**
- `id` - 工具ID

**请求体:**
```json
{
  "name": "新名称",
  "command": "新命令"
}
```

**响应示例:**
```json
{
  "id": "1234567890",
  "name": "新名称",
  ...
}
```

**错误响应:**
```json
{
  "error": "工具未找到"
}
```

---

## 6. 删除工具

### DELETE /api/tools/:id

删除指定工具。如果工具正在运行，会先停止再删除。

**参数:**
- `id` - 工具ID

**响应示例:**
```json
{
  "success": true
}
```

---

## 7. 启动工具

### POST /api/tools/:id/start

启动指定的工具。

**参数:**
- `id` - 工具ID

**响应示例:**
```json
{
  "success": true,
  "message": "工具已启动"
}
```

**错误响应:**
```json
{
  "error": "工具未找到"
}
```
或
```json
{
  "error": "工具已在运行"
}
```

---

## 8. 停止工具

### POST /api/tools/:id/stop

停止正在运行的工具。

**参数:**
- `id` - 工具ID

**响应示例:**
```json
{
  "success": true,
  "message": "工具已停止"
}
```

**错误响应:**
```json
{
  "error": "工具未在运行"
}
```
或
```json
{
  "error": "停止进程失败"
}
```

---

## 9. 重启工具

### POST /api/tools/:id/restart

重启指定的工具（先停止再启动）。

**参数:**
- `id` - 工具ID

**响应示例:**
```json
{
  "success": true,
  "message": "工具已重启"
}
```

**错误响应:**
```json
{
  "error": "工具未找到"
}
```

---

## 数据模型

### Tool 对象

| 字段 | 类型 | 描述 |
|------|------|------|
| id | string | 工具唯一标识 |
| name | string | 工具名称 |
| type | string | 工具类型 |
| workDir | string | 工作目录 |
| command | string | 启动命令 |
| healthCheckUrl | string | 健康检查URL |
| homeUrl | string | 主页URL |
| services | array | 服务列表 |
| hidden | boolean | 是否隐藏 |
| status | string | 运行状态 (running/stopped) |
| health | object | 健康检查结果 |

### Service 对象

| 字段 | 类型 | 描述 |
|------|------|------|
| name | string | 服务名称 |
| description | string | 服务描述 |

### Health 对象

| 字段 | 类型 | 描述 |
|------|------|------|
| status | string | 健康状态 (healthy/unhealthy/unknown) |
| message | string | 状态消息 |
