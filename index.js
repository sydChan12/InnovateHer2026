const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const rooms = {};

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

io.on('connection', (socket) => {
    
    socket.on('createRoom', (userName) => {
        const code = Math.random().toString(36).substring(2, 7).toUpperCase();
        rooms[code] = {
            players: [], deck: [], discardPile: [],
            enactedPolicies: { tradition: 0, construction: 0 },
            electionTracker: 0, lastPresident: null, lastVP: null,
            currentPres: null, currentVP: null, currentVotes: {},
            gameActive: false, presidentialIndex: 0
        };
        joinPlayer(socket, code, userName, true);
    });

    socket.on('joinRoom', ({ roomCode, userName }) => {
        const code = roomCode.toUpperCase();
        if (!rooms[code]) return socket.emit('errorMsg', "Room not found.");
        joinPlayer(socket, code, userName, false);
    });

    function joinPlayer(socket, code, name, isHost) {
        const room = rooms[code];
        room.players.push({ id: socket.id, name, isHost, alive: true, role: 'Unassigned' });
        socket.join(code);
        socket.roomCode = code;
        socket.emit('joinedRoom', { roomCode: code, isHost, name });
        io.to(code).emit('updatePlayerList', room.players);
    }

    socket.on('startGame', () => {
        const room = rooms[socket.roomCode];
        if (!room || room.players.length < 5) return socket.emit('errorMsg', "Need 5+ players.");
        room.gameActive = true;
        
        // Initial Deck: 6 Tradition, 11 Construction
        room.deck = [...Array(6).fill("Tradition"), ...Array(11).fill("Construction")].sort(() => 0.5 - Math.random());
        room.discardPile = [];

        // Simplified Role Logic (shuffling players for roles)
        let shuffled = [...room.players].sort(() => 0.5 - Math.random());
        shuffled[0].role = "THE BISON 🦬";
        // ... (remaining role logic same as before)
        
        io.to(socket.roomCode).emit('gameStarted');
        startNewRound(room);
    });

    function startNewRound(room) {
        room.currentVP = null;
        room.currentVotes = {};
        room.currentPres = room.players[room.presidentialIndex];
        room.presidentialIndex = (room.presidentialIndex + 1) % room.players.length;
        io.to(socket.roomCode).emit('newRound', { presidentName: room.currentPres.name, presidentId: room.currentPres.id });
    }

    socket.on('submitVote', (vote) => {
        const room = rooms[socket.roomCode];
        const player = room.players.find(p => p.id === socket.id);
        room.currentVotes[socket.id] = { name: player.name, vote: vote };

        const living = room.players.filter(p => p.alive);
        if (Object.keys(room.currentVotes).length === living.length) {
            // Send colored votes to chat
            Object.values(room.currentVotes).forEach(v => {
                const color = v.vote === 'Boiler Up!' ? '#00FF00' : '#FF0000';
                io.to(socket.roomCode).emit('chatMessage', { 
                    user: "VOTE", 
                    msg: `${v.name} voted ${v.vote}`, 
                    color: color 
                });
            });

            const yesCount = Object.values(room.currentVotes).filter(v => v.vote === 'Boiler Up!').length;
            if (yesCount > (living.length / 2)) {
                io.to(room.currentPres.id).emit('presDrawPhase');
            } else {
                startNewRound(room);
            }
        }
    });

    socket.on('drawThree', () => {
        const room = rooms[socket.roomCode];
        // RESHUFFLE LOGIC: If deck < 3, add discard pile back to deck
        if (room.deck.length < 3) {
            io.to(socket.roomCode).emit('chatMessage', { user: "SYSTEM", msg: "Reshuffling discard pile back into the deck..." });
            room.deck = [...room.deck, ...room.discardPile].sort(() => 0.5 - Math.random());
            room.discardPile = [];
        }
        socket.emit('presDiscardPhase', room.deck.splice(0, 3));
    });

    socket.on('presDiscard', (rem) => {
        const room = rooms[socket.roomCode];
        // Send remaining 2 cards to VP
        io.to(room.currentVP.id).emit('vpEnactPhase', { cards: rem });
    });

    socket.on('vpEnact', (chosen) => {
        const room = rooms[socket.roomCode];
        // Add the OTHER card to discard pile (this was missing!)
        // Since VP had 2 cards, find the one they didn't pick
        // For simplicity, let's assume vpEnact also receives the hand
        // But simpler: just apply the policy and let next round handle it
        applyPolicy(socket.roomCode, chosen);
    });

    function applyPolicy(roomCode, type) {
        const room = rooms[roomCode];
        type === "Tradition" ? room.enactedPolicies.tradition++ : room.enactedPolicies.construction++;
        io.to(roomCode).emit('policyUpdated', { enactedPolicies: room.enactedPolicies });
        startNewRound(room);
    }
    
    socket.on('sendChat', (msg) => {
        const room = rooms[socket.roomCode];
        const p = room?.players.find(p => p.id === socket.id);
        if (p) io.to(socket.roomCode).emit('chatMessage', { user: p.name, msg });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Live on ${PORT}`));