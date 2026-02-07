const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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
let presidentialIndex = 0; // Tracks whose turn it is to be President

function createDeck() {
    deck = [...Array(6).fill("Tradition"), ...Array(11).fill("Construction")];
    deck.sort(() => 0.5 - Math.random());
    discardPile = [];
}

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

io.on('connection', (socket) => {
    socket.on('joinGame', (name) => {
        if (gameActive) return socket.emit('errorMsg', "Game in progress.");
        players.push({ id: socket.id, name, role: 'Unassigned', party: 'Liberal' });
        io.emit('updatePlayerList', players.map(p => p.name));
    });

    socket.on('startGame', () => {
        if (players.length < 5) return socket.emit('errorMsg', "Need 5+ players.");
        gameActive = true;
        createDeck();
        
        // Distribute Roles
        let shuffled = [...players].sort(() => 0.5 - Math.random());
        players.forEach(p => {
            if (p.id === shuffled[0].id) { p.role = "THE BISON 🦬"; p.party = "Fascist"; }
            else if (p.id === shuffled[1].id) { p.role = "HOOSIER SPY 🚩"; p.party = "Fascist"; }
            else { p.role = "BOILERMAKER 🚂"; p.party = "Liberal"; }
            io.to(p.id).emit('assignRole', { role: p.role, party: p.party });
        });

        startNewRound();
    });

    function startNewRound() {
        // Cycle the President placard clockwise 
        currentPres = players[presidentialIndex];
        presidentialIndex = (presidentialIndex + 1) % players.length;

        io.emit('gameStarted');
        io.emit('newRound', { 
            presidentName: currentPres.name, 
            presidentId: currentPres.id 
        });
        io.emit('statusMsg', `Round started. President: ${currentPres.name}`);
    }

    socket.on('nominateVP', (vpName) => {
        if (socket.id !== currentPres.id) return; // Only President can nominate 

        const nominee = players.find(p => p.name === vpName);
        if (!nominee || nominee.id === socket.id) return socket.emit('errorMsg', "Invalid nominee.");
        
        // Enforce Term Limits [cite: 92, 99]
        const isTermLimited = (nominee.name === lastVP) || (players.length > 5 && nominee.name === lastPresident);
        if (isTermLimited) return socket.emit('errorMsg', `${vpName} is term-limited!`);

        currentVP = nominee;
        currentVotes = {};
        io.emit('startVoting', { pres: currentPres.name, vp: nominee.name });
    });

    socket.on('submitVote', (vote) => {
        currentVotes[socket.id] = vote;
        if (Object.keys(currentVotes).length === players.length) {
            const yes = Object.values(currentVotes).filter(v => v === 'Boiler Up!').length;
            const no = players.length - yes;

            if (yes > no) { // Election passes [cite: 117]
                electionTracker = 0;
                // Win Condition: Bison elected VP after 3 construction policies [cite: 34, 120]
                if (enactedPolicies.construction >= 3 && currentVP.role === "THE BISON 🦬") {
                    return io.emit('gameOver', "HOOSIERS WIN: The Bison was elected VP!");
                }
                io.to(currentPres.id).emit('presDrawPhase');
            } else { // Election fails [cite: 108, 109, 110]
                electionTracker++;
                if (electionTracker >= 3) { // Chaos rule [cite: 111, 112]
                    const chaosPolicy = deck.shift();
                    chaosPolicy === "Tradition" ? enactedPolicies.tradition++ : enactedPolicies.construction++;
                    electionTracker = 0;
                    io.emit('policyUpdated', { enactedPolicies, electionTracker });
                }
                startNewRound(); // Next person becomes President [cite: 109]
            }
        }
    });

    socket.on('drawThree', () => {
        if (socket.id !== currentPres.id) return; // Only President can draw
        const hand = [deck.shift(), deck.shift(), deck.shift()];
        io.to(currentPres.id).emit('presDiscardPhase', hand);
    });

    socket.on('presDiscard', (remaining) => {
        if (socket.id !== currentPres.id) return; // Only President can discard
        discardPile.push(...remaining.splice(1)); // Discard 2, keep 1 for VP
        const vpHand = remaining;
        io.to(currentVP.id).emit('vpEnactPhase', vpHand);
    });

    socket.on('vpEnact', (chosen) => {
        chosen === "Tradition" ? enactedPolicies.tradition++ : enactedPolicies.construction++;
        lastPresident = currentPres.name; // Record last elected officials [cite: 96]
        lastVP = currentVP.name;

        io.emit('policyUpdated', { enactedPolicies, electionTracker: 0 });
        
        if (enactedPolicies.tradition >= 5) return io.emit('gameOver', "BOILERMAKERS WIN!");
        if (enactedPolicies.construction >= 6) return io.emit('gameOver', "HOOSIERS WIN!");
        
        startNewRound(); // Proceed to next round [cite: 142]
    });
});

server.listen(3000);