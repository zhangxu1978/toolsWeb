const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3070;
const DATA_FILE = path.join(__dirname, 'tools.json');

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

function loadTools() {
    if (!fs.existsSync(DATA_FILE)) {
        return [];
    }
    const data = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(data || '[]');
}

function saveTools(tools) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(tools, null, 2));
}

const runningProcesses = {};

function startToolProcess(tool) {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';

    // 按 ";" 拆分：前半是启动命令，后半是停止命令（可选）
    const parts = String(tool.command || '').split(';');
    const startCmd = (parts[0] || '').trim();
    const stopCmd = parts.slice(1).join(';').trim();

    console.log(`[start] id=${tool.id} type=${tool.type} startCmd="${startCmd}" stopCmd="${stopCmd}"`);

    const shellArgs = isWindows ? ['/c', startCmd] : ['-c', startCmd];

    const proc = spawn(shell, shellArgs, {
        cwd: tool.workDir,
        detached: !isWindows,
        stdio: 'ignore'
    });

    proc.unref();
    runningProcesses[tool.id] = { proc, type: tool.type, stopCmd };

    proc.on('exit', (code) => {
        console.log(`[exit] id=${tool.id} code=${code} type=${tool.type} stopCmd="${stopCmd}"`);
        // 注意：other 类型的工具即使进程退出，仍保留 stopCmd，以便点击停止时执行关闭脚本
        if (runningProcesses[tool.id] && runningProcesses[tool.id].proc === proc) {
            if (tool.type === 'other' && stopCmd) {
                runningProcesses[tool.id].proc = null;
                console.log(`[exit] id=${tool.id} 保留 entry，等待 stopCmd`);
            } else {
                delete runningProcesses[tool.id];
            }
        }
    });

    return proc;
}

function checkHealth(tool) {
    return new Promise((resolve) => {
        if (!tool.healthCheckUrl) {
            resolve({ status: 'unknown', message: '未配置健康检查' });
            return;
        }
        
        const timeout = setTimeout(() => {
            resolve({ status: 'unhealthy', message: '健康检查超时' });
        }, 5000);

        const req = require('http').get(tool.healthCheckUrl, (res) => {
            clearTimeout(timeout);
            if (res.statusCode >= 200 && res.statusCode < 400) {
                resolve({ status: 'healthy', message: '服务正常' });
            } else {
                resolve({ status: 'unhealthy', message: `HTTP ${res.statusCode}` });
            }
        });

        req.on('error', (err) => {
            clearTimeout(timeout);
            resolve({ status: 'unhealthy', message: err.message });
        });
    });
}

app.get('/api/tools', async (req, res) => {
    const tools = loadTools();
    for (const tool of tools) {
        if (runningProcesses[tool.id]) {
            tool.status = 'running';
            tool.hasStopCmd = !!runningProcesses[tool.id].stopCmd;
        } else if (tool.healthCheckUrl) {
            const health = await checkHealth(tool);
            tool.health = health;
            tool.status = health.status === 'healthy' ? 'running' : 'stopped';
        } else {
            tool.status = 'stopped';
        }
    }
    res.json(tools);
});

app.get('/api/tools/info', async (req, res) => {
    const tools = loadTools();
    const result = [];
    
    for (const tool of tools) {
        if (tool.hidden) {
            continue;
        }
        
        let status = 'stopped';
        if (runningProcesses[tool.id]) {
            status = 'running';
        } else if (tool.healthCheckUrl) {
            const health = await checkHealth(tool);
            status = health.status === 'healthy' ? 'running' : 'stopped';
        }
        
        // if (status !== 'running') {
        //     continue;
        // }
        
        const services = (tool.services || []).map(service => ({
            name: service.name || '',
            description: service.description || ''
        }));
        
        result.push({
            toolId: tool.id || '',
            toolName: tool.name || '',
            toolStatus: status,
            services: services
        });
    }
    
    res.json(result);
});

app.get('/api/running-tools', async (req, res) => {
    const tools = loadTools();
    const result = [];
    
    for (const tool of tools) {
        let status = 'stopped';
        if (runningProcesses[tool.id]) {
            status = 'running';
        } else if (tool.healthCheckUrl) {
            const health = await checkHealth(tool);
            status = health.status === 'healthy' ? 'running' : 'stopped';
        }
        
        if (status !== 'running') {
            continue;
        }
        
        const services = (tool.services || []).map(service => ({
            name: service.name || '',
            description: service.description || ''
        }));
        
        result.push({
            toolName: tool.name || '',
            toolStatus: status,
            services: services
        });
    }
    
    res.json(result);
});

app.post('/api/tools', (req, res) => {
    const tools = loadTools();
    const tool = {
        id: Date.now().toString(),
        name: req.body.name,
        type: req.body.type,
        workDir: req.body.workDir,
        command: req.body.command,
        healthCheckUrl: req.body.healthCheckUrl || '',
        homeUrl: req.body.homeUrl || '',
        services: req.body.services || [],
        hidden: req.body.hidden || false,
        autoStart: req.body.autoStart || false,
        status: 'stopped'
    };
    tools.push(tool);
    saveTools(tools);
    res.json(tool);
});

