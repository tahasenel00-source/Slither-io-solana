'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const { getAssociatedTokenAddress, getOrCreateAssociatedTokenAccount, createTransferInstruction, createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID } = require('@solana/spl-token');

const PORT = process.env.PORT || 3001;
const RPC_URL = process.env.SOLANA_RPC_URL || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const TOKEN_MINT = process.env.TOKEN_MINT;
const TOKEN_DECIMALS = parseInt(process.env.TOKEN_DECIMALS || '6', 10);
const TREASURY_SECRET_KEY = process.env.TREASURY_SECRET_KEY; // base64 or JSON array
const GAME_PER_TOKEN = parseFloat(process.env.GAME_PER_TOKEN || '1');
const FEE_BPS = (function(){
    if (process.env.FEE_BPS) return parseInt(process.env.FEE_BPS, 10) || 0;
    if (process.env.FEE) return Math.round(parseFloat(process.env.FEE) * 10000) || 0;
    return 0;
})();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*'} });

const connection = new Connection(RPC_URL, 'confirmed');
const players = new Map(); // socketId -> { wallet, gameBalance }
const pellets = new Map(); // pelletId -> { x,y,value }

let treasury;
try {
	if (!TREASURY_SECRET_KEY) throw new Error('Missing TREASURY_SECRET_KEY');
	const secret = TREASURY_SECRET_KEY.trim();
	if (secret.startsWith('[')) {
		treasury = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)));
	} else {
		const bytes = Buffer.from(secret, 'base64');
		treasury = Keypair.fromSecretKey(bytes);
	}
} catch (e) {
	console.warn('Treasury key not loaded:', e.message);
}

// Ensure treasury ATA exists on startup (best-effort)
(async function ensureTreasuryAta(){
    try {
        if (TOKEN_MINT && treasury) {
            const mintPk = new PublicKey(TOKEN_MINT);
            await getOrCreateAssociatedTokenAccount(connection, treasury, mintPk, treasury.publicKey);
        }
    } catch(e) {
        console.warn('ensureTreasuryAta failed:', e.message);
    }
})();

const logsDir = path.join(__dirname, 'logs');
const txLogPath = path.join(logsDir, 'transactions.json');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);
if (!fs.existsSync(txLogPath)) fs.writeFileSync(txLogPath, '[]');

function logTx(entry){
	try {
		const arr = JSON.parse(fs.readFileSync(txLogPath, 'utf8'));
		arr.push(Object.assign(entry, { ts: Date.now() }));
		fs.writeFileSync(txLogPath, JSON.stringify(arr, null, 2));
	} catch(e) {}
}

function toBps(amount, bps){ return Math.floor((amount * bps) / 10000); }

// Public config for client
app.get('/config', (req, res) => {
    res.json({
        rpcUrl: RPC_URL,
        tokenMint: TOKEN_MINT || null,
        tokenDecimals: isFinite(TOKEN_DECIMALS) ? TOKEN_DECIMALS : null,
        treasuryPubkey: treasury ? treasury.publicKey.toBase58() : null
    });
});

// Helper: verify SPL transfer signature for deposit
async function verifyDepositSignature(signature, expectedFrom, expectedTo, expectedMint, expectedAmount){
	try {
		const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
		if (!tx || !tx.meta) return false;
        const instrs = tx.transaction.message.instructions || [];
        const expectedFromPk = new PublicKey(expectedFrom);
        const expectedToPk = new PublicKey(expectedTo);
        const mintPk = new PublicKey(expectedMint);
        // Compute ATAs for comparison
        const fromAta = await getAssociatedTokenAddress(mintPk, expectedFromPk);
        const toAta = await getAssociatedTokenAddress(mintPk, expectedToPk);
        const amountRaw = BigInt(expectedAmount);
        let ok = false;
        for (const ix of instrs) {
            if (ix.program && ix.program === 'spl-token' && ix.parsed && (ix.parsed.type === 'transferChecked' || ix.parsed.type === 'transfer')) {
                const info = ix.parsed.info || {};
                const src = info.source || info.sourceAccount;
                const dst = info.destination || info.destinationAccount;
                if (src === fromAta.toBase58() && dst === toAta.toBase58()) {
                    if (ix.parsed.type === 'transferChecked') {
                        const tokenAmount = info.tokenAmount || {};
                        const amt = BigInt(tokenAmount.amount || '0');
                        ok = (amt === amountRaw);
                    } else {
                        const amt = BigInt(info.amount || '0');
                        ok = (amt === amountRaw);
                    }
                    if (ok) break;
                }
            }
        }
        return ok;
	} catch(e) {
		return false;
	}
}

