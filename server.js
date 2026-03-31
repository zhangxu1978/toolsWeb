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
        status: 'stopped'
    };
    tools.push(tool);
    saveTools(tools);
    res.json(tool);
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
    if (tool && runningProcesses[tool.id]) {
        runningProcesses[tool.id].kill();
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
    if (runningProcesses[tool.id]) {
        return res.status(400).json({ error: '工具已在运行' });
    }

    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const shellArgs = isWindows ? ['/c', tool.command] : ['-c', tool.command];

    const proc = spawn(shell, shellArgs, {
        cwd: tool.workDir,
        detached: !isWindows,
        stdio: 'ignore'
    });

    proc.unref();
    runningProcesses[tool.id] = proc;

    proc.on('exit', (code) => {
        delete runningProcesses[tool.id];
    });

    res.json({ success: true, message: '工具已启动' });
});

app.post('/api/tools/:id/stop', (req, res) => {
    const toolId = req.params.id;
    if (!runningProcesses[toolId]) {
        return res.status(400).json({ error: '工具未在运行' });
    }
    
    const isWindows = process.platform === 'win32';
    if (isWindows) {
        exec(`taskkill /pid ${runningProcesses[toolId].pid} /T /F`, (err) => {
            if (err) {
                return res.status(500).json({ error: '停止进程失败' });
            }
            delete runningProcesses[toolId];
            res.json({ success: true, message: '工具已停止' });
        });
    } else {
        runningProcesses[toolId].kill('SIGTERM');
        delete runningProcesses[toolId];
        res.json({ success: true, message: '工具已停止' });
    }
});

app.post('/api/tools/:id/restart', async (req, res) => {
    const toolId = req.params.id;
    if (runningProcesses[toolId]) {
        const isWindows = process.platform === 'win32';
        if (isWindows) {
            exec(`taskkill /pid ${runningProcesses[toolId].pid} /T /F`);
        } else {
            runningProcesses[toolId].kill('SIGTERM');
        }
        delete runningProcesses[toolId];
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const tools = loadTools();
    const tool = tools.find(t => t.id === toolId);
    if (!tool) {
        return res.status(404).json({ error: '工具未找到' });
    }

    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const shellArgs = isWindows ? ['/c', tool.command] : ['-c', tool.command];

    const proc = spawn(shell, shellArgs, {
        cwd: tool.workDir,
        detached: !isWindows,
        stdio: 'ignore'
    });

    proc.unref();
    runningProcesses[toolId] = proc;

    proc.on('exit', () => {
        delete runningProcesses[toolId];
    });

    res.json({ success: true, message: '工具已重启' });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`服务器运行在 http://0.0.0.0:${PORT}`);
});
