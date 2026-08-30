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

// --- MOTEUR PROVABLY FAIR (CRYPTOGRAPHIE SHA-256) ---
function generateProvablyFairResult(serverSeed, clientSeed, nonce) {
    const hash = crypto
        .createHmac('sha256', serverSeed)
        .update(`${clientSeed}:${nonce}`)
        .digest('hex');
    
    const subHash = hash.substring(0, 8);
    const decimalValue = parseInt(subHash, 16);
    const keeperPosition = decimalValue % 6;

    return { hash, keeperPosition };
}

// --- BASE DE DONNÉES EN MÉMOIRE ---
const players = {};
const leaderboard = [
    { name: 'Satoshi_N', netWorth: 250000 },
    { name: 'Whale_Trader', netWorth: 120000 },
    { name: 'GoldHunter', netWorth: 45000 }
];

// --- GESTION TEMPS RÉEL (SOCKET.IO) ---
io.on('connection', (socket) => {
    players[socket.id] = {
        id: socket.id,
        name: `Trader_${socket.id.substring(0, 4)}`,
        balance: 1000,
        debt: 0,
        creditScore: 750,
        serverSeed: crypto.randomBytes(16).toString('hex'),
        clientSeed: 'default_user_seed',
        nonce: 0,
        inGame: false,
        currentBet: 0,
        step: 0
    };

    const player = players[socket.id];

    socket.emit('init_state', {
        player,
        leaderboard
    });

    socket.on('take_loan', (amount) => {
        if (player.debt > 0) {
            return socket.emit('error_msg', "Remboursez d'abord votre prêt actif !");
        }
        if (amount > 1000) {
            return socket.emit('error_msg', "Plafond de prêt dépassé ($1,000 max) !");
        }

        const interest = Math.round(amount * 0.10);
        player.debt = amount + interest;
        player.balance += amount;
        
        broadcastUpdate(socket, player);
    });

    socket.on('repay_loan', () => {
        if (player.debt === 0) return;
        if (player.balance < player.debt) {
            return socket.emit('error_msg', 'Solde insuffisant pour rembourser la dette !');
        }

        player.balance -= player.debt;
        player.debt = 0;
        player.creditScore = Math.min(850, player.creditScore + 15);

        broadcastUpdate(socket, player);
    });

    socket.on('play_shot', (targetZone) => {
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
        const pfResult = generateProvablyFairResult(player.serverSeed, player.clientSeed, player.nonce);
        const keeperPos = pfResult.keeperPosition;

        if (targetZone === keeperPos) {
            const lostBet = player.currentBet;
            player.inGame = false;
            player.step = 0;

            checkLiquidation(player, socket);

            socket.emit('shot_result', {
                success: false,
                keeperPos,
                msg: `ARRÊTÉ ! Vous avez perdu $${lostBet}`,
                hash: pfResult.hash,
                nonce: player.nonce
            });
        } else {
            player.step++;
            const currentMult = multipliers[player.step - 1];

            if (player.step >= multipliers.length) {
                const winAmount = Math.round(player.currentBet * currentMult);
                player.balance += winAmount;
                player.inGame = false;

                socket.emit('shot_result', {
                    success: true,
                    keeperPos,
                    winAmount,
                    mult: currentMult,
                    isJackpot: true,
                    msg: `JACKPOT ULTIME ! +$${winAmount.toLocaleString()}`,
                    hash: pfResult.hash,
                    nonce: player.nonce
                });
            } else {
                socket.emit('shot_result', {
                    success: true,
                    keeperPos,
                    mult: currentMult,
                    step: player.step,
                    msg: `BUT ! Multiplicateur actuel : x${currentMult}`,
                    hash: pfResult.hash,
                    nonce: player.nonce
                });
            }
        }

        broadcastUpdate(socket, player);
    });

    socket.on('cashout', () => {
        if (!player.inGame || player.step === 0) return;

        const multipliers = [1.95, 3.80, 7.50, 15.00, 30.00];
        const winAmount = Math.round(player.currentBet * multipliers[player.step - 1]);
        
        player.balance += winAmount;
        player.inGame = false;
        player.step = 0;

        socket.emit('cashout_success', {
            winAmount,
            msg: `ENCAISSÉ AVEC SUCCÈS ! +$${winAmount.toLocaleString()}`
        });

        broadcastUpdate(socket, player);
    });

    socket.on('set_bet', (bet) => {
        if (!player.inGame) player.currentBet = parseFloat(bet) || 0;
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
    });
});