// REST: deposit confirm
app.post('/deposit-confirm', async (req, res) => {
	try {
        const { socketId, wallet, amount, signature } = req.body || {};
		if (!socketId || !players.has(socketId)) return res.status(400).json({ error: 'invalid-socket' });
		if (!wallet || !amount || !signature) return res.status(400).json({ error: 'missing-fields' });
		if (!TOKEN_MINT || !treasury) return res.status(500).json({ error: 'server-not-configured' });
        // amount here is UI amount; convert to raw for verification
        const amountRaw = (BigInt(Math.floor(amount)) * (10n ** BigInt(isFinite(TOKEN_DECIMALS)?TOKEN_DECIMALS:6)));
        const ok = await verifyDepositSignature(signature, wallet, treasury.publicKey.toBase58(), TOKEN_MINT, amountRaw.toString());
		if (!ok) return res.status(400).json({ error: 'invalid-signature' });
		// credit game balance
		const factor = GAME_PER_TOKEN > 0 ? GAME_PER_TOKEN : 1;
		const credit = Math.floor(amount * factor);
		const p = players.get(socketId);
		p.gameBalance = (p.gameBalance || 0) + credit;
		io.to(socketId).emit('balance', { balance: p.gameBalance });
		return res.json({ ok: true, credited: credit });
	} catch(e) {
		return res.status(500).json({ error: 'deposit-failed' });
	}
});

// Create a deposit transaction that moves tokens from player to treasury
app.post('/deposit-intent', async (req, res) => {
    try {
        const { wallet, amount } = req.body || {};
        if (!wallet || !amount) return res.status(400).json({ error: 'missing-fields' });
        if (!TOKEN_MINT || !treasury) return res.status(500).json({ error: 'server-not-configured' });
        const owner = new PublicKey(wallet);
        const mintPk = new PublicKey(TOKEN_MINT);
        // ensure treasury ATA exists
        const treasuryAta = await getOrCreateAssociatedTokenAccount(connection, treasury, mintPk, treasury.publicKey);
        const fromAta = await getAssociatedTokenAddress(mintPk, owner);
        const info = await connection.getAccountInfo(fromAta);
        const tx = new Transaction();
        if (!info) {
            // add instruction to create player's ATA (wallet pays)
            tx.add(createAssociatedTokenAccountInstruction(owner, fromAta, owner, mintPk));
        }
        const raw = BigInt(Math.floor(amount)) * (10n ** BigInt(isFinite(TOKEN_DECIMALS)?TOKEN_DECIMALS:6));
        tx.add(createTransferInstruction(fromAta, treasuryAta.address, owner, raw, [], TOKEN_PROGRAM_ID));
        tx.feePayer = owner;
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        const b64 = Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64');
        return res.json({ ok: true, tx: b64 });
    } catch(e) {
        return res.status(500).json({ error: 'deposit-intent-failed' });
    }
});

