const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// --- BASES DE DONNÉES EN MÉMOIRE (PERSISTANTS PAR APPAREIL) ---
const devices = {}; // Empreinte d'appareil -> ID de compte
const accounts = {}; // ID de compte -> Données
const leaderboard = [];

// --- ALGORITHME D'AJUSTEMENT DU RISQUE SELON LA MISE ---
function calculateAdjustedRisk(player, betAmount) {
    const betRatio = betAmount / Math.max(player.balance, 1);
    // Risque de base = 1/6 (~16.6% de chance d'arrêt)
    let lossProbability = 0.166;

    // Si le joueur mise plus de 30% de son solde, le taux de risque augmente progressivement
    if (betRatio > 0.3) {
        lossProbability += (betRatio - 0.3) * 0.25;
    }

    // Sécurité : le risque ne dépasse jamais 45%
    return Math.min(lossProbability, 0.45);
}

// --- MOTEUR PROVABLY FAIR ---
function generateFairDraw(serverSeed, clientSeed, nonce, riskFactor) {
    const hash = crypto
        .createHmac('sha256', serverSeed)
        .update(`${clientSeed}:${nonce}`)
        .digest('hex');

    const randVal = parseInt(hash.substring(0, 8), 16) / 0xFFFFFFFF;
    
    // Si la valeur aléatoire tombe dans la zone de risque calculée -> Arrêt/Perte
    const isLoss = randVal < riskFactor;
    
    // Sélection déterministe de la position du gardien (0 à 5)
    const keeperPos = parseInt(hash.substring(8, 12), 16) % 6;

    return { hash, isLoss, keeperPos };
}

