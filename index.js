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
            players: [], deck: [], discardPile: [],
            enactedPolicies: { tradition: 0, construction: 0 },
            electionTracker: 0, lastPresident: null, lastVP: null,
            currentPres: null, currentVP: null, currentVotes: {},
            gameActive: false, presidentialIndex: 0
        };
        joinPlayerToRoom(socket, roomCode, userName, true);
    });

    socket.on('joinRoom', ({ roomCode, userName }) => {
        const code = roomCode.toUpperCase();
        const room = rooms[code];
        if (!room) return socket.emit('errorMsg', "Room not found.");
        if (room.gameActive) return socket.emit('errorMsg', "Game in progress.");
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
            let spyCount = (count <= 8) ? 2 : 3;
            let spies = shuffled.slice(1, 1 + spyCount);
            spies.forEach(s => { 
                s.role = "HOOSIER SPY 🚩"; s.party = "Fascist"; 
                let others = spies.filter(o => o.id !== s.id).map(o => o.name);
                io.to(s.id).emit('assignRole', { role: s.role, info: `Bison: ${bison.name}. Spies: ${others.join(', ')}` });
            });
            io.to(bison.id).emit('assignRole', { role: bison.role, info: "You are the Bison." });
        }

        room.players.forEach(p => {
            if(p.role === 'Unassigned') {
                p.role = "BOILERMAKER 🚂"; p.party = "Liberal";
                io.to(p.id).emit('assignRole', { role: p.role, info: "Protect Purdue!" });
            }
        });

        io.to(socket.roomCode).emit('gameStarted');
        broadcastCounts(socket.roomCode);
        startNewRound(room);
    });

    function shuffleIfNecessary(room, needed) {
        if (room.deck.length < needed) {
            room.deck = [...room.deck, ...room.discardPile].sort(() => 0.5 - Math.random());
            room.discardPile = [];
            io.to(socket.roomCode).emit('reshuffleOccurred');
        }
        broadcastCounts(socket.roomCode);
    }

    function broadcastCounts(roomCode) {
        const room = rooms[roomCode];
        if (room) io.to(roomCode).emit('updateCounts', { deckCount: room.deck.length, discardCount: room.discardPile.length });
    }

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
        room.currentVP = room.players.find(p => p.name === vpName);
        io.to(socket.roomCode).emit('startVoting', { pres: room.currentPres.name, vp: room.currentVP.name });
    });

    socket.on('submitVote', (vote) => {
        const room = rooms[socket.roomCode];
        if (!room) return;
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
                    room.electionTracker = 0;
                    shuffleIfNecessary(room, 1);
                    applyPolicy(socket.roomCode, room.deck.shift(), true);
                } else {
                    startNewRound(room);
                }
            }
            io.to(socket.roomCode).emit('policyUpdated', { enactedPolicies: room.enactedPolicies, electionTracker: room.electionTracker, playerCount: room.players.length });
        }
    });

    socket.on('drawThree', () => {
        const room = rooms[socket.roomCode];
        shuffleIfNecessary(room, 3);
        const hand = room.deck.splice(0, 3);
        broadcastCounts(socket.roomCode);
        socket.emit('presDiscardPhase', hand);
    });

    socket.on('presDiscard', (data) => {
        const room = rooms[socket.roomCode];
        room.discardPile.push(data.discarded);
        broadcastCounts(socket.roomCode);
        io.to(room.currentVP.id).emit('vpEnactPhase', { cards: data.kept });
    });

    socket.on('vpEnact', (data) => {
        const room = rooms[socket.roomCode];
        room.discardPile.push(data.discarded);
        broadcastCounts(socket.roomCode);
        applyPolicy(socket.roomCode, data.enacted);
    });

    socket.on('requestVeto', () => {
        const room = rooms[socket.roomCode];
        io.to(room.currentPres.id).emit('vetoRequested');
    });

    socket.on('vetoResponse', (agreed) => {
        const room = rooms[socket.roomCode];
        if (agreed) {
            room.electionTracker++;
            startNewRound(room);
        } else {
            io.to(room.currentVP.id).emit('vetoDenied');
        }
    });

    function applyPolicy(roomCode, type, isForced = false) {
        const room = rooms[roomCode];
        type === "Tradition" ? room.enactedPolicies.tradition++ : room.enactedPolicies.construction++;
        
        if (!isForced) {
            room.lastPresident = room.currentPres.name; 
            room.lastVP = room.currentVP.name;
        }
        
        io.to(roomCode).emit('policyUpdated', { enactedPolicies: room.enactedPolicies, electionTracker: room.electionTracker, playerCount: room.players.length });
        
        if (room.enactedPolicies.tradition >= 5) return endGame(roomCode, "BOILERMAKERS WIN!");
        if (room.enactedPolicies.construction >= 6) return endGame(roomCode, "HOOSIERS WIN!");
        
        if (type === "Construction" && !isForced) {
            const count = room.enactedPolicies.construction;
            if ((count === 1 && room.players.length >= 9) || (count === 2 && room.players.length >= 7)) {
                io.to(room.currentPres.id).emit('triggerInvestigate');
            } else if (count === 3) {
                io.to(room.currentPres.id).emit('triggerPeek', room.deck.slice(0, 3));
            } else if (count === 4 || count === 5) {
                io.to(room.currentPres.id).emit('triggerExpel');
            } else startNewRound(room);
        } else startNewRound(room);
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

    function getPlayerListWithStatus(room) {
        return room.players.map(p => ({
            name: p.name, alive: p.alive,
            isPres: room.currentPres && p.id === room.currentPres.id,
            isLimit: (p.name === room.lastPresident || p.name === room.lastVP)
        }));
    }
});

server.listen(3000);