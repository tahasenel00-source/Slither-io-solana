'use strict';

const { Keypair } = require('@solana/web3.js');

const kp = Keypair.generate();
const secretArray = Array.from(kp.secretKey);
console.log('TREASURY_SECRET_KEY=' + JSON.stringify(secretArray));
console.log('TREASURY_PUBKEY=' + kp.publicKey.toString());

