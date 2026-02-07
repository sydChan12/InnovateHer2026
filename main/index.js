const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let players = []; // Like an ArrayList<Player>

// This runs whenever a "client" (phone/tab) connects
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // When someone joins the lobby
    socket.on('joinGame', (name) => {
        const newPlayer = { id: socket.id, name: name, role: 'Unassigned' };
        players.push(newPlayer);
        
        // Tell EVERYONE the new player list (Broadcast)
        io.emit('updatePlayerList', players);
    });

    // Handle disconnection (like a close() call)
    socket.on('disconnect', () => {
        players = players.filter(p => p.id !== socket.id);
        io.emit('updatePlayerList', players);
    });
});

server.listen(3000, () => {
    console.log('Server is UP at http://localhost:3000');
});
