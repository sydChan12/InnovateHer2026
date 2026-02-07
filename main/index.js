const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Centralized Game State
let players = [];
let deck = [];
let discardPile = [];
let enactedPolicies = { tradition: 0, construction: 0 };
let electionTracker = 0;
let lastPresident = null, lastVP = null;
let currentPres = null, currentVP = null;
let currentVotes = {};
let gameActive = false;
let presidentialIndex = 0;

function createDeck() {
    deck = [...Array(6).fill("Tradition"), ...Array(11).fill("Construction")];
    deck.sort(() => 0.5 - Math.random());
    discardPile = [];
}

function resetServerState() {
    gameActive = false;
    enactedPolicies = { tradition: 0, construction: 0 };
    electionTracker = 0;
    lastPresident = null;
    lastVP = null;
    currentPres = null;
    currentVP = null;
    currentVotes = {};
    presidentialIndex = 0;
}

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

io.on('connection', (socket) => {
    // 1. FIXED JOIN LOGIC
    socket.on('joinGame', (name) => {
        const cleanName = name.trim();
        if (!cleanName) return socket.emit('errorMsg', "Please enter a name.");
        
        if (gameActive) {
            return socket.emit('errorMsg', "Game is already in progress. Please wait for it to end.");
        }
        
        const nameExists = players.some(p => p.name.toLowerCase() === cleanName.toLowerCase());
        if (nameExists) {
            return socket.emit('errorMsg', "That name is already taken. Pick another!");
        }

        players.push({ id: socket.id, name: cleanName, role: 'Unassigned', party: 'Liberal', alive: true });
        
        // Ensure the joining player sees the lobby
        socket.emit('joinedSuccessfully');
        io.emit('updatePlayerList', getPlayerListWithStatus());
        io.emit('chatMessage', { user: "SYSTEM", msg: `${cleanName} has joined.` });
    });

    function getPlayerListWithStatus() {
        return players.map(p => ({
            name: p.name,
            alive: p.alive,
            isPres: currentPres && p.id === currentPres.id,
            isLimit: (p.name === lastPresident || p.name === lastVP)
        }));
    }

    // 2. START GAME LOGIC
    socket.on('startGame', () => {
        if (players.length < 5) return socket.emit('errorMsg', "Need at least 5 players to start.");
        if (gameActive) return;

        gameActive = true;
        createDeck();
        
        let shuffled = [...players].sort(() => 0.5 - Math.random());
        let bison = shuffled[0];
        bison.role = "THE BISON 🦬"; bison.party = "Fascist";

        const count = players.length;
        if (count <= 6) {
            let spy = shuffled[1];
            spy.role = "HOOSIER SPY 🚩"; spy.party = "Fascist";
            io.to(bison.id).emit('assignRole', { role: bison.role, party: bison.party, info: `Spy: ${spy.name}` });
            io.to(spy.id).emit('assignRole', { role: spy.role, party: spy.party, info: `Bison: ${bison.name}` });
        } else {
            let spyCount = count <= 8 ? 2 : 3;
            let spies = shuffled.slice(1, 1 + spyCount);
            spies.forEach(s => { s.role = "HOOSIER SPY 🚩"; s.party = "Fascist"; });
            spies.forEach(s => {
                let otherNames = spies.filter(o => o.id !== s.id).map(o => o.name);
                io.to(s.id).emit('assignRole', { role: s.role, party: s.party, info: `Bison: ${bison.name}. Spies: ${otherNames.join(', ')}` });
            });
            io.to(bison.id).emit('assignRole', { role: bison.role, party: bison.party, info: "You do not know the spies." });
        }

        players.filter(p => p.role === 'Unassigned').forEach(p => {
            p.role = "BOILERMAKER 🚂"; p.party = "Liberal";
            io.to(p.id).emit('assignRole', { role: p.role, party: p.party, info: "Stop the Bison!" });
        });

        io.emit('gameStarted');
        startNewRound();
    });

    function startNewRound() {
        if (!gameActive) return;
        let attempts = 0;
        do {
            currentPres = players[presidentialIndex];
            presidentialIndex = (presidentialIndex + 1) % players.length;
            attempts++;
        } while (!currentPres.alive && attempts < players.length);

        currentVP = null;
        currentVotes = {};
        io.emit('updatePlayerList', getPlayerListWithStatus());
        io.emit('newRound', { presidentName: currentPres.name, presidentId: currentPres.id });
    }

    socket.on('nominateVP', (vpName) => {
        const nominee = players.find(p => p.name === vpName && p.alive);
        if (!nominee) return;
        currentVP = nominee;
        io.emit('startVoting', { pres: currentPres.name, vp: nominee.name });
    });

    socket.on('submitVote', (vote) => {
        currentVotes[socket.id] = vote;
        const living = players.filter(p => p.alive);
        if (Object.keys(currentVotes).length === living.length) {
            const yes = Object.values(currentVotes).filter(v => v === 'Boiler Up!').length;
            if (yes > (living.length / 2)) {
                electionTracker = 0;
                if (enactedPolicies.construction >= 3 && currentVP.role === "THE BISON 🦬") {
                    return endGame("HOOSIERS WIN: The Bison was elected VP!");
                }
                io.to(currentPres.id).emit('presDrawPhase');
            } else {
                electionTracker++;
                if (electionTracker >= 3) {
                    applyPolicy(deck.shift());
                    electionTracker = 0;
                } else {
                    startNewRound();
                }
            }
        }
    });

    socket.on('drawThree', () => {
        if (deck.length < 3) { deck = [...deck, ...discardPile].sort(() => 0.5 - Math.random()); discardPile = []; }
        socket.emit('presDiscardPhase', deck.splice(0, 3));
    });

    socket.on('presDiscard', (rem) => {
        io.to(currentVP.id).emit('vpEnactPhase', { cards: rem, canVeto: enactedPolicies.construction >= 5 });
    });

    socket.on('vpEnact', (chosen) => { applyPolicy(chosen); });

    function applyPolicy(type) {
        if (!type) { createDeck(); type = deck.shift(); }
        type === "Tradition" ? enactedPolicies.tradition++ : enactedPolicies.construction++;
        lastPresident = currentPres.name; lastVP = currentVP.name;
        
        io.emit('policyUpdated', { enactedPolicies, electionTracker, playerCount: players.length });
        
        if (enactedPolicies.tradition >= 5) return endGame("BOILERMAKERS WIN: Tradition preserved!");
        if (enactedPolicies.construction >= 6) return endGame("HOOSIERS WIN: Construction completed!");
        
        if (type === "Construction") handlePower(enactedPolicies.construction);
        else startNewRound();
    }

    function handlePower(count) {
        const total = players.length;
        if ((count === 1 && total >= 9) || (count === 2 && total >= 7)) io.to(currentPres.id).emit('triggerInvestigate');
        else if (count === 3) io.to(currentPres.id).emit('triggerPeek', deck.slice(0, 3));
        else if (count === 4 || count === 5) io.to(currentPres.id).emit('triggerExpel');
        else startNewRound();
    }

    socket.on('powerInvestigate', (name) => {
        const target = players.find(p => p.name === name);
        socket.emit('investigateResult', { name, party: target.party });
        startNewRound();
    });

    socket.on('powerExpel', (name) => {
        const target = players.find(p => p.name === name);
        if (target) {
            target.alive = false;
            io.emit('chatMessage', { user: "SYSTEM", msg: `${name} was EXPELLED!` });
            if (target.role === "THE BISON 🦬") return endGame("BOILERMAKERS WIN: Bison Expelled!");
        }
        startNewRound();
    });

    function endGame(msg) {
        io.emit('gameOver', msg);
        resetServerState();
    }

    socket.on('sendChat', (msg) => {
        const p = players.find(p => p.id === socket.id);
        if (p) io.emit('chatMessage', { user: p.name, msg });
    });

    // 3. ROBUST DISCONNECT LOGIC
    socket.on('disconnect', () => {
        const pIndex = players.findIndex(p => p.id === socket.id);
        if (pIndex !== -1) {
            const leaver = players[pIndex];
            players.splice(pIndex, 1);
            
            if (gameActive) {
                resetServerState();
                io.emit('resetToLobby', `${leaver.name} left. Game terminated.`);
            }
            io.emit('updatePlayerList', getPlayerListWithStatus());
        }
        if (players.length === 0) resetServerState();
    });
});

server.listen(3000, () => console.log("Server running on port 3000"));