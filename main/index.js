const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Game State
let players = [];
let deck = [];
let discardPile = [];
let enactedPolicies = { tradition: 0, construction: 0 };
let electionTracker = 0;
let lastPresident = null;
let lastVP = null;
let currentPres = null;
let currentVP = null;
let currentVotes = {};
let gameActive = false;

// Per official rules: 6 Liberal (Tradition), 11 Fascist (Construction) [cite: 38, 51]
function createDeck() {
    deck = [...Array(6).fill("Tradition"), ...Array(11).fill("Construction")];
    deck.sort(() => 0.5 - Math.random());
    discardPile = [];
}

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

io.on('connection', (socket) => {
    // 1. Lobby: Join Game
    socket.on('joinGame', (name) => {
        if (gameActive) return socket.emit('errorMsg', "Game already in progress.");
        if (players.length >= 10) return socket.emit('errorMsg', "Lobby is full (Max 10).");
        
        players.push({ id: socket.id, name, role: 'Unassigned', party: 'Liberal' });
        io.emit('updatePlayerList', players.map(p => p.name));
    });

    // 2. Lobby: Start Game
    socket.on('startGame', () => {
        if (players.length < 5) return socket.emit('errorMsg', "Official rules require 5-10 players[cite: 56].");
        
        gameActive = true;
        createDeck();
        enactedPolicies = { tradition: 0, construction: 0 };
        electionTracker = 0;

        // Role Distribution [cite: 56]
        let shuffled = [...players].sort(() => 0.5 - Math.random());
        // For 5 players: 3 Liberals, 1 Fascist, 1 Hitler [cite: 56]
        players.forEach(p => {
            if (p.id === shuffled[0].id) { p.role = "THE BISON 🦬"; p.party = "Fascist"; }
            else if (p.id === shuffled[1].id) { p.role = "HOOSIER SPY 🚩"; p.party = "Fascist"; }
            else { p.role = "BOILERMAKER 🚂"; p.party = "Liberal"; }
            
            io.to(p.id).emit('assignRole', { role: p.role, party: p.party });
        });

        io.emit('gameStarted');
        io.emit('statusMsg', "Roles assigned. President, nominate your VP.");
    });

    // 3. Phase: Nomination [cite: 88]
    socket.on('nominateVP', (vpName) => {
        const nominee = players.find(p => p.name === vpName);
        const pres = players.find(p => p.id === socket.id);

        if (!nominee || nominee.id === socket.id) return socket.emit('errorMsg', "Invalid nominee.");
        
        // Term Limit Check 
        const isTermLimited = (nominee.name === lastVP) || (players.length > 5 && nominee.name === lastPresident);
        if (isTermLimited) return socket.emit('errorMsg', `${vpName} is term-limited!`);

        currentPres = pres;
        currentVP = nominee;
        currentVotes = {};
        io.emit('startVoting', { pres: pres.name, vp: nominee.name });
    });

    // 4. Phase: Voting [cite: 106]
    socket.on('submitVote', (vote) => {
        currentVotes[socket.id] = vote;
        if (Object.keys(currentVotes).length === players.length) {
            const yes = Object.values(currentVotes).filter(v => v === 'Boiler Up!').length;
            const no = players.length - yes;

            if (yes > no) {
                electionTracker = 0;
                // Win condition: Hitler (Bison) elected Chancellor (VP) after 3 Fascist policies 
                if (enactedPolicies.construction >= 3 && currentVP.role === "THE BISON 🦬") {
                    return io.emit('gameOver', "HOOSIERS WIN: The Bison was elected VP!");
                }
                io.emit('statusMsg', `Election Passed (${yes}-${no}). President, draw 3.`);
                io.to(currentPres.id).emit('presDrawPhase');
            } else {
                electionTracker++; // [cite: 110]
                io.emit('statusMsg', `Election Failed (${yes}-${no}). Tracker: ${electionTracker}/3`);
                
                // Chaos Rule [cite: 111, 112]
                if (electionTracker >= 3) {
                    const chaosPolicy = deck.shift();
                    chaosPolicy === "Tradition" ? enactedPolicies.tradition++ : enactedPolicies.construction++;
                    electionTracker = 0;
                    io.emit('policyUpdated', { enactedPolicies, electionTracker });
                    io.emit('statusMsg', `CHAOS! Top policy enacted: ${chaosPolicy}`);
                }
            }
        }
    });

    // 5. Phase: Legislative Session [cite: 123]
    socket.on('drawThree', () => {
        if (socket.id !== currentPres.id) return;
        if (deck.length < 3) {
            deck = [...deck, ...discardPile].sort(() => 0.5 - Math.random());
            discardPile = [];
        }
        const hand = deck.splice(0, 3); // President draws 3 [cite: 125]
        socket.emit('presDiscardPhase', hand);
    });

    socket.on('presDiscard', (remainingTwo) => {
        // President passes 2 to Chancellor (VP) [cite: 126]
        io.to(currentVP.id).emit('vpEnactPhase', remainingTwo);
    });

    socket.on('vpEnact', (chosen) => {
        chosen === "Tradition" ? enactedPolicies.tradition++ : enactedPolicies.construction++;
        lastPresident = currentPres.name;
        lastVP = currentVP.name;

        io.emit('policyUpdated', { enactedPolicies, electionTracker: 0 });
        
        // Final Win Conditions [cite: 30, 33]
        if (enactedPolicies.tradition >= 5) io.emit('gameOver', "BOILERMAKERS WIN!");
        if (enactedPolicies.construction >= 6) io.emit('gameOver', "HOOSIERS WIN!");
    });

    socket.on('disconnect', () => {
        players = players.filter(p => p.id !== socket.id);
        io.emit('updatePlayerList', players.map(p => p.name));
        if (players.length < 1) gameActive = false;
    });
});

server.listen(3000, () => console.log('Server running at http://localhost:3000'));