app.put('/api/tools/reorder', (req, res) => {
    const order = req.body.order;
    if (!Array.isArray(order)) {
        return res.status(400).json({ error: 'order 必填为数组' });
    }
    const tools = loadTools();
    const map = new Map(tools.map(t => [t.id, t]));
    const next = [];
    order.forEach(id => {
        if (map.has(id)) {
            next.push(map.get(id));
            map.delete(id);
        }
    });
    // 兜底：把遗漏的（如被删过）追加到末尾
    for (const t of map.values()) next.push(t);
    saveTools(next);
    res.json({ success: true });
});

app.put('/api/tools/:id', (req, res) => {
    const tools = loadTools();
    const index = tools.findIndex(t => t.id === req.params.id);
    if (index === -1) {
        return res.status(404).json({ error: '工具未找到' });
    }
    tools[index] = { ...tools[index], ...req.body };
    saveTools(tools);
    res.json(tools[index]);
});

app.delete('/api/tools/:id', (req, res) => {
    let tools = loadTools();
    const tool = tools.find(t => t.id === req.params.id);
    if (tool && runningProcesses[tool.id] && runningProcesses[tool.id].proc) {
        runningProcesses[tool.id].proc.kill();
        delete runningProcesses[tool.id];
    }
    tools = tools.filter(t => t.id !== req.params.id);
    saveTools(tools);
    res.json({ success: true });
});

app.post('/api/tools/:id/start', (req, res) => {
    const tools = loadTools();
    const tool = tools.find(t => t.id === req.params.id);
    if (!tool) {
        return res.status(404).json({ error: '工具未找到' });
    }
    if (runningProcesses[tool.id] && runningProcesses[tool.id].proc) {
        return res.status(400).json({ error: '工具已在运行' });
    }
    // other 类型：若 entry 还在但 proc 已退出（等待执行 stopCmd），允许重新启动
    if (runningProcesses[tool.id]) {
        delete runningProcesses[tool.id];
    }

    startToolProcess(tool);
    res.json({ success: true, message: '工具已启动' });
});

app.post('/api/tools/:id/stop', (req, res) => {
    const toolId = req.params.id;
    const entry = runningProcesses[toolId];
    const isWindows = process.platform === 'win32';

    // 查一次工具配置，拿到 type（应对进程已退出但 entry 仍在的场景）
    const tools = loadTools();
    const tool = tools.find(t => t.id === toolId);

    console.log(`[stop] id=${toolId} hasEntry=${!!entry} entryType=${entry && entry.type} entryStopCmd="${entry && entry.stopCmd}"`);

    if (!entry) {
        return res.status(400).json({ error: '工具未在运行' });
    }

    const toolType = entry.type || (tool && tool.type);
    const stopCmd = entry.stopCmd;

    // other 类型：依赖用户配置的停止命令
    if (toolType === 'other') {
        if (!stopCmd) {
            delete runningProcesses[toolId];
            return res.status(400).json({ error: '该工具未配置停止命令，请先在启动命令后用 ; 分隔填写停止命令' });
        }
        const shell = isWindows ? 'cmd.exe' : '/bin/sh';
        const shellArgs = isWindows ? ['/c', stopCmd] : ['-c', stopCmd];
        console.log(`[stop] other 类型 执行停止命令: ${stopCmd} cwd=${tool && tool.workDir}`);
        const stopProc = spawn(shell, shellArgs, {
            cwd: tool ? tool.workDir : undefined,
            detached: !isWindows,
            stdio: 'ignore'
        });
        stopProc.unref();
        delete runningProcesses[toolId];
        return res.json({ success: true, message: '工具已停止' });
    }

    // npm 等其他类型：必须进程还在才能 taskkill
    const proc = entry.proc;
    if (!proc) {
        delete runningProcesses[toolId];
        return res.status(400).json({ error: '工具未在运行' });
    }

    if (isWindows) {
        exec(`taskkill /pid ${proc.pid} /T /F`, (err) => {
            if (err) {
                return res.status(500).json({ error: '停止进程失败' });
            }
            delete runningProcesses[toolId];
            res.json({ success: true, message: '工具已停止' });
        });
    } else {
        proc.kill('SIGTERM');
        delete runningProcesses[toolId];
        res.json({ success: true, message: '工具已停止' });
    }
});

