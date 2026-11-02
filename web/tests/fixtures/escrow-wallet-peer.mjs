// Interoperability peer for the isolated CDK mint. Never opens a real wallet or public mint.
import {createInterface} from 'node:readline';
import {localTestMint} from '../../src/wallet/mints.ts';
import {createVault} from '../../src/messaging/vault.ts';
import {createCashuWallet} from '../../src/wallet/client.ts';
const mint=localTestMint(process.env.MARKET_ESCROW_TEST_MINT);
let row;
const backend={read:async()=>structuredClone(row),write:async(next,expected)=>{
  if((row?.version||0)!==expected)throw Error('Stale wallet write');
  row=structuredClone(next);
}};
const wallet=createCashuWallet({developerMint:mint,allowedMints:[mint],vault:createVault({backend})});
await wallet.enable({mintUrl:mint});
try {
  for await(const line of createInterface({input:process.stdin,terminal:false})) {
    try {
      const request=JSON.parse(line);
      let response;
      if(request.op==='topup_fixture') {
        const previous=Number(wallet.state().balance);
        const quote=await wallet.createInvoice(request.amount),until=Date.now()+20000;
        while(Number(wallet.state().balance)===previous){
          if(Date.now()>=until)throw Error('Local test top-up timeout');
          await new Promise(resolve=>setTimeout(resolve,100));
          await wallet.checkInvoice(quote.id);
        }
        response={balance:Number(wallet.state().balance)};
      } else if(request.op==='balance_fixture') response={balance:Number(wallet.state().balance)};
      else response=await wallet.escrow(request);
      process.stdout.write(JSON.stringify(response)+'\n');
    } catch(error) {
      process.stdout.write(JSON.stringify({error:error.message})+'\n');
    }
  }
} finally { await wallet.destroy(); }
