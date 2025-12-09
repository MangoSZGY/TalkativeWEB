const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
// Statikus fájlok kiszolgálása a public mappából
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const clients = new Map();

wss.on('connection', (ws) => {
  let registeredId = null;

  ws.on('message', (msg) => {
    let data;
    try { 
        data = JSON.parse(msg); 
    } catch (e) { 
        console.error('Invalid JSON received');
        return; 
    }
    const { type, to, from } = data;

    // 1. Regisztráció
    if (type === 'register' && data.id) {
      registeredId = data.id;
      if (clients.has(registeredId) && clients.get(registeredId).readyState === WebSocket.OPEN) {
          console.log(`ID ${registeredId} already taken. Ignoring new registration.`);
          registeredId = null; 
          return;
      }
      clients.set(data.id, ws);
      console.log(`User ${data.id} registered.`);
      broadcastPresence();
      return;
    }

    // 2. Továbbítás a célkliensnek (pl. WebRTC jelzés, chat)
    if (to && clients.has(to)) {
      try {
        if (!data.from) data.from = registeredId; 
        clients.get(to).send(JSON.stringify(data));
      } catch (e) {
        console.error(`Forward error to ${to}`, e);
      }
    } else if (to) {
        console.log(`Target ${to} not found for message type ${type}`);
        if (registeredId) {
            ws.send(JSON.stringify({ type: 'error', message: `User ${to} is offline.`, originalType: type }));
        }
    }
  });

  ws.on('close', () => {
    if (registeredId) {
      clients.delete(registeredId);
      console.log(`User ${registeredId} disconnected.`);
      broadcastPresence();
    }
  });

  ws.on('error', (err) => {
      console.error('WS Error:', err.message);
      if (registeredId) {
          clients.delete(registeredId);
          broadcastPresence();
      }
  });
});

function broadcastPresence() {
  const online = Array.from(clients.keys()); 
  const msg = JSON.stringify({ type: 'presence', online });
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
  console.log('Online users updated:', online);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});