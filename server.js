const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const cors = require('cors');
const path = require('path');

// ==========================================
// 1. INITIALISATION & CONFIGURATION
// ==========================================
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ==========================================
// 2. STATE MANAGEMENT & BASE DE DONNÉES IN-MEMORY
// ==========================================
const generateSeed = () => crypto.randomBytes(32).toString('hex');

// Base de données simulée pour les utilisateurs
const users = {
    'player_1': {
        id: 'player_1',
        balance: 10000.00,
        debt: 0.00,
        creditScore: 650, // 300 to 850
        serverSeed: generateSeed(),
        clientSeed: 'goldrush_init',
        nonce: 0,
        // Etat Penalty Game
        penaltyActive: false,
        penaltyBet: 0,
        penaltyStreak: 0
    }
};

const PENALTY_MULTIPLIERS = [1.95, 3.80, 7.50, 15.00, 30.00, 60.00];

// Etat Gold Rocket (Crash Game)
let rocketState = {
    status: 'WAITING', // WAITING, IN_PROGRESS, CRASHED
    multiplier: 1.00,
    crashPoint: 1.00,
    startTime: 0,
    countdown: 5,
    activeBets: {}, // { userId: { bet: 100, cashedOut: false, winAmount: 0 } }
    serverSeed: generateSeed(),
    clientSeed: 'rocket_public_seed',
    nonce: 0
};

// ==========================================
// 3. MOTEUR MATHÉMATIQUE & PROVABLY FAIR
// ==========================================

