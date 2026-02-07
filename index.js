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
        const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
        rooms[roomCode] = {
            players: [],
            deck: [],
            discardPile: [],
            enactedPolicies: { tradition: 0, construction: 0 },
            electionTracker: 0,
            lastPresident: null,
            lastVP: null,
            currentPres: null,
            currentVP: null,
            currentVotes: {},
            gameActive: false,
            presidentialIndex: 0
        };
        joinPlayerToRoom(socket, roomCode, userName, true);
    });

    socket.on('joinRoom', ({ roomCode, userName }) => {
        const code = roomCode.toUpperCase();
        const room = rooms[code];
        if (!room) return socket.emit('errorMsg', "Room not found.");
        if (room.gameActive) return socket.emit('errorMsg', "Game already in progress.");
        if (room.players.some(p => p.name.toLowerCase() === userName.toLowerCase())) {
            return socket.emit('errorMsg', "Name already taken in this room.");
        }
        joinPlayerToRoom(socket, code, userName, false);
    });

    function joinPlayerToRoom(socket, roomCode, name, isHost) {
        const room = rooms[roomCode];
        const newPlayer = { id: socket.id, name, isHost, alive: true, role: 'Unassigned', party: 'Liberal' };
        room.players.push(newPlayer);
        socket.join(roomCode);
        socket.roomCode = roomCode;

        socket.emit('joinedRoom', { roomCode, isHost, name });
        io.to(roomCode).emit('updatePlayerList', getPlayerListWithStatus(room));
        io.to(roomCode).emit('chatMessage', { user: "SYSTEM", msg: `${name} joined room ${roomCode}` });
    }

    socket.on('startGame', () => {
        const room = rooms[socket.roomCode];
        if (!room || room.players.length < 5) return socket.emit('errorMsg', "Need 5+ players.");
        
        room.gameActive = true;
        room.deck = [...Array(6).fill("Tradition"), ...Array(11).fill("Construction")].sort(() => 0.5 - Math.random());
        
        let shuffled = [...room.players].sort(() => 0.5 - Math.random());
        let bison = shuffled[0];
        bison.role = "THE BISON 🦬"; bison.party = "Fascist";

        const count = room.players.length;
        if (count <= 6) {
            let spy = shuffled[1];
            spy.role = "HOOSIER SPY 🚩"; spy.party = "Fascist";
            io.to(bison.id).emit('assignRole', { role: bison.role, info: `Spy: ${spy.name}` });
            io.to(spy.id).emit('assignRole', { role: spy.role, info: `Bison: ${bison.name}` });
        } else {
            let spyCount = count <= 8 ? 2 : 3;
            let spies = shuffled.slice(1, 1 + spyCount);
            spies.forEach(s => { 
                s.role = "HOOSIER SPY 🚩"; s.party = "Fascist"; 
                let others = spies.filter(o => o.id !== s.id).map(o => o.name);
                io.to(s.id).emit('assignRole', { role: s.role, info: `Bison: ${bison.name}. Spies: ${others.join(', ')}` });
            });
            io.to(bison.id).emit('assignRole', { role: bison.role, info: "You are the Bison. You don't know the spies." });
        }

        room.players.forEach(p => {
            if(p.role === 'Unassigned') {
                p.role = "BOILERMAKER 🚂"; p.party = "Liberal";
                io.to(p.id).emit('assignRole', { role: p.role, info: "Protect Purdue!" });
            }
        });

        io.to(socket.roomCode).emit('gameStarted');
        startNewRound(room);
    });

    function startNewRound(room) {
        if (!room.gameActive) return;
        let attempts = 0;
        do {
            room.currentPres = room.players[room.presidentialIndex];
            room.presidentialIndex = (room.presidentialIndex + 1) % room.players.length;
            attempts++;
        } while (!room.currentPres.alive && attempts < room.players.length);

        room.currentVP = null;
        room.currentVotes = {};
        io.to(socket.roomCode).emit('updatePlayerList', getPlayerListWithStatus(room));
        io.to(socket.roomCode).emit('newRound', { presidentName: room.currentPres.name, presidentId: room.currentPres.id });
    }

    socket.on('nominateVP', (vpName) => {
        const room = rooms[socket.roomCode];
        const nominee = room.players.find(p => p.name === vpName);
        room.currentVP = nominee;
        io.to(socket.roomCode).emit('startVoting', { pres: room.currentPres.name, vp: nominee.name });
    });

    socket.on('submitVote', (vote) => {
        const room = rooms[socket.roomCode];
        room.currentVotes[socket.id] = vote;
        const living = room.players.filter(p => p.alive);
        if (Object.keys(room.currentVotes).length === living.length) {
            const yes = Object.values(room.currentVotes).filter(v => v === 'Boiler Up!').length;
            if (yes > (living.length / 2)) {
                room.electionTracker = 0;
                if (room.enactedPolicies.construction >= 3 && room.currentVP.role === "THE BISON 🦬") {
                    return endGame(socket.roomCode, "HOOSIERS WIN: Bison elected VP!");
                }
                io.to(room.currentPres.id).emit('presDrawPhase');
            } else {
                room.electionTracker++;
                if (room.electionTracker >= 3) {
                    applyPolicy(socket.roomCode, room.deck.shift());
                    room.electionTracker = 0;
                } else startNewRound(room);
            }
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
        const room = rooms[socket.roomCode];
        io.to(room.currentVP.id).emit('vpEnactPhase', { cards: rem, canVeto: room.enactedPolicies.construction >= 5 });
    });

    socket.on('vpEnact', (chosen) => applyPolicy(socket.roomCode, chosen));

    function applyPolicy(roomCode, type) {
        const room = rooms[roomCode];
        type === "Tradition" ? room.enactedPolicies.tradition++ : room.enactedPolicies.construction++;
        room.lastPresident = room.currentPres.name; room.lastVP = room.currentVP.name;
        
        io.to(roomCode).emit('policyUpdated', { enactedPolicies: room.enactedPolicies, electionTracker: room.electionTracker, playerCount: room.players.length });
        
        if (room.enactedPolicies.tradition >= 5) return endGame(roomCode, "BOILERMAKERS WIN!");
        if (room.enactedPolicies.construction >= 6) return endGame(roomCode, "HOOSIERS WIN!");
        
        if (type === "Construction") handlePower(roomCode, room.enactedPolicies.construction);
        else startNewRound(room);
    }

    function handlePower(roomCode, count) {
        const room = rooms[roomCode];
        const total = room.players.length;
        if ((count === 1 && total >= 9) || (count === 2 && total >= 7)) io.to(room.currentPres.id).emit('triggerInvestigate');
        else if (count === 3) io.to(room.currentPres.id).emit('triggerPeek', room.deck.slice(0, 3));
        else if (count === 4 || count === 5) io.to(room.currentPres.id).emit('triggerExpel');
        else startNewRound(room);
    }

    socket.on('powerInvestigate', (name) => {
        const room = rooms[socket.roomCode];
        const target = room.players.find(p => p.name === name);
        socket.emit('investigateResult', { name, party: target.party });
        startNewRound(room);
    });

    socket.on('powerExpel', (name) => {
        const room = rooms[socket.roomCode];
        const target = room.players.find(p => p.name === name);
        target.alive = false;
        io.to(socket.roomCode).emit('chatMessage', { user: "SYSTEM", msg: `${name} was EXPELLED!` });
        if (target.role === "THE BISON 🦬") return endGame(socket.roomCode, "BOILERMAKERS WIN!");
        startNewRound(room);
    });

    socket.on('peekFinished', () => startNewRound(rooms[socket.roomCode]));

    socket.on('sendChat', (msg) => {
        const room = rooms[socket.roomCode];
        const p = room?.players.find(p => p.id === socket.id);
        if (p) io.to(socket.roomCode).emit('chatMessage', { user: p.name, msg });
    });

    function endGame(roomCode, msg) {
        io.to(roomCode).emit('gameOver', msg);
        delete rooms[roomCode];
    }

    socket.on('disconnect', () => {
        const roomCode = socket.roomCode;
        if (roomCode && rooms[roomCode]) {
            const room = rooms[roomCode];
            room.players = room.players.filter(p => p.id !== socket.id);
            if (room.players.length === 0) delete rooms[roomCode];
            else if (room.gameActive) endGame(roomCode, "A player left. Game ended.");
            else io.to(roomCode).emit('updatePlayerList', getPlayerListWithStatus(room));
        }
    });

    function getPlayerListWithStatus(room) {
        return room.players.map(p => ({
            name: p.name,
            alive: p.alive,
            isPres: room.currentPres && p.id === room.currentPres.id,
            isLimit: (p.name === room.lastPresident || p.name === room.lastVP)
        }));
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on ${PORT}`));