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

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

io.on('connection', (socket) => {
    socket.on('joinGame', (name) => {
        if (gameActive) return socket.emit('errorMsg', "Game in progress.");
        
        // Name duplicate check
        const nameExists = players.some(p => p.name.toLowerCase() === name.toLowerCase());
        if (nameExists) {
            return socket.emit('errorMsg', "That name is already taken. Pick another!");
        }

        players.push({ id: socket.id, name, role: 'Unassigned', party: 'Liberal', alive: true });
        io.emit('updatePlayerList', getPlayerListWithStatus());
        io.emit('chatMessage', { user: "SYSTEM", msg: `${name} has joined the lobby.` });
    });

    socket.on('sendChat', (msg) => {
        const p = players.find(p => p.id === socket.id);
        if (p) io.emit('chatMessage', { user: p.name, msg });
    });

    function getPlayerListWithStatus() {
        return players.map(p => ({
            name: p.name,
            alive: p.alive,
            isPres: currentPres && p.id === currentPres.id,
            isLimit: (p.name === lastPresident || p.name === lastVP)
        }));
    }

    socket.on('startGame', () => {
        const count = players.length;
        if (count < 5) return socket.emit('errorMsg', "Need 5+ players.");
        gameActive = true;
        createDeck();
        enactedPolicies = { tradition: 0, construction: 0 };
        electionTracker = 0;
        
        let shuffled = [...players].sort(() => 0.5 - Math.random());
        let bison = shuffled[0];
        bison.role = "THE BISON 🦬"; bison.party = "Fascist";

        if (count <= 6) {
            let spy = shuffled[1];
            spy.role = "HOOSIER SPY 🚩"; spy.party = "Fascist";
            io.to(bison.id).emit('assignRole', { role: bison.role, party: bison.party, info: `Spy is: ${spy.name}` });
            io.to(spy.id).emit('assignRole', { role: spy.role, party: spy.party, info: `Bison is: ${bison.name}` });
        } else {
            let spyCount = count <= 8 ? 2 : 3;
            let spies = shuffled.slice(1, 1 + spyCount);
            spies.forEach(s => { s.role = "HOOSIER SPY 🚩"; s.party = "Fascist"; });
            spies.forEach(s => {
                let otherSpies = spies.filter(other => other.id !== s.id).map(os => os.name);
                io.to(s.id).emit('assignRole', { role: s.role, party: s.party, info: `Bison: ${bison.name}. Spies: ${otherSpies.join(', ')}` });
            });
            io.to(bison.id).emit('assignRole', { role: bison.role, party: bison.party, info: "You do not know the spies." });
        }

        players.filter(p => p.role === 'Unassigned').forEach(p => {
            p.role = "BOILERMAKER 🚂"; p.party = "Liberal";
            io.to(p.id).emit('assignRole', { role: p.role, party: p.party, info: "Find the Spies!" });
        });

        io.emit('gameStarted');
        startNewRound();
    });

    function startNewRound() {
        do {
            currentPres = players[presidentialIndex];
            presidentialIndex = (presidentialIndex + 1) % players.length;
        } while (!currentPres.alive);

        currentVP = null; currentVotes = {};
        io.emit('updatePlayerList', getPlayerListWithStatus());
        io.emit('newRound', { presidentName: currentPres.name, presidentId: currentPres.id });
    }

    socket.on('nominateVP', (vpName) => {
        const nominee = players.find(p => p.name === vpName && p.alive);
        if (!nominee || nominee.id === currentPres.id) return socket.emit('errorMsg', "Invalid nominee.");
        if (nominee.name === lastPresident || nominee.name === lastVP) return socket.emit('errorMsg', "Term limited!");
        currentVP = nominee;
        io.emit('startVoting', { pres: currentPres.name, vp: nominee.name });
    });

    socket.on('submitVote', (vote) => {
        currentVotes[socket.id] = vote;
        const livingPlayers = players.filter(p => p.alive);
        if (Object.keys(currentVotes).length === livingPlayers.length) {
            const yes = Object.values(currentVotes).filter(v => v === 'Boiler Up!').length;
            if (yes > (livingPlayers.length / 2)) {
                electionTracker = 0;
                if (enactedPolicies.construction >= 3 && currentVP.role === "THE BISON 🦬") return io.emit('gameOver', "HOOSIERS WIN: Bison elected VP!");
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

    socket.on('vpVetoRequest', () => { io.to(currentPres.id).emit('presVetoDecision'); });

    socket.on('presVetoConfirm', (agreed) => {
        if (agreed) {
            electionTracker++;
            if (electionTracker >= 3) { applyPolicy(deck.shift()); electionTracker = 0; }
            else startNewRound();
        }
    });

    socket.on('vpEnact', (chosen) => { applyPolicy(chosen); });

    function applyPolicy(type) {
        type === "Tradition" ? enactedPolicies.tradition++ : enactedPolicies.construction++;
        lastPresident = currentPres.name; lastVP = currentVP.name;
        io.emit('policyUpdated', { enactedPolicies, electionTracker, playerCount: players.length });
        if (enactedPolicies.tradition >= 5) return io.emit('gameOver', "BOILERMAKERS WIN!");
        if (enactedPolicies.construction >= 6) return io.emit('gameOver', "HOOSIERS WIN!");
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
        target.alive = false;
        io.emit('chatMessage', { user: "SYSTEM", msg: `${name} was EXPELLED!` });
        if (target.role === "THE BISON 🦬") return io.emit('gameOver', "BOILERMAKERS WIN: Bison Expelled!");
        startNewRound();
    });

    socket.on('peekFinished', () => startNewRound());

    socket.on('disconnect', () => {
        const p = players.find(p => p.id === socket.id);
        if (p) {
            players = players.filter(pl => pl.id !== socket.id);
            if (gameActive) {
                gameActive = false;
                io.emit('resetToLobby', `${p.name} disconnected. Returning to lobby.`);
            }
            io.emit('updatePlayerList', getPlayerListWithStatus());
        }
    });
});

server.listen(3000);