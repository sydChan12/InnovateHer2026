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
let vetoUnlocked = false;

function createDeck() {
    deck = [...Array(6).fill("Tradition"), ...Array(11).fill("Construction")];
    deck.sort(() => 0.5 - Math.random());
    discardPile = [];
}

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

io.on('connection', (socket) => {
    socket.on('joinGame', (name) => {
        if (gameActive) return socket.emit('errorMsg', "Game in progress.");
        players.push({ id: socket.id, name, role: 'Unassigned', party: 'Liberal', alive: true });
        io.emit('updatePlayerList', getPlayerListWithStatus());
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
        
        let shuffled = [...players].sort(() => 0.5 - Math.random());
        let bison = shuffled[0];
        bison.role = "THE BISON 🦬"; bison.party = "Fascist";

        // Logic for Spies/Bison knowledge based on player count
        if (count <= 6) {
            let spy = shuffled[1];
            spy.role = "HOOSIER SPY 🚩"; spy.party = "Fascist";
            // 5-6: Bison and Spy know each other
            io.to(bison.id).emit('assignRole', { role: bison.role, party: bison.party, info: `Spy is: ${spy.name}` });
            io.to(spy.id).emit('assignRole', { role: spy.role, party: spy.party, info: `Bison is: ${bison.name}` });
        } else {
            let spyCount = count <= 8 ? 2 : 3;
            let spies = shuffled.slice(1, 1 + spyCount);
            spies.forEach(s => { s.role = "HOOSIER SPY 🚩"; s.party = "Fascist"; });
            
            // 7-10: Spies know Bison, Bison knows nobody
            spies.forEach(s => {
                let otherSpies = spies.filter(other => other.id !== s.id).map(os => os.name);
                io.to(s.id).emit('assignRole', { role: s.role, party: s.party, info: `Bison: ${bison.name}. Spies: ${otherSpies.join(', ')}` });
            });
            io.to(bison.id).emit('assignRole', { role: bison.role, party: bison.party, info: "You do not know the spies." });
        }

        players.filter(p => p.role === 'Unassigned').forEach(p => {
            p.role = "BOILERMAKER 🚂"; p.party = "Liberal";
            io.to(p.id).emit('assignRole', { role: p.role, party: p.party, info: "Work with other Boilermakers." });
        });

        startNewRound();
    });

    function startNewRound() {
        // Find next living player for President
        do {
            currentPres = players[presidentialIndex];
            presidentialIndex = (presidentialIndex + 1) % players.length;
        } while (!currentPres.alive);

        currentVP = null; currentVotes = {};
        io.emit('gameStarted');
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
                // Bison Win Condition: Elected VP after 3rd Construction
                if (enactedPolicies.construction >= 3 && currentVP.role === "THE BISON 🦬") {
                    return io.emit('gameOver', "HOOSIERS WIN: The Bison was elected VP!");
                }
                io.to(currentPres.id).emit('presDrawPhase');
            } else {
                electionTracker++;
                if (electionTracker >= 3) {
                    const chaos = deck.shift();
                    applyPolicy(chaos);
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

    socket.on('vpVetoRequest', () => {
        io.emit('chatMessage', { user: "SYSTEM", msg: "VP requested a VETO. Waiting for President..." });
        io.to(currentPres.id).emit('presVetoDecision');
    });

    socket.on('presVetoConfirm', (agreed) => {
        if (agreed) {
            io.emit('chatMessage', { user: "SYSTEM", msg: "Veto accepted! Election Tracker increases." });
            electionTracker++;
            if (electionTracker >= 3) {
                const chaos = deck.shift();
                applyPolicy(chaos);
                electionTracker = 0;
            } else {
                startNewRound();
            }
        } else {
            io.emit('chatMessage', { user: "SYSTEM", msg: "President denied Veto. VP must enact a card." });
        }
    });

    socket.on('vpEnact', (chosen) => {
        applyPolicy(chosen);
    });

    function applyPolicy(type) {
        type === "Tradition" ? enactedPolicies.tradition++ : enactedPolicies.construction++;
        lastPresident = currentPres.name; lastVP = currentVP.name;
        io.emit('policyUpdated', { enactedPolicies, electionTracker, playerCount: players.length });
        
        if (enactedPolicies.tradition >= 5) return io.emit('gameOver', "BOILERMAKERS WIN!");
        if (enactedPolicies.construction >= 6) return io.emit('gameOver', "HOOSIERS WIN!");

        // Handle Presidential Powers
        if (type === "Construction") {
            handlePower(enactedPolicies.construction);
        } else {
            startNewRound();
        }
    }

    function handlePower(count) {
        const total = players.length;
        if (count === 1 && total >= 9) {
            socket.emit('triggerInvestigate');
        } else if (count === 2 && total >= 7) {
            socket.emit('triggerInvestigate');
        } else if (count === 3) {
            socket.emit('triggerPeek', deck.slice(0, 3));
        } else if (count === 4 || count === 5) {
            socket.emit('triggerExpel');
        } else {
            startNewRound();
        }
    }

    socket.on('powerInvestigate', (targetName) => {
        const target = players.find(p => p.name === targetName);
        socket.emit('investigateResult', { name: targetName, party: target.party });
        startNewRound();
    });

    socket.on('powerExpel', (targetName) => {
        const target = players.find(p => p.name === targetName);
        target.alive = false;
        io.emit('chatMessage', { user: "SYSTEM", msg: `${targetName} has been EXPELLED from Purdue.` });
        if (target.role === "THE BISON 🦬") return io.emit('gameOver', "BOILERMAKERS WIN: The Bison was expelled!");
        startNewRound();
    });

    socket.on('peekFinished', () => startNewRound());
});

server.listen(3000);