// --- GESTION DES SOCKETS & SÉCURITÉ UN-APPAREIL ---
io.on('connection', (socket) => {
    
    // ÉVÉNEMENT 1 : AUTHENTIFICATION STRICTE PAR APPAREIL
    socket.on('authenticate_device', (deviceFingerprint) => {
        if (!deviceFingerprint) {
            return socket.emit('auth_error', 'Empreinte d appareil invalide.');
        }

        let accountId;
        if (devices[deviceFingerprint]) {
            // Appareil déjà reconnu -> Connexion au compte existant
            accountId = devices[deviceFingerprint];
        } else {
            // Nouvel appareil -> Création d'UN SEUL compte verrouillé sur cet appareil
            accountId = `ACC_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
            devices[deviceFingerprint] = accountId;
            
            accounts[accountId] = {
                id: accountId,
                device: deviceFingerprint,
                balance: 1000,
                debt: 0,
                creditScore: 750,
                serverSeed: crypto.randomBytes(16).toString('hex'),
                clientSeed: deviceFingerprint.substring(0, 10),
                nonce: 0,
                inGame: false,
                currentBet: 100,
                step: 0
            };
        }

        socket.accountId = accountId;
        socket.join(accountId);

        const player = accounts[accountId];
        socket.emit('auth_success', { player, leaderboard });
    });

    // ÉVÉNEMENT 2 : TIR DE PENALTY (AVEC GRAPHISMES & RISQUE DYNAMIQUE)
    socket.on('play_shot', (targetZone) => {
        const player = accounts[socket.accountId];
        if (!player) return;

        const multipliers = [1.95, 3.80, 7.50, 15.00, 30.00];

        if (!player.inGame) {
            if (player.currentBet <= 0 || player.currentBet > player.balance) {
                return socket.emit('error_msg', 'Mise invalide ou solde insuffisant !');
            }
            player.balance -= player.currentBet;
            player.inGame = true;
            player.step = 0;
        }

        player.nonce++;
        
        // Calcul du risque dynamique selon le taux de mise
        const currentRisk = calculateAdjustedRisk(player, player.currentBet);
        const pf = generateFairDraw(player.serverSeed, player.clientSeed, player.nonce, currentRisk);

        let keeperPos = pf.keeperPos;
        // Si le tirage indique une perte, le gardien s'aligne sur la zone ciblée
        if (pf.isLoss) {
            keeperPos = targetZone;
        }

        if (targetZone === keeperPos) {
            // ARRÊT -> PERTE
            const lostAmount = player.currentBet;
            player.inGame = false;
            player.step = 0;

            // Vérification de liquidation si dette
            if (player.debt > 0 && player.balance < (player.debt * 0.2)) {
                player.balance = 0;
                player.debt = 0;
                player.creditScore = Math.max(300, player.creditScore - 100);
                socket.emit('liquidation_event', "LIQUIDATION : Solde insuffisant pour couvrir la marge !");
            }

            socket.emit('shot_result', {
                success: false,
                targetZone,
                keeperPos,
                msg: `ARRÊTÉ ! -$${lostAmount}`,
                hash: pf.hash
            });
        } else {
            // BUT MARQUÉ !
            player.step++;
            const mult = multipliers[player.step - 1];

            if (player.step >= multipliers.length) {
                const winAmount = Math.round(player.currentBet * mult);
                player.balance += winAmount;
                player.inGame = false;

                socket.emit('shot_result', {
                    success: true,
                    targetZone,
                    keeperPos,
                    mult,
                    winAmount,
                    isJackpot: true,
                    msg: `JACKPOT ULTIME ! +$${winAmount.toLocaleString()}`,
                    hash: pf.hash
                });
            } else {
                socket.emit('shot_result', {
                    success: true,
                    targetZone,
                    keeperPos,
                    mult,
                    step: player.step,
                    msg: `BUT ! Multiplicateur x${mult}`,
                    hash: pf.hash
                });
            }
        }

        updateAndBroadcast(socket, player);
    });

    // ÉVÉNEMENT 3 : CASHOUT
    socket.on('cashout', () => {
        const player = accounts[socket.accountId];
        if (!player || !player.inGame || player.step === 0) return;

        const multipliers = [1.95, 3.80, 7.50, 15.00, 30.00];
        const winAmount = Math.round(player.currentBet * multipliers[player.step - 1]);

        player.balance += winAmount;
        player.inGame = false;
        player.step = 0;

        socket.emit('cashout_success', { winAmount, msg: `ENCAISSÉ ! +$${winAmount.toLocaleString()}` });
        updateAndBroadcast(socket, player);
    });

    // ÉVÉNEMENT 4 : BANQUE & EMPRUNTS
    socket.on('take_loan', () => {
        const player = accounts[socket.accountId];
        if (!player) return;

        if (player.debt > 0) return socket.emit('error_msg', 'Remboursez votre prêt en cours !');
        
        player.debt = 550; // $500 empruntés + 10% frais
        player.balance += 500;
        updateAndBroadcast(socket, player);
    });

    socket.on('repay_loan', () => {
        const player = accounts[socket.accountId];
        if (!player) return;

        if (player.balance < player.debt) return socket.emit('error_msg', 'Solde insuffisant pour rembourser la dette.');
        
        player.balance -= player.debt;
        player.debt = 0;
        player.creditScore = Math.min(850, player.creditScore + 20);
        updateAndBroadcast(socket, player);
    });

    socket.on('set_bet', (amount) => {
        const player = accounts[socket.accountId];
        if (player && !player.inGame) player.currentBet = Math.max(10, parseFloat(amount) || 10);
    });
});

function updateAndBroadcast(socket, player) {
    let lbItem = leaderboard.find(l => l.id === player.id);
    if (!lbItem) {
        lbItem = { id: player.id, netWorth: 0 };
        leaderboard.push(lbItem);
    }
    lbItem.netWorth = player.balance - player.debt;
    leaderboard.sort((a, b) => b.netWorth - a.netWorth);

    socket.emit('update_player', player);
    io.emit('update_leaderboard', leaderboard.slice(0, 5));
}

// --- INTERFACE CLIENT BOOTSTRAP 5 + ANIMATIONS CANVAS ---
app.get('*', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="fr" data-bs-theme="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>GOLD RUSH - Pro Financial Arcade</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&family=Rajdhani:wght@600;700&display=swap" rel="stylesheet">
    <script src="/socket.io/socket.io.js"></script>
    <style>
        :root {
            --gold: #ffd700;
            --gold-glow: 0 0 20px rgba(255, 215, 0, 0.4);
            --bg-dark: #080b11;
        }

        body {
            background-color: var(--bg-dark);
            font-family: 'Rajdhani', sans-serif;
            color: #f0f4f8;
            min-height: 100vh;
        }

        .font-orbitron { font-family: 'Orbitron', sans-serif; }
        .text-gold { color: var(--gold); text-shadow: 0 0 10px rgba(255,215,0,0.3); }
        .bg-glass { background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(12px); border: 1px solid rgba(255, 215, 0, 0.15); }
        .card-gold { border: 1px solid rgba(255, 215, 0, 0.3); box-shadow: inset 0 0 15px rgba(255, 215, 0, 0.05); }

        /* CANVAS DE JEU GRAPHIQUE */
        #gameCanvas {
            width: 100%;
            height: 280px;
            background: radial-gradient(circle at center, #111a2e 0%, #05080e 100%);
            border-radius: 12px;
            border: 2px solid rgba(255, 215, 0, 0.3);
        }

        .target-btn-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 10px;
            margin-top: -80px;
            position: relative;
            z-index: 10;
            padding: 0 15px;
        }

        .target-node {
            height: 60px;
            background: rgba(0, 0, 0, 0.4);
            border: 1px dashed rgba(255, 215, 0, 0.4);
            border-radius: 8px;
            color: var(--gold);
            font-size: 1.5rem;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            transition: all 0.2s;
        }

        .target-node:hover {
            background: rgba(255, 215, 0, 0.2);
            border-style: solid;
            transform: scale(1.03);
        }

        .btn-gold {
            background: linear-gradient(135deg, #fff3a8 0%, #ffd700 50%, #996515 100%);
            color: #000;
            font-weight: 800;
            border: none;
            box-shadow: var(--gold-glow);
        }

        .btn-gold:hover { color: #000; opacity: 0.9; }
    </style>
</head>
<body>

    <nav class="navbar navbar-expand-lg bg-glass sticky-top border-bottom border-warning border-opacity-25">
        <div class="container">
            <a class="navbar-brand font-orbitron fw-bold text-gold fs-4" href="#">GOLD RUSH 🪙</a>
            <div class="d-flex align-items-center gap-3">
                <div class="bg-black bg-opacity-50 px-3 py-1 rounded-pill border border-warning border-opacity-25">
                    <small class="text-secondary me-1">SOLDE:</small>
                    <span id="balance-txt" class="font-orbitron fw-bold text-gold">$0</span>
                </div>
            </div>
        </div>
    </nav>

    <div class="container my-4">
        <div class="row g-4">
            
            <div class="col-lg-3">
                <div class="card bg-glass card-gold p-3 mb-3">
                    <h6 class="font-orbitron text-gold mb-3">🏦 BANQUE & EMPRUNTS</h6>
                    <div class="d-flex justify-content-between mb-2">
                        <span class="text-secondary">Dette Active:</span>
                        <span id="debt-txt" class="text-danger fw-bold">$0</span>
                    </div>
                    <div class="d-flex justify-content-between mb-3">
                        <span class="text-secondary">Score Crédit:</span>
                        <span id="credit-txt" class="text-success fw-bold">750</span>
                    </div>
                    <button class="btn btn-gold w-100 mb-2" onclick="takeLoan()">Emprunter $500</button>
                    <button class="btn btn-outline-danger w-100" onclick="repayLoan()">Rembourser</button>
                </div>

                <div class="card bg-glass p-3">
                    <h6 class="font-orbitron text-gold mb-2">🔒 APPAREIL BINDED</h6>
                    <small class="text-secondary mb-1">ID Compte Unique :</small>
                    <code id="account-id-txt" class="text-warning font-monospace">Chargement...</code>
                </div>
            </div>

            <div class="col-lg-6">
                <div class="card bg-glass card-gold p-3">
                    
                    <div class="d-flex justify-content-between mb-3 text-center">
                        <span class="badge bg-dark border border-secondary p-2 flex-fill mx-1 mult-badge" id="m-0">x1.95</span>
                        <span class="badge bg-dark border border-secondary p-2 flex-fill mx-1 mult-badge" id="m-1">x3.80</span>
                        <span class="badge bg-dark border border-secondary p-2 flex-fill mx-1 mult-badge" id="m-2">x7.50</span>
                        <span class="badge bg-dark border border-secondary p-2 flex-fill mx-1 mult-badge" id="m-3">x15.00</span>
                        <span class="badge bg-dark border border-secondary p-2 flex-fill mx-1 mult-badge" id="m-4">x30.00</span>
                    </div>

                    <div id="status-txt" class="text-center font-orbitron text-gold mb-2 small">
                        INITIALISATION...
                    </div>

                    <canvas id="gameCanvas" width="600" height="280"></canvas>

                    <div class="target-btn-grid">
                        <div class="target-node" onclick="shoot(0)">⚽</div>
                        <div class="target-node" onclick="shoot(1)">⚽</div>
                        <div class="target-node" onclick="shoot(2)">⚽</div>
                        <div class="target-node" onclick="shoot(3)">⚽</div>
                        <div class="target-node" onclick="shoot(4)">⚽</div>
                        <div class="target-node" onclick="shoot(5)">⚽</div>
                    </div>

                    <div class="row g-2 mt-3">
                        <div class="col-6">
                            <div class="input-group">
                                <span class="input-group-text bg-black text-gold">$</span>
                                <input type="number" id="bet-input" class="form-control bg-black text-white font-orbitron" value="100" onchange="updateBet()">
                            </div>
                        </div>
                        <div class="col-6">
                            <button id="cashout-btn" class="btn btn-success w-100 font-orbitron fw-bold" onclick="cashout()" disabled>ENCAISSER</button>
                        </div>
                    </div>

                </div>
            </div>

            <div class="col-lg-3">
                <div class="card bg-glass p-3">
                    <h6 class="font-orbitron text-gold mb-3">🏆 WALL STREET LEADERBOARD</h6>
                    <div id="leaderboard-box" class="d-flex flex-column gap-2"></div>
                </div>
            </div>

        </div>
    </div>

    <script>
        const socket = io();
        const canvas = document.getElementById('gameCanvas');
        const ctx = canvas.getContext('2d');

        // POSITIONS GRAPHIQUES DES 6 ZONES SUR LE CANVAS
        const zoneCoords = [
            { x: 120, y: 80 }, { x: 300, y: 80 }, { x: 480, y: 80 },
            { x: 120, y: 160 }, { x: 300, y: 160 }, { x: 480, y: 160 }
        ];

        let keeperState = { x: 300, y: 120, targetX: 300, targetY: 120, color: '#ff2a5f' };
        let ballState = { x: 300, y: 250, targetX: 300, targetY: 250, active: false };

        // GENERATION D'EMPREINTE D'APPAREIL UNIQUE
        function getDeviceFingerprint() {
            let id = localStorage.getItem('gold_device_id');
            if (!id) {
                id = 'DEV_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
                localStorage.setItem('gold_device_id', id);
            }
            return id;
        }

        // CONNECT ET AUTHENTIFICATION AUTOMATIQUE
        socket.on('connect', () => {
            const fp = getDeviceFingerprint();
            socket.emit('authenticate_device', fp);
        });

        socket.on('auth_success', (data) => {
            document.getElementById('account-id-txt').innerText = data.player.id;
            updateUI(data.player);
            renderLeaderboard(data.leaderboard);
            document.getElementById('status-txt').innerText = "CONNECTÉ - CHOISISSEZ UNE ZONE ET TIREZ !";
        });

        socket.on('update_player', updateUI);
        socket.on('update_leaderboard', renderLeaderboard);

        socket.on('shot_result', (res) => {
            animateShot(res.targetZone, res.keeperPos);
            document.getElementById('status-txt').innerText = res.msg;

            if (res.success) {
                highlightStep(res.step - 1);
                document.getElementById('cashout-btn').disabled = false;
            } else {
                resetMults();
                document.getElementById('cashout-btn').disabled = true;
            }
        });

        socket.on('cashout_success', (res) => {
            document.getElementById('status-txt').innerText = res.msg;
            resetMults();
            document.getElementById('cashout-btn').disabled = true;
        });

        socket.on('error_msg', alert);

        function shoot(zoneIdx) {
            socket.emit('play_shot', zoneIdx);
        }

        function cashout() {
            socket.emit('cashout');
        }

        function updateBet() {
            socket.emit('set_bet', document.getElementById('bet-input').value);
        }

        function takeLoan() { socket.emit('take_loan'); }
        function repayLoan() { socket.emit('repay_loan'); }

        function updateUI(p) {
            document.getElementById('balance-txt').innerText = '$' + p.balance.toLocaleString();
            document.getElementById('debt-txt').innerText = '$' + p.debt.toLocaleString();
            document.getElementById('credit-txt').innerText = p.creditScore;
        }

        function renderLeaderboard(lb) {
            const box = document.getElementById('leaderboard-box');
            box.innerHTML = '';
            lb.forEach((item, idx) => {
                box.innerHTML += \`
                    <div class="d-flex justify-content-between align-items-center p-2 rounded bg-black bg-opacity-40">
                        <span class="text-gold fw-bold">#\${idx + 1}</span>
                        <small class="font-monospace text-secondary">\${item.id}</small>
                        <span class="font-orbitron fw-bold">$\${item.netWorth.toLocaleString()}</span>
                    </div>
                \`;
            });
        }

        function highlightStep(idx) {
            resetMults();
            if (idx >= 0) {
                const badge = document.getElementById(\`m-\${idx}\`);
                if (badge) {
                    badge.classList.remove('bg-dark');
                    badge.classList.add('bg-warning', 'text-dark', 'fw-bold');
                }
            }
        }

        function resetMults() {
            document.querySelectorAll('.mult-badge').forEach(b => {
                b.className = 'badge bg-dark border border-secondary p-2 flex-fill mx-1 mult-badge';
            });
        }

        // ANIMATIONS CANVAS EN TEMPS RÉEL (60 FPS)
        function animateShot(targetZoneIdx, keeperPosIdx) {
            const targetCoords = zoneCoords[targetZoneIdx];
            const keeperCoords = zoneCoords[keeperPosIdx];

            keeperState.targetX = keeperCoords.x;
            keeperState.targetY = keeperCoords.y;

            ballState.x = 300;
            ballState.y = 250;
            ballState.targetX = targetCoords.x;
            ballState.targetY = targetCoords.y;
            ballState.active = true;
        }

        function renderLoop() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            // DESSINER LE BUT EN NEON
            ctx.strokeStyle = 'rgba(255, 215, 0, 0.4)';
            ctx.lineWidth = 4;
            ctx.strokeRect(60, 40, 480, 160);

            // ANIME LE GARDIEN (INTERPOLATION SMOOTH)
            keeperState.x += (keeperState.targetX - keeperState.x) * 0.15;
            keeperState.y += (keeperState.targetY - keeperState.y) * 0.15;

            ctx.fillStyle = keeperState.color;
            ctx.beginPath();
            ctx.arc(keeperState.x, keeperState.y, 22, 0, Math.PI * 2);
            ctx.fill();

            // ANIME LA BALLE
            if (ballState.active) {
                ballState.x += (ballState.targetX - ballState.x) * 0.2;
                ballState.y += (ballState.targetY - ballState.y) * 0.2;

                ctx.fillStyle = '#ffffff';
                ctx.beginPath();
                ctx.arc(ballState.x, ballState.y, 10, 0, Math.PI * 2);
                ctx.fill();
            }

            requestAnimationFrame(renderLoop);
        }

        renderLoop();
        updateBet();
    </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Serveur Gold Rush Ultra en ligne sur le port ${PORT}`);
});
