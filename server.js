const WebSocket = require('ws');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// 创建 Express 应用
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ========== 数据库配置 ==========
const dbPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ========== 版本信息存储（内存缓存） ==========
let appVersion = {
    versionCode: 1,
    versionName: "1.0.0",
    downloadUrl: "",
    forceUpdate: false,
    updateMessage: "",
    updateTime: Date.now()
};

// 版本信息文件路径（用于备份）
const VERSION_FILE = path.join(__dirname, 'app-version-backup.json');

// ========== 数据库操作函数 ==========

// 初始化数据库表
async function initDatabase() {
    try {
        // 创建版本信息表
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS app_version (
                id SERIAL PRIMARY KEY,
                version_code INTEGER NOT NULL,
                version_name VARCHAR(50) NOT NULL,
                download_url TEXT,
                force_update BOOLEAN DEFAULT FALSE,
                update_message TEXT,
                update_time BIGINT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // 创建管理员表（可选）
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS admins (
                id SERIAL PRIMARY KEY,
                admin_key VARCHAR(100) NOT NULL UNIQUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        console.log('[数据库] 表初始化成功');
        
        // 检查是否有版本数据，没有则插入默认数据
        const result = await dbPool.query('SELECT COUNT(*) FROM app_version');
        if (parseInt(result.rows[0].count) === 0) {
            await dbPool.query(`
                INSERT INTO app_version (version_code, version_name, download_url, force_update, update_message, update_time)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [1, '1.0.0', '', false, '', Date.now()]);
            console.log('[数据库] 已插入默认版本数据');
        }
        
        // 从数据库加载版本信息到内存
        await loadVersionFromDB();
        
    } catch (error) {
        console.error('[数据库] 初始化失败:', error.message);
    }
}

// 从数据库加载最新版本信息
async function loadVersionFromDB() {
    try {
        const result = await dbPool.query(`
            SELECT version_code, version_name, download_url, force_update, update_message, update_time 
            FROM app_version 
            ORDER BY version_code DESC 
            LIMIT 1
        `);
        
        if (result.rows.length > 0) {
            const row = result.rows[0];
            appVersion = {
                versionCode: row.version_code,
                versionName: row.version_name,
                downloadUrl: row.download_url || '',
                forceUpdate: row.force_update,
                updateMessage: row.update_message || '',
                updateTime: row.update_time
            };
            console.log(`[数据库] 已加载版本信息: v${appVersion.versionName} (code: ${appVersion.versionCode})`);
        }
    } catch (error) {
        console.error('[数据库] 加载版本信息失败:', error.message);
    }
}

// 保存版本信息到数据库
async function saveVersionToDB() {
    try {
        await dbPool.query(`
            INSERT INTO app_version (version_code, version_name, download_url, force_update, update_message, update_time)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [
            appVersion.versionCode,
            appVersion.versionName,
            appVersion.downloadUrl,
            appVersion.forceUpdate,
            appVersion.updateMessage,
            appVersion.updateTime
        ]);
        console.log(`[数据库] 版本信息已保存: v${appVersion.versionName}`);
        return true;
    } catch (error) {
        console.error('[数据库] 保存版本信息失败:', error.message);
        return false;
    }
}

// 保存版本信息（同时保存到数据库和备份文件）
async function saveVersion() {
    const dbSuccess = await saveVersionToDB();
    
    // 备份到文件
    try {
        fs.writeFileSync(VERSION_FILE, JSON.stringify(appVersion, null, 2));
        console.log(`[文件备份] 版本信息已保存: v${appVersion.versionName}`);
    } catch (e) {
        console.error('[文件备份] 保存失败:', e.message);
    }
    
    return dbSuccess;
}

// 从备份文件恢复（当数据库为空时使用）
async function restoreFromBackup() {
    if (fs.existsSync(VERSION_FILE)) {
        try {
            const saved = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
            appVersion = { ...appVersion, ...saved };
            await saveVersionToDB();
            console.log(`[恢复] 从备份文件恢复版本: v${appVersion.versionName}`);
            return true;
        } catch (e) {
            console.error('[恢复] 读取备份失败:', e.message);
        }
    }
    return false;
}

// ========== HTTP API 接口 ==========

// 1. 客户端获取最新版本信息
app.get('/api/version', (req, res) => {
    console.log(`[API] 版本查询请求，当前版本: v${appVersion.versionName}`);
    res.json({
        success: true,
        data: {
            versionCode: appVersion.versionCode,
            versionName: appVersion.versionName,
            downloadUrl: appVersion.downloadUrl,
            forceUpdate: appVersion.forceUpdate,
            updateMessage: appVersion.updateMessage,
            updateTime: appVersion.updateTime
        }
    });
});

// 2. 管理员更新版本信息
app.post('/api/update-version', async (req, res) => {
    const { versionCode, versionName, downloadUrl, forceUpdate, updateMessage, adminKey } = req.body;
    
    const ADMIN_KEY = process.env.ADMIN_KEY || 'your-secret-key';
    if (adminKey !== ADMIN_KEY) {
        return res.status(401).json({ success: false, error: '未授权' });
    }
    
    if (versionCode !== undefined) appVersion.versionCode = parseInt(versionCode);
    if (versionName !== undefined) appVersion.versionName = versionName;
    if (downloadUrl !== undefined) appVersion.downloadUrl = downloadUrl;
    if (forceUpdate !== undefined) appVersion.forceUpdate = forceUpdate === true || forceUpdate === 'true';
    if (updateMessage !== undefined) appVersion.updateMessage = updateMessage;
    appVersion.updateTime = Date.now();
    
    await saveVersion();
    
    broadcastAppUpdate();
    
    console.log(`[API] 版本已更新: v${appVersion.versionName} (code: ${appVersion.versionCode})`);
    res.json({ success: true, message: '版本信息已更新' });
});

// 3. 数据库健康检查接口
app.get('/api/db-health', async (req, res) => {
    try {
        const result = await dbPool.query('SELECT 1 as health');
        res.json({ 
            success: true, 
            status: 'connected',
            timestamp: Date.now()
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            status: 'disconnected',
            error: error.message 
        });
    }
});

// 4. 获取版本历史记录
app.get('/api/version-history', async (req, res) => {
    try {
        const result = await dbPool.query(`
            SELECT version_code, version_name, update_message, update_time 
            FROM app_version 
            ORDER BY version_code DESC 
            LIMIT 10
        `);
        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ========== 简单的管理页面 ==========
app.get('/admin', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>版本管理</title>
            <meta charset="utf-8">
            <style>
                body { font-family: Arial; padding: 20px; max-width: 600px; margin: 0 auto; }
                input, textarea { width: 100%; padding: 8px; margin: 8px 0; box-sizing: border-box; }
                button { background: #28a745; color: white; padding: 10px 20px; border: none; cursor: pointer; }
                .info { background: #f0f0f0; padding: 15px; margin: 20px 0; border-radius: 5px; }
                .status { background: #e8f5e9; padding: 10px; margin: 10px 0; border-radius: 5px; font-size: 14px; }
            </style>
        </head>
        <body>
            <h1>📱 应用版本管理</h1>
            <div class="status" id="dbStatus">检查数据库连接...</div>
            <div class="info">
                <strong>当前版本：</strong> v${appVersion.versionName} (code: ${appVersion.versionCode})<br>
                <strong>下载地址：</strong> <a href="${appVersion.downloadUrl}" target="_blank">${appVersion.downloadUrl || '未设置'}</a><br>
                <strong>强制更新：</strong> ${appVersion.forceUpdate ? '是' : '否'}
            </div>
            
            <form id="versionForm">
                <input type="hidden" name="adminKey" value="${process.env.ADMIN_KEY || 'your-secret-key'}">
                <label>版本号 (数字):</label>
                <input type="number" name="versionCode" value="${appVersion.versionCode + 1}" required>
                
                <label>版本名:</label>
                <input type="text" name="versionName" placeholder="例如: 1.1.0" required>
                
                <label>APK下载地址 (GitHub Releases链接):</label>
                <input type="url" name="downloadUrl" placeholder="https://github.com/.../app.apk" required>
                
                <label>更新内容:</label>
                <textarea name="updateMessage" rows="4" placeholder="1. 新增功能A&#10;2. 修复问题B"></textarea>
                
                <label>
                    <input type="checkbox" name="forceUpdate" value="true">
                    强制更新（用户必须更新才能使用）
                </label>
                
                <button type="submit">发布新版本</button>
            </form>
            
            <div id="result" style="margin-top: 20px;"></div>
            
            <script>
                // 检查数据库状态
                fetch('/api/db-health')
                    .then(res => res.json())
                    .then(data => {
                        const statusDiv = document.getElementById('dbStatus');
                        if (data.success && data.status === 'connected') {
                            statusDiv.innerHTML = '✅ 数据库连接正常';
                            statusDiv.style.background = '#e8f5e9';
                        } else {
                            statusDiv.innerHTML = '❌ 数据库连接失败: ' + (data.error || '未知错误');
                            statusDiv.style.background = '#ffebee';
                        }
                    })
                    .catch(err => {
                        document.getElementById('dbStatus').innerHTML = '❌ 无法连接到服务器';
                        document.getElementById('dbStatus').style.background = '#ffebee';
                    });
                
                document.getElementById('versionForm').onsubmit = async (e) => {
                    e.preventDefault();
                    const formData = new FormData(e.target);
                    const data = {};
                    formData.forEach((value, key) => {
                        if (key === 'forceUpdate') {
                            data[key] = true;
                        } else {
                            data[key] = value;
                        }
                    });
                    
                    const response = await fetch('/api/update-version', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(data)
                    });
                    
                    const result = await response.json();
                    const resultDiv = document.getElementById('result');
                    if (result.success) {
                        resultDiv.innerHTML = '<div style="color: green;">✅ 版本已发布，已通知所有在线用户</div>';
                        setTimeout(() => location.reload(), 2000);
                    } else {
                        resultDiv.innerHTML = '<div style="color: red;">❌ 发布失败: ' + result.error + '</div>';
                    }
                };
            </script>
        </body>
        </html>
    `);
});

// ========== WebSocket 广播函数 ==========

function broadcastAppUpdate() {
    if (!appVersion.downloadUrl) {
        console.log('[广播] 没有配置下载地址，跳过广播');
        return;
    }
    
    const updateMsg = JSON.stringify({
        type: 'APP_UPDATE',
        data: {
            versionCode: appVersion.versionCode,
            versionName: appVersion.versionName,
            downloadUrl: appVersion.downloadUrl,
            forceUpdate: appVersion.forceUpdate,
            updateMessage: appVersion.updateMessage,
            updateTime: appVersion.updateTime
        }
    });
    
    let broadcastCount = 0;
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(updateMsg);
            broadcastCount++;
        }
    });
    
    console.log(`[广播] 已推送应用更新通知给 ${broadcastCount} 个在线客户端`);
}

// ========== WebSocket 聊天室 ==========

const clients = new Map();
const rooms = new Map();

const PORT = process.env.PORT || 8080;

// 创建 HTTP 服务器
const server = app.listen(PORT, () => {
    console.log(`HTTP 服务器已启动，端口: ${PORT}`);
    console.log(`API 地址: http://localhost:${PORT}/api/version`);
    console.log(`管理页面: http://localhost:${PORT}/admin`);
    console.log(`健康检查: http://localhost:${PORT}/api/db-health`);
});

// WebSocket 服务器
const wss = new WebSocket.Server({ server });

console.log(`WebSocket 服务器已启动，地址: ws://localhost:${PORT}`);

function broadcastRoomMembers(roomId) {
    const roomClients = rooms.get(roomId);
    if (!roomClients) return;
    
    const members = [];
    for (let client of roomClients) {
        const info = clients.get(client);
        if (info && info.userName) {
            members.push({
                userName: info.userName,
                userAvatar: info.userAvatar || '',
                userId: info.userId
            });
        }
    }
    
    const memberListMsg = JSON.stringify({
        type: 'SYSTEM',
        content: '成员列表更新',
        members: members,
        action: 'MEMBER_LIST',
        timestamp: Date.now()
    });
    
    roomClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(memberListMsg);
        }
    });
}

wss.on('connection', (ws) => {
    console.log('有新客户端连接');
    clients.set(ws, { 
        roomId: null, 
        userName: null,
        userAvatar: null,
        userId: null,
        versionCode: null
    });

    ws.on('message', (data) => {
        const rawMessage = data.toString();
        console.log('收到消息:', rawMessage);
        
        try {
            const message = JSON.parse(rawMessage);
            const clientInfo = clients.get(ws);
            
            if (message.type === 'VERSION_CHECK') {
                clientInfo.versionCode = message.versionCode;
                console.log(`[版本] 客户端 ${clientInfo.userName || '未知'} 版本: ${message.versionCode}`);
                
                if (appVersion.downloadUrl && message.versionCode < appVersion.versionCode) {
                    ws.send(JSON.stringify({
                        type: 'APP_UPDATE',
                        data: {
                            versionCode: appVersion.versionCode,
                            versionName: appVersion.versionName,
                            downloadUrl: appVersion.downloadUrl,
                            forceUpdate: appVersion.forceUpdate,
                            updateMessage: appVersion.updateMessage,
                            updateTime: appVersion.updateTime
                        }
                    }));
                    console.log(`[版本] 向客户端推送更新通知: v${appVersion.versionName}`);
                }
            }
            else if (message.type === 'JOIN') {
                clientInfo.roomId = message.roomId;
                clientInfo.userName = message.userName;
                clientInfo.userAvatar = message.userAvatar || '';
                clientInfo.userId = message.userId || Date.now().toString();
                clients.set(ws, clientInfo);
                
                if (!rooms.has(message.roomId)) {
                    rooms.set(message.roomId, new Set());
                }
                const roomClients = rooms.get(message.roomId);
                roomClients.add(ws);
                
                console.log(`[加入] ${message.userName} 加入房间 ${message.roomId}`);
                
                const userInfo = {
                    userName: clientInfo.userName,
                    userAvatar: clientInfo.userAvatar,
                    userId: clientInfo.userId
                };
                
                ws.send(JSON.stringify({
                    type: 'SYSTEM',
                    content: `欢迎 ${message.userName} 加入聊天室`,
                    user: userInfo,
                    timestamp: Date.now()
                }));
                
                const messageForOthers = JSON.stringify({
                    type: 'SYSTEM',
                    content: `${message.userName} 加入了聊天室`,
                    user: userInfo,
                    timestamp: Date.now()
                });
                
                roomClients.forEach(client => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(messageForOthers);
                    }
                });
                
                broadcastRoomMembers(message.roomId);
            }
            else if (message.type === 'MESSAGE') {
                if (clientInfo.roomId && clientInfo.userName) {
                    const roomClients = rooms.get(clientInfo.roomId);
                    if (roomClients) {
                        if(message.userAvatar != clientInfo.userAvatar) {
                            clientInfo.userAvatar = message.userAvatar || '';
                            clients.set(ws, clientInfo);
                        }
                        const messageForAll = JSON.stringify({
                            type: 'MESSAGE',
                            userName: clientInfo.userName,
                            userAvatar: clientInfo.userAvatar || '',
                            userId: clientInfo.userId,
                            content: message.content,
                            timestamp: Date.now()
                        });
                        
                        console.log(`[广播消息] "${clientInfo.userName}" 说: ${message.content}`);
                        roomClients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(messageForAll);
                            }
                        });
                    }
                }
            }
            else if (message.type === 'LEAVE') {
                if (clientInfo.roomId && clientInfo.userName) {
                    const roomClients = rooms.get(clientInfo.roomId);
                    if (roomClients) {
                        const leaveMsg = JSON.stringify({
                            type: 'SYSTEM',
                            content: `${clientInfo.userName} 离开了聊天室`,
                            user: {
                                userName: clientInfo.userName,
                                userAvatar: clientInfo.userAvatar,
                                userId: clientInfo.userId
                            },
                            timestamp: Date.now()
                        });
                        
                        roomClients.forEach(client => {
                            if (client !== ws && client.readyState === WebSocket.OPEN) {
                                client.send(leaveMsg);
                            }
                        });
                    }
                }
            }
        } catch (e) {
            console.error('解析消息失败:', e.message);
        }
    });

    ws.on('close', () => {
        const info = clients.get(ws);
        if (info && info.roomId && info.userName) {
            console.log(`[离开] ${info.userName} 断开连接`);
            const roomClients = rooms.get(info.roomId);
            if (roomClients) {
                roomClients.delete(ws);
                
                const leaveMsg = JSON.stringify({
                    type: 'SYSTEM',
                    content: `${info.userName} 离开了聊天室`,
                    user: {
                        userName: info.userName,
                        userAvatar: info.userAvatar,
                        userId: info.userId
                    },
                    timestamp: Date.now()
                });
                
                roomClients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(leaveMsg);
                    }
                });
                
                if (roomClients.size === 0) {
                    rooms.delete(info.roomId);
                } else {
                    broadcastRoomMembers(info.roomId);
                }
            }
        }
        clients.delete(ws);
    });
});

// ========== 启动数据库初始化 ==========
initDatabase().then(() => {
    console.log('[启动] 数据库初始化完成');
}).catch(err => {
    console.error('[启动] 数据库初始化失败:', err);
    // 尝试从备份恢复
    restoreFromBackup().then(() => {
        console.log('[启动] 已从备份恢复数据');
    });
});