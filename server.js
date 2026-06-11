const WebSocket = require('ws');

const clients = new Map();
const rooms = new Map();

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

console.log(`聊天室服务端已启动，地址: ws://localhost:${PORT}`);

// 辅助函数：打印当前所有房间的状态
function logRoomStatus() {
    console.log('=== 当前房间状态 ===');
    for (let [roomId, clientsSet] of rooms.entries()) {
        console.log(`房间 ${roomId}: 在线人数 ${clientsSet.size}`);
    }
    console.log('==================');
}

// 辅助函数：广播房间成员列表
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
        userId: null
    });

    ws.on('message', (data) => {
        const rawMessage = data.toString();
        console.log('收到消息:', rawMessage);
        
        try {
            const message = JSON.parse(rawMessage);
            const clientInfo = clients.get(ws);
            
            if (message.type === 'JOIN') {
                clientInfo.roomId = message.roomId;
                clientInfo.userName = message.userName;
                clientInfo.userAvatar = message.userAvatar || '';  // 新增头像
                clientInfo.userId = message.userId || Date.now().toString();
                clients.set(ws, clientInfo);
                
                // 1. 将当前客户端添加到房间
                if (!rooms.has(message.roomId)) {
                    rooms.set(message.roomId, new Set());
                }
                const roomClients = rooms.get(message.roomId);
                roomClients.add(ws);
                
                console.log(`[加入] ${message.userName} (头像: ${clientInfo.userAvatar || '默认'}) 加入房间 ${message.roomId}`);
                logRoomStatus();
                
                // 构建用户信息对象
                const userInfo = {
                    userName: clientInfo.userName,
                    userAvatar: clientInfo.userAvatar,
                    userId: clientInfo.userId
                };
                
                // 2. 给自己发送欢迎消息（带用户信息）
                ws.send(JSON.stringify({
                    type: 'SYSTEM',
                    content: `欢迎 ${message.userName} 加入聊天室`,
                    user: userInfo,
                    timestamp: Date.now()
                }));
                
                // 3. 广播给房间内其他客户端（带用户信息）
                const messageForOthers = JSON.stringify({
                    type: 'SYSTEM',
                    content: `${message.userName} 加入了聊天室`,
                    user: userInfo,
                    timestamp: Date.now()
                });
                
                roomClients.forEach(client => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        console.log(`[广播] 向其他客户端发送加入消息`);
                        client.send(messageForOthers);
                    }
                });
                
                // 4. 广播更新后的成员列表
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
                            userAvatar: clientInfo.userAvatar || '',  // 新增头像
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
                    } else {
                        console.error(`[错误] 找不到房间 ${clientInfo.roomId}`);
                    }
                }
            }
            else if (message.type === 'LEAVE') {
                // 处理主动离开消息
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
            else {
                console.log('未知消息类型:', message.type);
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
                
                // 广播离开消息
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
                    // 更新成员列表
                    broadcastRoomMembers(info.roomId);
                }
            }
            logRoomStatus();
        }
        clients.delete(ws);
    });
});