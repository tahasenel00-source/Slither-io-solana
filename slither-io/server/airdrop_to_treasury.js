// scripts/airdrop_to_treasury.js
const { Connection, clusterApiUrl, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');

(async () => {
  try {
    const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');

    // kendi treasury public key'ini buraya yaz
    const treasuryPubkey = new PublicKey('FFm3B77PDJbqcLogCFXGtnSSCjBSc62zoKGtsY5ejPVF');
    
    console.log('Requesting airdrop to:', treasuryPubkey.toBase58());
    const sig = await connection.requestAirdrop(treasuryPubkey, 1 * LAMPORTS_PER_SOL);
    console.log('Airdrop transaction sent:', sig);

    await connection.confirmTransaction(sig, 'confirmed');
    console.log('✅ Airdrop confirmed! 1 SOL sent to treasury address.');
  } catch (err) {
    console.error('❌ Hata:', err);
  }
})();
    