const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let players = [];
let deck = [];
let enactedPolicies = { tradition: [], construction: [] };
let lastPresident = null;
let lastVP = null;
let currentPres = null;
let currentVP = null;

function createDeck() {
    // 6 Tradition (Boilermaker), 11 Construction (Hoosier) [cite: 38, 51]
    deck = [...Array(6).fill("Tradition"), ...Array(11).fill("Construction")];
    deck.sort(() => 0.5 - Math.random());
}

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

io.on('connection', (socket) => {
    socket.on('joinGame', (name) => {
        players.push({ id: socket.id, name: name, role: 'Unassigned', party: 'Liberal' });
        io.emit('updatePlayerList', players);
    });

    socket.on('startGame', () => {
        if (players.length < 5) {
            socket.emit('errorMsg', "Need at least 5 Boilermakers to start!"); [cite, 56]
            return;
        }
        createDeck();
        enactedPolicies = { tradition: [], construction: [] };
        
        let shuffled = [...players].sort(() => 0.5 - Math.random());
        // Assignment based on player counts [cite: 56]
        const bison = shuffled[0];
        const spy = shuffled[1];

        players.forEach(p => {
            if (p.id === bison.id) {
                p.role = "THE BISON 🦬";
                p.party = "Hoosier";
            } else if (p.id === spy.id) {
                p.role = "HOOSIER SPY 🚩";
                p.party = "Hoosier";
            } else {
                p.role = "BOILERMAKER 🚂";
                p.party = "Boilermaker";
            }
            io.to(p.id).emit('assignRole', p.role);
        });
        io.emit('gameStarted');
    });

    // Handle VP Nomination [cite: 88, 89]
    socket.on('nominateVP', (vpName) => {
        const nominee = players.find(p => p.name.toLowerCase() === vpName.toLowerCase());
        const president = players.find(p => p.id === socket.id);

        if (!nominee) return socket.emit('errorMsg', "Student not found!");
        
        // Term Limit Check [cite: 91, 92, 99]
        if (nominee.name === lastVP || (players.length > 5 && nominee.name === lastPresident)) {
            return socket.emit('errorMsg', nominee.name + " is term-limited!");
        }

        currentPres = president;
        currentVP = nominee;
        io.emit('showVote', { president: president.name, vp: nominee.name });
    });

    socket.on('submitVote', (voteData) => {
        io.emit('voteResult', voteData);
        // Note: In a full build, you'd tally these to trigger the Legislative Session
    });

    // Legislative Session: Drawing 3 Policies [cite: 125]
    socket.on('drawPolicies', () => {
        if (socket.id !== currentPres.id) return;
        
        // Check for Bison Win Condition before drawing 
        if (enactedPolicies.construction.length >= 3 && currentVP.role === "THE BISON 🦬") {
            io.emit('statusMsg', "GAME OVER: The Bison was elected VP! Hoosiers Win!");
            return;
        }

        if (deck.length < 3) createDeck();
        const hand = deck.splice(0, 3);
        socket.emit('presidentHand', hand);
    });

    // President discards 1, passes 2 to VP [cite: 125, 126]
    socket.on('presidentDiscard', (remainingTwo) => {
        io.to(currentVP.id).emit('vpHand', remainingTwo);
    });

    // VP enacts final policy [cite: 126]
    socket.on('enactPolicy', (policy) => {
        const policyObj = { type: policy, pres: currentPres.name, vp: currentVP.name };
        
        if (policy === "Tradition") enactedPolicies.tradition.push(policyObj);
        else enactedPolicies.construction.push(policyObj);
        
        // Update Term Limits [cite: 96]
        lastPresident = currentPres.name;
        lastVP = currentVP.name;

        io.emit('policyUpdated', enactedPolicies);
        
        // Check Win Conditions [cite: 23, 24]
        if (enactedPolicies.tradition.length >= 5) {
            io.emit('statusMsg', "Boilermakers win! Traditions preserved!");
        } else if (enactedPolicies.construction.length >= 6) {
            io.emit('statusMsg', "Hoosiers win! Campus is under construction!");
        } else {
            io.emit('statusMsg', `${policy} policy enacted.`);
        }
    });

    socket.on('disconnect', () => {
        players = players.filter(p => p.id !== socket.id);
        io.emit('updatePlayerList', players);
    });
});

server.listen(3000, () => {
    console.log('Server running at http://localhost:3000');
});