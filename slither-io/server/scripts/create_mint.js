'use strict';

require('dotenv').config();
const { Connection, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { createMint, getOrCreateAssociatedTokenAccount, mintTo } = require('@solana/spl-token');

function loadTreasury() {
	const sec = process.env.TREASURY_SECRET_KEY;
	if (!sec) throw new Error('Missing TREASURY_SECRET_KEY in .env');
	if (sec.trim().startsWith('[')) {
		return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(sec)));
	}
	return Keypair.fromSecretKey(Buffer.from(sec, 'base64'));
}

(async () => {
	const RPC_URL = process.env.RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
	const DECIMALS = parseInt(process.env.TOKEN_DECIMALS || process.argv[2] || '6', 10);
	const INITIAL = parseFloat(process.argv[3] || '0');
	const conn = new Connection(RPC_URL, 'confirmed');
	const treasury = loadTreasury();

	async function airdropAndConfirm(pubkey, sol) {
		try {
			const sig = await conn.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
			try { await conn.confirmTransaction(sig, 'confirmed'); } catch(e) {}
			for (let i = 0; i < 20; i++) {
				try {
					const bal = await conn.getBalance(pubkey);
					if (bal > 0) return true;
				} catch(e) {}
				await new Promise(r => setTimeout(r, 500));
			}
			return false;
		} catch(e) { return false; }
	}

	await airdropAndConfirm(treasury.publicKey, 2);

	const mintPk = await createMint(conn, treasury, treasury.publicKey, null, DECIMALS);
	console.log('TOKEN_MINT=' + mintPk.toString());

	if (INITIAL > 0) {
		const ata = await getOrCreateAssociatedTokenAccount(conn, treasury, mintPk, treasury.publicKey);
		const amountRaw = BigInt(Math.floor(INITIAL)) * (10n ** BigInt(DECIMALS));
		await mintTo(conn, treasury, mintPk, ata.address, treasury.publicKey, amountRaw);
		console.log('Minted', INITIAL, 'to', ata.address.toBase58());
	}
})().catch((e) => { console.error(e); process.exit(1); });
