const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const rooms = {};

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

io.on('connection', (socket) => {
    socket.on('createRoom', (name) => {
        const code = Math.random().toString(36).substring(2, 7).toUpperCase();
        rooms[code] = {
            players: [], deck: [], discardPile: [],
            enactedPolicies: { tradition: 0, construction: 0 },
            currentPres: null, currentVP: null, currentVotes: {},
            gameActive: false, presidentialIndex: 0
        };
        join(socket, code, name, true);
    });

    socket.on('joinRoom', ({ roomCode, userName }) => {
        const code = roomCode.toUpperCase();
        if (!rooms[code]) return socket.emit('errorMsg', "Room not found.");
        join(socket, code, userName, false);
    });

    function join(socket, code, name, isHost) {
        const room = rooms[code];
        room.players.push({ id: socket.id, name, isHost, alive: true, role: 'Unassigned' });
        socket.join(code);
        socket.roomCode = code;
        socket.emit('joinedRoom', { roomCode: code, isHost, name });
        io.to(code).emit('updatePlayerList', room.players);
    }

    socket.on('startGame', () => {
        const room = rooms[socket.roomCode];
        if (!room || room.players.length < 5) return socket.emit('errorMsg', "Need 5+ players!");
        room.gameActive = true;
        room.deck = [...Array(6).fill("Tradition"), ...Array(11).fill("Construction")].sort(() => 0.5 - Math.random());
        
        let shuffled = [...room.players].sort(() => 0.5 - Math.random());
        shuffled.forEach((p, idx) => {
            p.role = idx === 0 ? "THE BISON 🦬" : "BOILERMAKER 🚂";
            io.to(p.id).emit('assignRole', { role: p.role });
        });

        io.to(socket.roomCode).emit('gameStarted');
        startNewRound(room);
    });

    function startNewRound(room) {
        room.currentVotes = {};
        room.currentVP = null;
        room.currentPres = room.players[room.presidentialIndex];
        room.presidentialIndex = (room.presidentialIndex + 1) % room.players.length;
        io.to(socket.roomCode).emit('newRound', { presidentName: room.currentPres.name, presidentId: room.currentPres.id, players: room.players });
    }

    socket.on('nominateVP', (vpName) => {
        const room = rooms[socket.roomCode];
        room.currentVP = room.players.find(p => p.name === vpName);
        io.to(socket.roomCode).emit('startVoting', { pres: room.currentPres.name, vp: vpName });
    });

    socket.on('submitVote', (vote) => {
        const room = rooms[socket.roomCode];
        const p = room.players.find(p => p.id === socket.id);
        room.currentVotes[socket.id] = { name: p.name, choice: vote };

        if (Object.keys(room.currentVotes).length === room.players.length) {
            Object.values(room.currentVotes).forEach(v => {
                const color = v.choice === 'Boiler Up!' ? '#00FF00' : '#FF0000';
                io.to(socket.roomCode).emit('chatMessage', { user: "VOTE", msg: `${v.name}: ${v.choice}`, color: color });
            });
            const yes = Object.values(room.currentVotes).filter(v => v.choice === 'Boiler Up!').length;
            if (yes > (room.players.length / 2)) io.to(room.currentPres.id).emit('presDrawPhase');
            else startNewRound(room);
        }
    });

    socket.on('drawThree', () => {
        const room = rooms[socket.roomCode];
        if (room.deck.length < 3) {
            room.deck = [...room.deck, ...room.discardPile].sort(() => 0.5 - Math.random());
            room.discardPile = [];
        }
        socket.emit('presDiscardPhase', room.deck.splice(0, 3));
    });

    socket.on('presDiscard', (rem) => {
        io.to(rooms[socket.roomCode].currentVP.id).emit('vpEnactPhase', { cards: rem });
    });

    socket.on('vpEnact', (chosen) => {
        const room = rooms[socket.roomCode];
        chosen === "Tradition" ? room.enactedPolicies.tradition++ : room.enactedPolicies.construction++;
        io.to(socket.roomCode).emit('policyUpdated', { enactedPolicies: room.enactedPolicies });
        startNewRound(room);
    });

    socket.on('sendChat', (msg) => {
        const p = rooms[socket.roomCode]?.players.find(p => p.id === socket.id);
        if (p) io.to(socket.roomCode).emit('chatMessage', { user: p.name, msg });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Live on ${PORT}`));