// Convertit le hash HMAC-SHA256 en un float uniforme [0, 1)
function getProvablyFairFloat(serverSeed, clientSeed, nonce) {
    const hash = crypto.createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}`).digest('hex');
    // On prend les 52 premiers bits (13 caractères hex) pour une distribution parfaite
    const h = parseInt(hash.slice(0, 13), 16);
    const e = Math.pow(2, 52);
    return h / e;
}

// Calcule le point de crash (House Edge ~1%)
function generateCrashPoint() {
    rocketState.nonce++;
    const float = getProvablyFairFloat(rocketState.serverSeed, rocketState.clientSeed, rocketState.nonce);
    
    // 1% de chance de crash instantané à 1.00x
    if (float <= 0.01) return 1.00;
    
    // Formule inverse avec 1% d'avantage maison
    const crash = Math.floor(100 * (1 - 0.01) / (1 - float)) / 100;
    return Math.max(1.00, crash);
}

// Calcule la position du gardien (0 à 5)
function generateGoaliePosition(userId) {
    const user = users[userId];
    user.nonce++;
    const float = getProvablyFairFloat(user.serverSeed, user.clientSeed, user.nonce);
    return Math.floor(float * 6);
}

// ==========================================
// 4. SYSTÈME BANCAIRE & CREDIT SCORING
// ==========================================

function getInterestRate(creditScore) {
    // Taux de 15% (300 pts) à 5% (850 pts)
    return 15 - ((creditScore - 300) / 550) * 10;
}

function checkMarginCall(userId) {
    const user = users[userId];
    const netWorth = user.balance - user.debt;
    
    // Liquidation si la valeur nette est négative ou si le solde ne couvre plus les intérêts
    if (user.debt > 0 && netWorth <= (user.debt * 0.05)) {
        user.balance = 0;
        user.debt = 0;
        user.creditScore = Math.max(300, user.creditScore - 100);
        
        io.to(userId).emit('margin_call', {
            message: "LIQUIDATION FLASH ! Seuil de marge franchi.",
            creditScore: user.creditScore
        });
        return true;
    }
    return false;
}

// Endpoints Bancaires
app.post('/api/bank/borrow', (req, res) => {
    const { userId, amount } = req.body;
    const user = users[userId];
    if (!user) return res.status(404).json({ error: "Utilisateur inconnu" });
    
    const maxBorrow = (user.creditScore - 300) * 10; // ex: 650 = 3500 max
    if (user.debt + amount > maxBorrow) {
        return res.status(400).json({ error: `Emprunt refusé. Limite actuelle : $${maxBorrow - user.debt}` });
    }

    const rate = getInterestRate(user.creditScore);
    const fee = amount * (rate / 100);
    
    user.debt += (amount + fee);
    user.balance += amount;
    
    res.json({ balance: user.balance, debt: user.debt, creditScore: user.creditScore });
});

app.post('/api/bank/repay', (req, res) => {
    const { userId, amount } = req.body;
    const user = users[userId];
    if (!user) return res.status(404).json({ error: "Utilisateur inconnu" });
    
    if (user.balance < amount) return res.status(400).json({ error: "Fonds insuffisants" });
    if (amount > user.debt) return res.status(400).json({ error: "Remboursement supérieur à la dette" });

    user.balance -= amount;
    user.debt -= amount;
    
    // Amélioration du credit score suite au remboursement
    if (user.debt === 0 && user.creditScore < 850) {
        user.creditScore = Math.min(850, user.creditScore + 15);
    }
    
    res.json({ balance: user.balance, debt: user.debt, creditScore: user.creditScore });
});

// ==========================================
// 5. JEU 1 : PENALTY GOLD STRIKE (REST API)
// ==========================================

app.post('/api/penalty/start', (req, res) => {
    const { userId, bet } = req.body;
    const user = users[userId];
    
    if (!user || user.balance < bet || bet <= 0) return res.status(400).json({ error: "Mise invalide ou fonds insuffisants" });
    if (user.penaltyActive) return res.status(400).json({ error: "Partie déjà en cours" });

    user.balance -= bet;
    user.penaltyActive = true;
    user.penaltyBet = bet;
    user.penaltyStreak = 0;
    
    checkMarginCall(userId);
    res.json({ balance: user.balance, streak: user.penaltyStreak });
});

app.post('/api/penalty/shoot', (req, res) => {
    const { userId, targetZone } = req.body; // targetZone: 0 to 5
    const user = users[userId];
    
    if (!user || !user.penaltyActive) return res.status(400).json({ error: "Aucune partie active" });
    if (targetZone < 0 || targetZone > 5) return res.status(400).json({ error: "Zone invalide" });

    const goalieZone = generateGoaliePosition(userId);
    const isWin = (targetZone !== goalieZone);

    if (!isWin) {
        // PERDU
        user.penaltyActive = false;
        checkMarginCall(userId);
        return res.json({ 
            status: 'LOST', 
            goalieZone, 
            balance: user.balance,
            provablyFair: { nonce: user.nonce }
        });
    }

    // GAGNÉ
    user.penaltyStreak++;
    const currentMultiplier = PENALTY_MULTIPLIERS[user.penaltyStreak - 1];
    const potentialWin = user.penaltyBet * currentMultiplier;

    if (user.penaltyStreak === PENALTY_MULTIPLIERS.length) {
        // Auto-cashout sur victoire finale
        user.balance += potentialWin;
        user.penaltyActive = false;
        return res.json({
            status: 'MAX_WIN',
            goalieZone,
            multiplier: currentMultiplier,
            winAmount: potentialWin,
            balance: user.balance
        });
    }

    res.json({
        status: 'WIN',
        goalieZone,
        streak: user.penaltyStreak,
        currentMultiplier,
        potentialWin
    });
});

app.post('/api/penalty/cashout', (req, res) => {
    const { userId } = req.body;
    const user = users[userId];
    
    if (!user || !user.penaltyActive || user.penaltyStreak === 0) {
        return res.status(400).json({ error: "Cashout impossible" });
    }

    const currentMultiplier = PENALTY_MULTIPLIERS[user.penaltyStreak - 1];
    const winAmount = user.penaltyBet * currentMultiplier;
    
    user.balance += winAmount;
    user.penaltyActive = false;
    
    res.json({ balance: user.balance, winAmount });
});

// ==========================================
// 6. JEU 2 : GOLD ROCKET (WEBSOCKETS)
// ==========================================

function startRocketLoop() {
    setInterval(() => {
        if (rocketState.status === 'WAITING') {
            rocketState.countdown -= 0.1;
            io.emit('rocket_waiting', { countdown: rocketState.countdown.toFixed(1) });
            
            if (rocketState.countdown <= 0) {
                rocketState.status = 'IN_PROGRESS';
                rocketState.crashPoint = generateCrashPoint();
                rocketState.startTime = Date.now();
                rocketState.multiplier = 1.00;
                io.emit('rocket_start', { status: rocketState.status });
            }
        } 
        else if (rocketState.status === 'IN_PROGRESS') {
            const elapsed = Date.now() - rocketState.startTime;
            // Courbe exponentielle classique : e^(0.06 * seconds)
            rocketState.multiplier = Math.max(1.00, Math.exp(0.00006 * elapsed));
            
            if (rocketState.multiplier >= rocketState.crashPoint) {
                // BOOM !
                rocketState.status = 'CRASHED';
                rocketState.multiplier = rocketState.crashPoint;
                
                // Vérifier les liquidations pour les perdants
                for (const uid in rocketState.activeBets) {
                    if (!rocketState.activeBets[uid].cashedOut) {
                        checkMarginCall(uid);
                    }
                }

                io.emit('rocket_crash', { 
                    crashPoint: rocketState.crashPoint.toFixed(2),
                    nonce: rocketState.nonce
                });

                // Reset après 4 secondes
                setTimeout(() => {
                    rocketState.status = 'WAITING';
                    rocketState.countdown = 5;
                    rocketState.activeBets = {};
                }, 4000);
            } else {
                // Update 20 FPS (every 50ms)
                io.emit('rocket_tick', { multiplier: rocketState.multiplier.toFixed(2) });
            }
        }
    }, 50); // Moteur 20 ticks/seconde
}

io.on('connection', (socket) => {
    // Par défaut, on lie la socket au 'player_1'
    const userId = 'player_1';
    socket.join(userId);
    
    socket.emit('user_sync', users[userId]);
    socket.emit('rocket_sync', { status: rocketState.status, multiplier: rocketState.multiplier });

    // Placement Pari Rocket
    socket.on('rocket_bet', (betAmount) => {
        const user = users[userId];
        if (rocketState.status !== 'WAITING') return socket.emit('rocket_error', "Partie déjà en cours");
        if (user.balance < betAmount || betAmount <= 0) return socket.emit('rocket_error', "Fonds insuffisants");
        
        user.balance -= betAmount;
        rocketState.activeBets[userId] = { bet: betAmount, cashedOut: false, winAmount: 0 };
        
        socket.emit('user_sync', user);
        io.emit('rocket_players_update', rocketState.activeBets);
    });

    // Cashout Rocket
    socket.on('rocket_cashout', () => {
        if (rocketState.status !== 'IN_PROGRESS') return;
        
        const betData = rocketState.activeBets[userId];
        if (!betData || betData.cashedOut) return;

        const currentMult = rocketState.multiplier;
        const winAmount = betData.bet * currentMult;
        
        betData.cashedOut = true;
        betData.winAmount = winAmount;
        
        const user = users[userId];
        user.balance += winAmount;
        
        socket.emit('rocket_cashout_success', { winAmount, multiplier: currentMult });
        socket.emit('user_sync', user);
        io.emit('rocket_players_update', rocketState.activeBets);
    });
});

// ==========================================
// 7. PROVABLY FAIR VERIFICATION ENDPOINTS
// ==========================================

app.get('/api/provably-fair/me', (req, res) => {
    const userId = req.query.userId || 'player_1';
    const user = users[userId];
    if (!user) return res.status(404).json({ error: "Utilisateur inconnu" });
    
    // On renvoie le SHA256 du serverSeed (sans révéler le seed brut)
    const hashedServerSeed = crypto.createHash('sha256').update(user.serverSeed).digest('hex');
    res.json({ hashedServerSeed, clientSeed: user.clientSeed, nonce: user.nonce });
});

app.post('/api/provably-fair/rotate', (req, res) => {
    const { userId, newClientSeed } = req.body;
    const user = users[userId];
    if (!user) return res.status(404).json({ error: "Utilisateur inconnu" });

    const oldServerSeed = user.serverSeed;
    user.serverSeed = generateSeed();
    user.clientSeed = newClientSeed;
    user.nonce = 0;

    res.json({ 
        revealedPreviousServerSeed: oldServerSeed,
        newHashedServerSeed: crypto.createHash('sha256').update(user.serverSeed).digest('hex')
    });
});

// ==========================================
// 8. DÉMARRAGE DU SERVEUR
// ==========================================

server.listen(PORT, () => {
    console.log(`[GOLD RUSH ENGINE] Serveur opérationnel sur le port ${PORT}`);
    console.log(`[GOLD RUSH ENGINE] Initialisation du système Provably Fair...`);
    console.log(`[GOLD RUSH ENGINE] Mécanisme de Liquidation Flash armé.`);
    startRocketLoop();
});