// REST: withdraw
app.post('/withdraw', async (req, res) => {
	try {
		const { socketId, wallet } = req.body || {};
		if (!socketId || !players.has(socketId)) return res.status(400).json({ error: 'invalid-socket' });
		if (!wallet) return res.status(400).json({ error: 'missing-wallet' });
		if (!TOKEN_MINT || !treasury) return res.status(500).json({ error: 'server-not-configured' });
		const p = players.get(socketId);
		const gross = Math.max(0, p.gameBalance || 0);
		if (gross <= 0) return res.status(400).json({ error: 'no-balance' });
		const fee = toBps(gross, FEE_BPS);
		const netGame = gross - fee;
    const tokensUi = Math.floor(netGame / (GAME_PER_TOKEN > 0 ? GAME_PER_TOKEN : 1));
    if (tokensUi <= 0) return res.status(400).json({ error: 'too-small' });
    // transfer SPL tokens from treasury to user (respect token decimals)
		const mintPk = new PublicKey(TOKEN_MINT);
		const destOwner = new PublicKey(wallet);
    const fromAta = await getOrCreateAssociatedTokenAccount(connection, treasury, mintPk, treasury.publicKey);
    const toAta = await getOrCreateAssociatedTokenAccount(connection, treasury, mintPk, destOwner);
    const amountRaw = BigInt(tokensUi) * (10n ** BigInt(TOKEN_DECIMALS));
    const ix = createTransferInstruction(fromAta.address, toAta.address, treasury.publicKey, amountRaw, [], TOKEN_PROGRAM_ID);
    const tx = new Transaction().add(ix);
		tx.feePayer = treasury.publicKey;
		tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const sig = await sendAndConfirmTransaction(connection, tx, [treasury]);
    logTx({ wallet, txSignature: sig, amount: tokensUi, amountRaw: amountRaw.toString(), fee: fee });
		p.gameBalance = 0;
		io.to(socketId).emit('balance', { balance: 0 });
    return res.json({ ok: true, signature: sig, tokens: tokensUi });
	} catch(e) {
		return res.status(500).json({ error: 'withdraw-failed' });
	}
});

io.on('connection', (socket) => {
	players.set(socket.id, { wallet: null, gameBalance: 0 });
	// send initial state
	socket.emit('welcome', { id: socket.id });
	socket.emit('balance', { balance: 0 });
	socket.emit('pellets_state', { pellets: Array.from(pellets).map(([id, p]) => Object.assign({ id }, p)) });

	// auth
	socket.on('auth', (payload) => {
		if (payload && payload.wallet) {
			const p = players.get(socket.id);
			p.wallet = payload.wallet;
		}
	});

	// spawn pellets on death (server authoritative sync)
	socket.on('spawn_pellets', (payload) => {
		if (!payload || !Array.isArray(payload.items)) return;
		// simple rate limit: max 500 per request
		const items = payload.items.slice(0, 500);
		const created = [];
		for (const it of items) {
			if (!it || typeof it.x !== 'number' || typeof it.y !== 'number') continue;
			const id = it.id || (Math.random().toString(36).slice(2));
			const val = (typeof it.value === 'number' && it.value > 0) ? it.value : 1;
			pellets.set(id, { x: it.x, y: it.y, value: val });
			created.push({ id, x: it.x, y: it.y, value: val });
		}
		if (created.length > 0) {
			console.log('[SPAWN_PELLETS]', 'count=', created.length);
			io.emit('pellets_added', { pellets: created });
		}
	});

	// pickup pellet request
	socket.on('pickup_pellet', (payload) => {
		if (!payload || !payload.id) return;
		const p = pellets.get(payload.id);
		if (!p) return;
		pellets.delete(payload.id);
		const player = players.get(socket.id);
		player.gameBalance = (player.gameBalance || 0) + (p.value || 1);
		socket.emit('balance', { balance: player.gameBalance });
		io.emit('pellets_removed', { ids: [payload.id] });
	});

	socket.on('disconnect', () => {
		players.delete(socket.id);
	});
});

server.listen(PORT, () => {
	console.log('Server listening on', PORT);
});