function checkLiquidation(player, socket) {
    if (player.debt > 0 && player.balance < (player.debt * 0.2)) {
        player.balance = 0;
        player.debt = 0;
        player.creditScore = Math.max(300, player.creditScore - 100);
        socket.emit('liquidation_alert', "LIQUIDATION SÈCHE ! Votre dette a absorbé l'intégralité de votre solde.");
    }
}

function broadcastUpdate(socket, player) {
    let userRank = leaderboard.find(p => p.name === player.name);
    if (!userRank) {
        userRank = { name: player.name, netWorth: 0 };
        leaderboard.push(userRank);
    }
    userRank.netWorth = player.balance - player.debt;
    leaderboard.sort((a, b) => b.netWorth - a.netWorth);

    socket.emit('update_player', player);
    io.emit('update_leaderboard', leaderboard.slice(0, 5));
}

// --- RENDU APPLICATION ---
app.get('*', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>GOLD RUSH - Ultimate Financial Arcade</title>
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@600;800;900&family=Rajdhani:wght@500;700&display=swap" rel="stylesheet">
    <script src="/socket.io/socket.io.js"></script>
    <style>
        :root {
            --bg-dark: #07090e;
            --panel-bg: rgba(15, 20, 29, 0.9);
            --gold-primary: #ffd700;
            --gold-gradient: linear-gradient(135deg, #fff3a8 0%, #ffd700 50%, #996515 100%);
            --gold-glow: 0 0 15px rgba(255, 215, 0, 0.35);
            --red-alert: #ff2a5f;
            --green-win: #00e676;
            --text-main: #f0f4f8;
            --text-muted: #64748b;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Rajdhani', sans-serif; user-select: none; -webkit-tap-highlight-color: transparent; }

        body {
            background-color: var(--bg-dark);
            color: var(--text-main);
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            overflow-x: hidden;
            background-image: radial-gradient(circle at 50% 0%, rgba(255, 215, 0, 0.05) 0%, transparent 70%);
        }

        header {
            background: rgba(15, 20, 29, 0.95);
            border-bottom: 1px solid rgba(255, 215, 0, 0.2);
            padding: 12px 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            position: sticky;
            top: 0;
            z-index: 100;
            backdrop-filter: blur(10px);
        }

        .logo {
            font-family: 'Orbitron', sans-serif;
            font-size: 1.4rem;
            font-weight: 900;
            background: var(--gold-gradient);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            letter-spacing: 1px;
        }

        .wallet-bar { display: flex; gap: 12px; align-items: center; }

        .stat-badge {
            background: rgba(255, 215, 0, 0.08);
            border: 1px solid rgba(255, 215, 0, 0.3);
            border-radius: 20px;
            padding: 6px 14px;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .stat-value {
            font-family: 'Orbitron', sans-serif;
            font-size: 1rem;
            font-weight: 700;
            color: var(--gold-primary);
        }

        .app-container {
            flex: 1;
            display: flex;
            flex-direction: column;
            padding: 12px;
            gap: 12px;
            max-width: 1400px;
            margin: 0 auto;
            width: 100%;
        }

        .mobile-tabs {
            display: flex;
            background: var(--panel-bg);
            border-radius: 10px;
            padding: 4px;
            border: 1px solid rgba(255, 255, 255, 0.05);
        }

        .tab-btn {
            flex: 1;
            padding: 10px;
            text-align: center;
            font-weight: 700;
            font-size: 0.85rem;
            color: var(--text-muted);
            border-radius: 8px;
            cursor: pointer;
            text-transform: uppercase;
        }

        .tab-btn.active {
            background: var(--gold-gradient);
            color: #000;
            box-shadow: var(--gold-glow);
        }

        .tab-content { display: none; flex-direction: column; gap: 12px; }
        .tab-content.active { display: flex; }

        .panel {
            background: var(--panel-bg);
            border-radius: 14px;
            padding: 16px;
            border: 1px solid rgba(255, 255, 255, 0.05);
            display: flex;
            flex-direction: column;
            gap: 12px;
            backdrop-filter: blur(5px);
        }

        .panel-title {
            font-family: 'Orbitron', sans-serif;
            font-size: 0.9rem;
            color: var(--gold-primary);
            border-bottom: 1px solid rgba(255,215,0,0.15);
            padding-bottom: 8px;
            text-transform: uppercase;
        }

        .game-card {
            background: radial-gradient(circle at top, #141c2b 0%, #090d15 100%);
            border: 1px solid rgba(255, 215, 0, 0.25);
            border-radius: 16px;
            padding: 16px;
            display: flex;
            flex-direction: column;
            gap: 16px;
            box-shadow: inset 0 0 30px rgba(0,0,0,0.8);
        }

        .mult-bar { display: flex; gap: 8px; justify-content: center; overflow-x: auto; padding-bottom: 4px; }
        .mult-step {
            font-family: 'Orbitron', sans-serif;
            padding: 6px 14px;
            border-radius: 16px;
            font-size: 0.85rem;
            font-weight: 700;
            color: var(--text-muted);
            background: rgba(255, 255, 255, 0.04);
            border: 1px solid rgba(255, 255, 255, 0.05);
        }

        .mult-step.active {
            color: #000;
            background: var(--gold-gradient);
            box-shadow: var(--gold-glow);
            transform: scale(1.05);
        }

        .stadium {
            width: 100%;
            height: 220px;
            border: 3px solid #fff;
            border-bottom: 2px dashed rgba(255,255,255,0.2);
            border-radius: 12px 12px 0 0;
            position: relative;
            background: radial-gradient(circle at bottom, rgba(0, 230, 118, 0.1) 0%, transparent 70%);
            overflow: hidden;
        }

        .keeper {
            width: 44px;
            height: 44px;
            background: var(--red-alert);
            border-radius: 50%;
            position: absolute;
            top: 20px;
            left: calc(50% - 22px);
            transition: all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            box-shadow: 0 0 15px var(--red-alert);
        }

        .target-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            grid-template-rows: repeat(2, 1fr);
            height: 100%;
            gap: 8px;
            padding: 8px;
        }

        .target-btn {
            border: 1px dashed rgba(255, 215, 0, 0.3);
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 1.5rem;
            background: rgba(0,0,0,0.2);
            cursor: pointer;
        }

        .target-btn:active { background: rgba(255, 215, 0, 0.3); transform: scale(0.95); }

        .btn {
            padding: 14px;
            border-radius: 10px;
            border: none;
            font-weight: 700;
            font-size: 0.95rem;
            text-transform: uppercase;
            cursor: pointer;
            transition: all 0.2s;
        }

        .btn-gold { background: var(--gold-gradient); color: #000; box-shadow: var(--gold-glow); }
        .btn-green { background: var(--green-win); color: #000; box-shadow: 0 0 15px rgba(0, 230, 118, 0.4); }
        .btn-danger { background: linear-gradient(135deg, #ff2a5f 0%, #990026 100%); color: #fff; }
        .btn:disabled { opacity: 0.4; cursor: not-allowed; box-shadow: none; }

        .input-box {
            background: rgba(0,0,0,0.5);
            border: 1px solid rgba(255, 215, 0, 0.3);
            border-radius: 10px;
            display: flex;
            align-items: center;
            padding: 0 12px;
        }

        .input-box input {
            width: 100%;
            background: transparent;
            border: none;
            color: #fff;
            font-family: 'Orbitron', sans-serif;
            font-size: 1.1rem;
            padding: 10px 0;
            outline: none;
        }

        .leader-item {
            display: flex;
            justify-content: space-between;
            padding: 10px;
            background: rgba(255, 255, 255, 0.02);
            border-radius: 8px;
            font-size: 0.9rem;
        }

        @media (min-width: 900px) {
            .mobile-tabs { display: none; }
            .app-container {
                display: grid;
                grid-template-columns: 300px 1fr 320px;
                align-items: start;
                padding: 24px;
                gap: 20px;
            }
            .tab-content { display: flex !important; }
            .stadium { height: 260px; }
            .logo { font-size: 1.8rem; }
        }
    </style>
</head>
<body>

    <header>
        <div class="logo">GOLD RUSH 🪙</div>
        <div class="wallet-bar">
            <div class="stat-badge">
                <span style="font-size:0.75rem; color:var(--text-muted)">SOLDE:</span>
                <span class="stat-value" id="balance-display">$0</span>
            </div>
        </div>
    </header>

    <div class="app-container">

        <div class="mobile-tabs">
            <div class="tab-btn active" onclick="switchTab('game', event)">🎮 Jeu</div>
            <div class="tab-btn" onclick="switchTab('bank', event)">🏦 Banque</div>
            <div class="tab-btn" onclick="switchTab('ranks', event)">🏆 Rangs</div>
        </div>

        <div class="tab-content" id="tab-bank">
            <div class="panel">
                <div class="panel-title">Système de Prêt</div>
                <div style="display:flex; justify-content:space-between;">
                    <span>Dette Active:</span>
                    <span id="debt-display" style="color:var(--red-alert); font-weight:bold;">$0</span>
                </div>
                <div style="display:flex; justify-content:space-between;">
                    <span>Score de Crédit:</span>
                    <span id="credit-display" style="color:var(--green-win); font-weight:bold;">750</span>
                </div>
                <button class="btn btn-gold" onclick="takeLoan()">Emprunter $500 (Intérêt 10%)</button>
                <button class="btn btn-danger" onclick="repayLoan()">Rembourser la Dette</button>
            </div>
            
            <div class="panel">
                <div class="panel-title">Provably Fair (SHA-256)</div>
                <div style="font-size:0.8rem; color:var(--text-muted); word-break:break-all;">
                    <span>Dernier Hash Serveur:</span>
                    <div id="hash-display" style="color:var(--gold-primary); margin-top:4px; font-family:monospace;">-</div>
                </div>
            </div>
        </div>

        <div class="tab-content active" id="tab-game">
            <div class="game-card">
                
                <div class="mult-bar">
                    <div class="mult-step" id="step-0">x1.95</div>
                    <div class="mult-step" id="step-1">x3.80</div>
                    <div class="mult-step" id="step-2">x7.50</div>
                    <div class="mult-step" id="step-3">x15.00</div>
                    <div class="mult-step" id="step-4">x30.00</div>
                </div>

                <div id="status-display" style="text-align:center; font-family:'Orbitron'; font-size:0.85rem; color:var(--gold-primary); min-height:20px;">
                    CHOISISSEZ UNE ZONE ET TIREZ !
                </div>

                <div class="stadium">
                    <div class="keeper" id="keeper"></div>
                    <div class="target-grid">
                        <div class="target-btn" onclick="shoot(0)">⚽</div>
                        <div class="target-btn" onclick="shoot(1)">⚽</div>
                        <div class="target-btn" onclick="shoot(2)">⚽</div>
                        <div class="target-btn" onclick="shoot(3)">⚽</div>
                        <div class="target-btn" onclick="shoot(4)">⚽</div>
                        <div class="target-btn" onclick="shoot(5)">⚽</div>
                    </div>
                </div>

                <div style="display:flex; flex-direction:column; gap:10px;">
                    <div class="input-box">
                        <span style="color:var(--gold-primary); margin-right:6px; font-weight:bold">$</span>
                        <input type="number" id="bet-amount" value="100" min="10" onchange="updateBet()">
                    </div>
                    <button class="btn btn-green" id="cashout-btn" onclick="cashout()" disabled>ENCAISSER</button>
                </div>

            </div>
        </div>

        <div class="tab-content" id="tab-ranks">
            <div class="panel">
                <div class="panel-title">Wall Street Leaderboard 🏆</div>
                <div id="leaderboard-list" style="display:flex; flex-direction:column; gap:8px;"></div>
            </div>
        </div>

    </div>

    <script>
        const socket = io();
        let audioCtx = null;

        function initAudio() {
            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }

        function playSound(freq, duration) {
            initAudio();
            if(!audioCtx) return;
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.frequency.value = freq;
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start();
            gain.gain.exponentialRampToValueAtTime(0.00001, audioCtx.currentTime + duration);
            osc.stop(audioCtx.currentTime + duration);
        }

        function vibrate(ms) {
            if (navigator.vibrate) navigator.vibrate(ms);
        }

        function switchTab(tabName, evt) {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            
            if(tabName === 'game') document.getElementById('tab-game').classList.add('active');
            if(tabName === 'bank') document.getElementById('tab-bank').classList.add('active');
            if(tabName === 'ranks') document.getElementById('tab-ranks').classList.add('active');
            if(evt && evt.target) evt.target.classList.add('active');
        }

        socket.on('init_state', (data) => {
            updatePlayerUI(data.player);
            renderLeaderboard(data.leaderboard);
        });

        socket.on('update_player', (player) => {
            updatePlayerUI(player);
        });

        socket.on('update_leaderboard', (lb) => {
            renderLeaderboard(lb);
        });

        socket.on('shot_result', (res) => {
            moveKeeper(res.keeperPos);
            document.getElementById('hash-display').innerText = res.hash;

            const status = document.getElementById('status-display');
            status.innerText = res.msg;

            if (res.success) {
                playSound(600, 0.15);
                vibrate(50);
                status.style.color = "var(--gold-primary)";
                highlightStep(res.step - 1);
                document.getElementById('cashout-btn').disabled = false;
            } else {
                playSound(150, 0.3);
                vibrate([100, 50, 100]);
                status.style.color = "var(--red-alert)";
                resetGameUI();
            }
        });

        socket.on('cashout_success', (res) => {
            playSound(800, 0.25);
            vibrate(100);
            const status = document.getElementById('status-display');
            status.innerText = res.msg;
            status.style.color = "var(--green-win)";
            resetGameUI();
        });

        socket.on('error_msg', (msg) => {
            alert(msg);
        });

        socket.on('liquidation_alert', (msg) => {
            playSound(100, 0.5);
            vibrate(500);
            alert(msg);
        });

        function shoot(zoneIndex) {
            initAudio();
            socket.emit('play_shot', zoneIndex);
        }

        function cashout() {
            socket.emit('cashout');
        }

        function updateBet() {
            const val = document.getElementById('bet-amount').value;
            socket.emit('set_bet', val);
        }

        function takeLoan() {
            socket.emit('take_loan', 500);
        }

        function repayLoan() {
            socket.emit('repay_loan');
        }

        function updatePlayerUI(p) {
            document.getElementById('balance-display').innerText = '$' + p.balance.toLocaleString();
            document.getElementById('debt-display').innerText = '$' + p.debt.toLocaleString();
            document.getElementById('credit-display').innerText = p.creditScore;
        }

        function renderLeaderboard(lb) {
            const container = document.getElementById('leaderboard-list');
            container.innerHTML = '';
            lb.forEach((item, idx) => {
                container.innerHTML += \`
                    <div class="leader-item">
                        <span style="color:var(--gold-primary); font-weight:bold;">#\${idx+1}</span>
                        <span>\${item.name}</span>
                        <span style="font-family:'Orbitron'">$\${item.netWorth.toLocaleString()}</span>
                    </div>
                \`;
            });
        }

        function moveKeeper(pos) {
            const keeper = document.getElementById('keeper');
            const coords = [
                { top: '15px', left: '15%' }, { top: '15px', left: '45%' }, { top: '15px', left: '75%' },
                { top: '110px', left: '15%' }, { top: '110px', left: '45%' }, { top: '110px', left: '75%' }
            ];
            keeper.style.top = coords[pos].top;
            keeper.style.left = coords[pos].left;
        }

        function highlightStep(idx) {
            document.querySelectorAll('.mult-step').forEach(el => el.classList.remove('active'));
            if (idx >= 0) {
                const el = document.getElementById(\`step-\${idx}\`);
                if (el) el.classList.add('active');
            }
        }

        function resetGameUI() {
            document.getElementById('cashout-btn').disabled = true;
            setTimeout(() => {
                document.querySelectorAll('.mult-step').forEach(el => el.classList.remove('active'));
            }, 1200);
        }

        updateBet();
    </script>
</body>
</html>`);
});

// PORTS POUR RENDER
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Serveur Gold Rush prêt sur le port ${PORT}`);
});
