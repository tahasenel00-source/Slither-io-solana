'use strict';

require('dotenv').config();
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');

async function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const RPC_URL = process.env.RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
  const conn = new Connection(RPC_URL, 'confirmed');

  const to = process.argv[2];
  const sol = parseFloat(process.argv[3] || '1');
  if (!to) { console.error('Usage: node scripts/airdrop_devnet.js <PUBKEY> [SOL]'); process.exit(1); }

  const pk = new PublicKey(to);
  console.log('RPC_URL =', RPC_URL);
  console.log('Airdrop request:', sol, 'SOL ->', pk.toBase58());

  let ok = false; let lastSig = null;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      lastSig = await conn.requestAirdrop(pk, Math.max(1, Math.floor(sol * 1e9))); // LAMPORTS_PER_SOL
      try { await conn.confirmTransaction(lastSig, 'confirmed'); } catch(e) {}
      // wait for balance
      for (let i = 0; i < 10; i++) {
        const bal = await conn.getBalance(pk);
        if (bal > 0) { ok = true; break; }
        await sleep(500);
      }
      if (ok) break;
    } catch (e) {
      const backoff = Math.min(4000, 500 * (2 ** (attempt - 1)));
      console.warn('Airdrop attempt', attempt, 'failed. Retrying in', backoff, 'ms');
      await sleep(backoff);
    }
  }

  if (!ok) {
    console.error('Airdrop failed. Last signature:', lastSig || '(none)');
    process.exit(2);
  }

  const final = await conn.getBalance(pk);
  console.log('Airdrop SUCCESS. Balance =', final / LAMPORTS_PER_SOL, 'SOL');
})();



