const express = require('express');
app.use(express.static(__dirname));
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
        room.discardPile = [];
        
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
            io.to(bison.id).emit('assignRole', { role: bison.role, info: "You are the Bison. You don't know the spies." });
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
            io.to(socket.roomCode).emit('chatMessage', { user: "SYSTEM", msg: "Deck empty. Reshuffling discards..." });
        }
        broadcastCounts(socket.roomCode);
    }

    function broadcastCounts(roomCode) {
        const room = rooms[roomCode];
        if (room) {
            io.to(roomCode).emit('updateCounts', {
                deckCount: room.deck.length,
                discardCount: room.discardPile.length
            });
        }
    }

    function startNewRound(room) {
        if (!room.gameActive) return;
        let attempts = 0;
        let foundEligible = false;
        const roomCode = Object.keys(rooms).find(code => rooms[code] === room); 
        while (attempts < room.players.length) {
            room.currentPres = room.players[room.presidentialIndex];
            room.presidentialIndex = (room.presidentialIndex + 1) % room.players.length;
            if (room.currentPres.alive && !room.currentPres.expelled) {
                foundEligible = true;
                break;
            } else {
                console.log(`Skipping ${room.currentPres.name} (Expelled)`);
                if (roomCode) {
                    io.to(roomCode).emit('chatMessage', { 
                        user: "STUDENT COUNCIL",
                        msg: `${room.currentPres.name} is expelled and cannot be President.`,
                        color: '#888'
                    });
                }
            }
            attempts++;
        }   
        if (!foundEligible) {
            return endGame(roomCode, "No eligible Presidents left. Game ended.");
        }
        
        room.currentVP = null;
        room.currentVotes = {};
        if (roomCode) {
            io.to(roomCode).emit('updatePlayerList', getPlayerListWithStatus(room));
            io.to(roomCode).emit('newRound', { presidentName: room.currentPres.name, presidentId: room.currentPres.id });
        }
    }

    socket.on('nominateVP', (vpName) => {
        const room = rooms[socket.roomCode];
        if (!room || !room.currentPres || socket.id !== room.currentPres.id) return;

        const target = room.players.find(p => p.name === vpName);
        if (target && target.alive) {
            room.currentVP = target;
            io.to(socket.roomCode).emit('startVoting', { pres: room.currentPres.name, vp: room.currentVP.name });
        }
    });

    socket.on('submitVote', (vote) => {
        const room = rooms[socket.roomCode];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.alive || player.expelled) {
            return socket.emit('errorMsg', "You cannot vote.");
        }
        room.currentVotes[socket.id] = { name: player.name, choice: vote };
        const living = room.players.filter(p => p.alive && !p.expelled);

        if (Object.keys(room.currentVotes).length === living.length) {
            // Log results with color
            Object.values(room.currentVotes).forEach(v => {
                const color = v.choice === 'Boiler Up!' ? '#00FF00' : '#FF0000';
                io.to(socket.roomCode).emit('chatMessage', { user: "VOTE", msg: `${v.name}: ${v.choice}`, color: color });
            });

            const yes = Object.values(room.currentVotes).filter(v => v.choice === 'Boiler Up!').length;
            
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
                    const forced = room.deck.shift();
                    io.to(socket.roomCode).emit('chatMessage', { user: "STUDENT COUNCIL", msg: `Elections failed 3x! Forced policy: ${forced}` });
                    applyPolicy(socket.roomCode, forced, true);
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

    function applyPolicy(roomCode, type, isForced = false) {
        const room = rooms[roomCode];
        type === "Tradition" ? room.enactedPolicies.tradition++ : room.enactedPolicies.construction++;
        
        if (!isForced) {
            room.lastPresident = room.currentPres.name; 
            room.lastVP = room.currentVP ? room.currentVP.name : null;
        } else {
            room.lastPresident = null; room.lastVP = null;
        }
        
        io.to(roomCode).emit('policyUpdated', { enactedPolicies: room.enactedPolicies, electionTracker: room.electionTracker, playerCount: room.players.length });
        broadcastCounts(roomCode);
        
        if (room.enactedPolicies.tradition >= 5) return endGame(roomCode, "BOILERMAKERS WIN!");
        if (room.enactedPolicies.construction >= 6) return endGame(roomCode, "HOOSIERS WIN!");
        
        if (type === "Construction" && !isForced) handlePower(roomCode, room.enactedPolicies.construction);
        else startNewRound(room);
    }

    function handlePower(roomCode, count) {
        const room = rooms[roomCode];
        if ((count === 1 && room.players.length >= 9) || (count === 2 && room.players.length >= 7)) {
            io.to(room.currentPres.id).emit('triggerInvestigate');
        } else if (count === 3) {
            broadcastCounts(roomCode);
            io.to(room.currentPres.id).emit('triggerPeek', room.deck.slice(0, 3));
        } else if (count === 4 || count === 5) {
            io.to(room.currentPres.id).emit('triggerExpel');
        } else startNewRound(room);
    }

    socket.on('powerInvestigate', (name) => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        const target = room.players.find(p => p.name === name);
        if (!target) return;
        socket.emit('investigateResult', { name, party: target.party });
        io.to(socket.roomCode).emit('chatMessage', {
            user: "GOVERNMENT",
            msg: `${room.currentPres.name} investigated ${target.name}'s records.`,
            color: 'var(--p-gold)'
        });
    });

    socket.on('powerExpel', (name) => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        const target = room.players.find(p => p.name === name);
        if (!target) return;

        target.expelled = true;
        io.to(socket.roomCode).emit('expelAnimation', { 
            name: target.name, 
            isBison: target.role === "THE BISON 🦬" 
        });

        if (target.role === "THE BISON 🦬") {
            setTimeout(() => endGame(socket.roomCode, "BOILERMAKERS WIN! (Bison was expelled)"), 4000);
        }
    });

    socket.on('resumeAfterExpel', () => {
        const room = rooms[socket.roomCode];
        if (room && socket.id === room.currentPres.id) {
            io.to(socket.roomCode).emit('closeOverlay');
            startNewRound(room);
        }
    });

    socket.on('peekFinished', () => {
    const room = rooms[socket.roomCode];
    if (room) {
        startNewRound(room);
    }
    });

    socket.on('sendChat', (msg) => {
        const room = rooms[socket.roomCode];
        const p = room?.players.find(p => p.id === socket.id);
        if (p && !p.expelled) io.to(socket.roomCode).emit('chatMessage', { user: p.name, msg });
        
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
            id: p.id,
            alive: p.alive,
            expelled: p.expelled || false,
            isPres: room.currentPres && p.id === room.currentPres.id,
            isLimit: (p.name === room.lastPresident || p.name === room.lastVP || p.expelled)
        }));
    }
});


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on ${PORT}`));