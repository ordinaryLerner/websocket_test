const WebSocket = require('ws');

// const wss = new WebSocket.Server({ port: 8080 });
const clients = new Map();
const rooms = new Map();

// console.log('聊天室服务端已启动，地址: ws://localhost:8080');
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

wss.on('connection', (ws) => {
    console.log('有新客户端连接');
    clients.set(ws, { roomId: null, userName: null });

    ws.on('message', (data) => {
        const rawMessage = data.toString();
        console.log('收到消息:', rawMessage);
        
        try {
            const message = JSON.parse(rawMessage);
            const clientInfo = clients.get(ws);
            
            if (message.type === 'JOIN') {
                clientInfo.roomId = message.roomId;
                clientInfo.userName = message.userName;
                
                // 1. 将当前客户端添加到房间
                if (!rooms.has(message.roomId)) {
                    rooms.set(message.roomId, new Set());
                }
                const roomClients = rooms.get(message.roomId);
                roomClients.add(ws);
                
                console.log(`[加入] ${message.userName} 加入房间 ${message.roomId}`);
                logRoomStatus(); // 打印状态，看看第二个客户端是否被添加
                
                // 2. 给自己发送欢迎消息
                ws.send(JSON.stringify({
                    type: 'SYSTEM',
                    content: `欢迎 ${message.userName} 加入聊天室`,
                    timestamp: Date.now()
                }));
                
                // 3. 广播给房间内**其他**客户端
                const messageForOthers = JSON.stringify({
                    type: 'SYSTEM',
                    content: `${message.userName} 加入了聊天室`,
                    timestamp: Date.now()
                });
                
                roomClients.forEach(client => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        console.log(`[广播] 向其他客户端发送加入消息`);
                        client.send(messageForOthers);
                    }
                });
            }
            else if (message.type === 'MESSAGE') {
                if (clientInfo.roomId && clientInfo.userName) {
                    const roomClients = rooms.get(clientInfo.roomId);
                    if (roomClients) {
                        const messageForAll = JSON.stringify({
                            type: 'MESSAGE',
                            userName: clientInfo.userName,
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
                if (roomClients.size === 0) {
                    rooms.delete(info.roomId);
                }
            }
            logRoomStatus();
        }
        clients.delete(ws);
    });
});