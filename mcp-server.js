const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'tools.json');

function loadTools() {
    if (!fs.existsSync(DATA_FILE)) {
        return [];
    }
    const data = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(data || '[]');
}

async function checkHealth(tool) {
    return new Promise((resolve) => {
        if (!tool.healthCheckUrl) {
            resolve({ status: 'unknown' });
            return;
        }
        
        const timeout = setTimeout(() => {
            resolve({ status: 'unhealthy' });
        }, 5000);

        const url = new URL(tool.healthCheckUrl);
        const http = url.protocol === 'https:' ? require('https') : require('http');
        
        const req = http.get(tool.healthCheckUrl, (res) => {
            clearTimeout(timeout);
            if (res.statusCode >= 200 && res.statusCode < 400) {
                resolve({ status: 'healthy' });
            } else {
                resolve({ status: 'unhealthy' });
            }
        });

        req.on('error', () => {
            clearTimeout(timeout);
            resolve({ status: 'unhealthy' });
        });
    });
}

async function getRunningTools() {
    const tools = loadTools();
    const result = [];
    
    for (const tool of tools) {
        if (tool.hidden) continue;
        
        let status = 'stopped';
        if (tool.healthCheckUrl) {
            const health = await checkHealth(tool);
            status = health.status === 'healthy' ? 'running' : 'stopped';
        }
        
        if (status !== 'running') continue;
        
        for (const service of (tool.services || [])) {
            if (!service.apiUrl) continue;
            
            const properties = {};
            const required = [];
            
            (service.parameters || []).forEach(p => {
                const typeMap = {
                    'string': 'string',
                    'number': 'number',
                    'boolean': 'boolean',
                    'object': 'object'
                };
                
                properties[p.name] = {
                    type: typeMap[p.type] || 'string',
                    description: p.description || `${p.name} (${p.type || 'string'})`
                };
                
                if (p.defaultValue !== undefined && p.defaultValue !== '') {
                    properties[p.name].default = p.defaultValue;
                }
                
                if (p.required) {
                    required.push(p.name);
                }
            });
            
            result.push({
                name: service.name,
                description: service.description || `${service.name} - 通过 ${service.method || 'GET'} 调用 ${service.apiUrl}`,
                inputSchema: {
                    type: 'object',
                    properties: properties,
                    required: required
                }
            });
        }
    }
    
    return result;
}

async function callTool(name, arguments_) {
    const tools = loadTools();
    let targetService = null;
    
    for (const tool of tools) {
        if (tool.hidden) continue;
        
        for (const service of (tool.services || [])) {
            if (service.name === name && service.apiUrl) {
                targetService = service;
                break;
            }
        }
        if (targetService) break;
    }
    
    if (!targetService) {
        return {
            content: [{ type: 'text', text: `工具 "${name}" 未找到或未配置 API` }],
            isError: true
        };
    }
    
    try {
        const method = (targetService.method || 'GET').toUpperCase();
        const url = new URL(targetService.apiUrl);
        
        if (method === 'GET') {
            const searchParams = new URLSearchParams();
            (targetService.parameters || []).forEach(p => {
                const value = arguments_ ? arguments_[p.name] : undefined;
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
                            body: data ? JSON.parse(data) : {}
                        });
                    } catch (e) {
                        resolve({
                            statusCode: resHttp.statusCode,
                            body: data
                        });
                    }
                });
            });
            
            reqHttp.on('error', reject);
            
            if (method === 'POST') {
                const body = {};
                (targetService.parameters || []).forEach(p => {
                    const value = arguments_ ? arguments_[p.name] : undefined;
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
        
        const resultText = typeof response.body === 'object' ? JSON.stringify(response.body, null, 2) : String(response.body);
        
        return {
            content: [{ type: 'text', text: resultText }],
            isError: false
        };
    } catch (error) {
        return {
            content: [{ type: 'text', text: `调用工具失败: ${error.message}` }],
            isError: true
        };
    }
}

let requestId = 0;

async function handleMessage(message) {
    try {
        const parsed = JSON.parse(message);
        const { jsonrpc, id, method, params } = parsed;
        
        if (jsonrpc !== '2.0') {
            return null;
        }
        
        const responseId = id;
        
        switch (method) {
            case 'initialize':
                return {
                    jsonrpc: '2.0',
                    id: responseId,
                    result: {
                        protocolVersion: '2025-03-26',
                        capabilities: {
                            tools: {
                                listChanged: true
                            }
                        },
                        serverInfo: {
                            name: 'toolsWeb-mcp-server',
                            version: '1.0.0'
                        }
                    }
                };
                
            case 'tools/list':
                const tools = await getRunningTools();
                return {
                    jsonrpc: '2.0',
                    id: responseId,
                    result: {
                        tools: tools,
                        nextCursor: null
                    }
                };
                
            case 'tools/call':
                const { name, arguments: args } = params;
                const result = await callTool(name, args);
                return {
                    jsonrpc: '2.0',
                    id: responseId,
                    result: result
                };
                
            case 'initialized':
                return null;
                
            default:
                return {
                    jsonrpc: '2.0',
                    id: responseId,
                    error: {
                        code: -32601,
                        message: 'Method not found'
                    }
                };
        }
    } catch (error) {
        return {
            jsonrpc: '2.0',
            id: requestId++,
            error: {
                code: -32603,
                message: 'Internal error',
                data: error.message
            }
        };
    }
}

let buffer = '';

process.stdin.on('data', async (data) => {
    buffer += data.toString();
    
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.substring(0, newlineIndex);
        buffer = buffer.substring(newlineIndex + 1);
        
        if (line.trim()) {
            const response = await handleMessage(line);
            if (response) {
                process.stdout.write(JSON.stringify(response) + '\n');
            }
        }
    }
});

process.stdin.on('end', () => {
    process.exit(0);
});