app.post('/api/tools/:id/restart', async (req, res) => {
    const toolId = req.params.id;
    const entry = runningProcesses[toolId];
    if (entry && entry.proc) {
        const isWindows = process.platform === 'win32';
        if (isWindows) {
            exec(`taskkill /pid ${entry.proc.pid} /T /F`);
        } else {
            entry.proc.kill('SIGTERM');
        }
        delete runningProcesses[toolId];
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    const tools = loadTools();
    const tool = tools.find(t => t.id === toolId);
    if (!tool) {
        return res.status(404).json({ error: '工具未找到' });
    }

    startToolProcess(tool);
    res.json({ success: true, message: '工具已重启' });
});

app.get('/mcp/tool_list', async (req, res) => {
    const tools = loadTools();
    const result = [];
    
    for (const tool of tools) {
        if (tool.hidden) continue;
        
        let status = 'stopped';
        if (runningProcesses[tool.id]) {
            status = 'running';
        } else if (tool.healthCheckUrl) {
            const health = await checkHealth(tool);
            status = health.status === 'healthy' ? 'running' : 'stopped';
        }
        
        if (status !== 'running') continue;
        
        for (const service of (tool.services || [])) {
            if (!service.apiUrl) continue;
            
            const parameters = (service.parameters || []).map(p => ({
                name: p.name,
                type: p.type || 'string',
                required: p.required || false,
                description: `${p.type || 'string'}${p.required ? ' (必须)' : ''}${p.defaultValue ? ` 默认值: ${p.defaultValue}` : ''}`
            }));
            
            result.push({
                name: service.name,
                description: service.description || `${service.name} - ${service.method} ${service.apiUrl}`,
                api_url: service.apiUrl,
                method: service.method || 'GET',
                parameters: parameters
            });
        }
    }
    
    res.json({ tools: result });
});

app.post('/mcp/call_tool', async (req, res) => {
    const { tool_name, parameters } = req.body;
    
    if (!tool_name) {
        return res.status(400).json({ error: 'tool_name 必填' });
    }
    
    const tools = loadTools();
    let targetService = null;
    
    for (const tool of tools) {
        if (tool.hidden) continue;
        
        for (const service of (tool.services || [])) {
            if (service.name === tool_name && service.apiUrl) {
                targetService = service;
                break;
            }
        }
        if (targetService) break;
    }
    
    if (!targetService) {
        return res.status(404).json({ error: `工具 "${tool_name}" 未找到或未配置 API` });
    }
    
    try {
        const method = (targetService.method || 'GET').toUpperCase();
        const url = new URL(targetService.apiUrl);
        
        if (method === 'GET') {
            const searchParams = new URLSearchParams();
            (targetService.parameters || []).forEach(p => {
                const value = parameters ? parameters[p.name] : undefined;
                if (value !== undefined && value !== null && value !== '') {
                    searchParams.append(p.name, value);
                } else if (p.defaultValue && !p.required) {
                    searchParams.append(p.name, p.defaultValue);
                }
            });
            url.search = searchParams.toString();
        }
        
        const http = url.protocol === 'https:' ? require('https') : require('http');
        
        const options = {
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: method,
            headers: {
                'Content-Type': 'application/json'
            }
        };
        
        const response = await new Promise((resolve, reject) => {
            const reqHttp = http.request(options, (resHttp) => {
                let data = '';
                resHttp.on('data', chunk => { data += chunk; });
                resHttp.on('end', () => {
                    try {
                        resolve({
                            statusCode: resHttp.statusCode,
                            headers: resHttp.headers,
                            body: data ? JSON.parse(data) : {}
                        });
                    } catch (e) {
                        resolve({
                            statusCode: resHttp.statusCode,
                            headers: resHttp.headers,
                            body: data
                        });
                    }
                });
            });
            
            reqHttp.on('error', reject);
            
            if (method === 'POST') {
                const body = {};
                (targetService.parameters || []).forEach(p => {
                    const value = parameters ? parameters[p.name] : undefined;
                    if (value !== undefined && value !== null && value !== '') {
                        body[p.name] = value;
                    } else if (p.defaultValue && !p.required) {
                        body[p.name] = p.defaultValue;
                    }
                });
                reqHttp.write(JSON.stringify(body));
            }
            
            reqHttp.end();
        });
        
        res.json({
            success: true,
            result: response.body
        });
    } catch (error) {
        res.json({
            success: false,
            error: error.message
        });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`服务器运行在 http://0.0.0.0:${PORT}`);

    // 系统启动后，自动启动标记为 autoStart 的工具
    const tools = loadTools();
    const autoStartTools = tools.filter(t => t.autoStart);
    if (autoStartTools.length > 0) {
        console.log(`正在自动启动 ${autoStartTools.length} 个工具...`);
        // 错开启动，避免端口冲突
        autoStartTools.forEach((tool, index) => {
            setTimeout(() => {
                try {
                    if (!runningProcesses[tool.id] || !runningProcesses[tool.id].proc) {
                        startToolProcess(tool);
                        console.log(`已自动启动: ${tool.name}`);
                    }
                } catch (err) {
                    console.error(`自动启动失败 ${tool.name}:`, err.message);
                }
            }, index * 1500);
        });
    }
});
