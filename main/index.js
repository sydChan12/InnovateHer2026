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
let presidentialIndex = 0;

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
        io.emit('updatePlayerList', getPlayerListWithStatus());
    });

    function getPlayerListWithStatus() {
        return players.map(p => ({
            name: p.name,
            isPres: currentPres && p.id === currentPres.id,
            isLimit: (p.name === lastPresident || p.name === lastVP)
        }));
    }

    socket.on('startGame', () => {
        if (players.length < 5) return socket.emit('errorMsg', "Need 5+ players.");
        gameActive = true;
        createDeck();
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
        currentPres = players[presidentialIndex];
        presidentialIndex = (presidentialIndex + 1) % players.length;
        currentVP = null;
        currentVotes = {};
        
        io.emit('gameStarted');
        io.emit('updatePlayerList', getPlayerListWithStatus());
        io.emit('newRound', { presidentName: currentPres.name, presidentId: currentPres.id });
    }

    socket.on('nominateVP', (vpName) => {
        if (socket.id !== currentPres.id) return;
        const nominee = players.find(p => p.name === vpName);
        if (!nominee || nominee.id === socket.id) return socket.emit('errorMsg', "Invalid nominee.");
        
        const isLimit = (nominee.name === lastPresident || nominee.name === lastVP);
        if (isLimit) return socket.emit('errorMsg', `${vpName} is term-limited!`);

        currentVP = nominee;
        io.emit('startVoting', { pres: currentPres.name, vp: nominee.name });
    });

    socket.on('submitVote', (vote) => {
        currentVotes[socket.id] = vote;
        if (Object.keys(currentVotes).length === players.length) {
            const yes = Object.values(currentVotes).filter(v => v === 'Boiler Up!').length;
            if (yes > (players.length / 2)) {
                electionTracker = 0;
                if (enactedPolicies.construction >= 3 && currentVP.role === "THE BISON 🦬") {
                    return io.emit('gameOver', "HOOSIERS WIN: The Bison was elected VP!");
                }
                io.to(currentPres.id).emit('presDrawPhase');
            } else {
                electionTracker++;
                if (electionTracker >= 3) {
                    const chaos = deck.shift();
                    chaos === "Tradition" ? enactedPolicies.tradition++ : enactedPolicies.construction++;
                    electionTracker = 0;
                    io.emit('policyUpdated', { enactedPolicies, electionTracker });
                }
                startNewRound();
            }
        }
    });

    socket.on('drawThree', () => {
        if (deck.length < 3) { deck = [...deck, ...discardPile].sort(() => 0.5 - Math.random()); discardPile = []; }
        const hand = deck.splice(0, 3);
        socket.emit('presDiscardPhase', hand);
    });

    socket.on('presDiscard', (remainingTwo) => {
        // Correctly passing the array of 2 to the VP
        io.to(currentVP.id).emit('vpEnactPhase', remainingTwo);
    });

    socket.on('vpEnact', (chosen) => {
        chosen === "Tradition" ? enactedPolicies.tradition++ : enactedPolicies.construction++;
        lastPresident = currentPres.name;
        lastVP = currentVP.name;
        io.emit('policyUpdated', { enactedPolicies, electionTracker: 0 });

        if (enactedPolicies.tradition >= 5) return io.emit('gameOver', "BOILERMAKERS WIN!");
        if (enactedPolicies.construction >= 6) return io.emit('gameOver', "HOOSIERS WIN!");
        startNewRound();
    });
});

server.listen(3000);