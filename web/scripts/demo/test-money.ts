import {createVault} from '../../src/messaging/vault.ts';
import type {Vault} from '../../src/messaging/vault.ts';
import {createCashuWallet} from '../../src/wallet/client.ts';
import {getTokenMetadata} from '../../src/wallet/sdk.ts';
import {TEST_MINT,localTestMint} from '../../src/wallet/mints.ts';
import {persistentVaultBackend} from './state.ts';
export {TEST_MINT};
const boundedAmount=(value:unknown)=>{const text=String(value);if(!/^[1-9]\d{0,3}$/.test(text)||BigInt(text)>1024n)throw new Error('Demo amount must be between 1 and 1024 test sats.');return text;};
const orderKey=async(orderId:string)=>{if(typeof orderId!=='string'||!orderId.length||orderId.length>256)throw new Error('Invalid demo order.');return Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(orderId))).toString('hex');};
/** Only a documented unbacked FakeWallet mint. All value movement uses the durable wallet journal. */
export async function createTestMoney({directory,password,vault,sdkFactory,mintUrl=TEST_MINT,fund}:{fund?:(orderId:string,amount:string)=>Promise<{token:string}>;mintUrl?:string;directory?:string;password?:string;vault?:Vault;sdkFactory?:Parameters<typeof createCashuWallet>[0]['sdkFactory']}) {
  const developerMint=mintUrl===TEST_MINT?undefined:localTestMint(mintUrl);mintUrl=developerMint||TEST_MINT;
  if(directory)vault=undefined;
  if(!vault){if(!directory||!password||password.length<8)throw new Error('Demo money requires private encrypted storage.');vault=createVault({backend:await persistentVaultBackend(directory,'test-money.vault')});}
  else {
    // An actor's already-unlocked messaging vault may host an isolated wallet entry.
    const parent=vault, name='demo-test-money-wallet';
    vault={...parent,status:async()=>({exists:!!await parent.get(name),locked:false,password:false}),
      create:async(initial)=>{if(await parent.get(name))throw new Error('Demo wallet already exists.');await parent.put(name,initial.wallet);},
      unlock:async()=>true,lock:()=>{},get:async<T>()=>await parent.get<T>(name),put:async(_name,value)=>parent.put(name,value)};
  }
  const wallet=createCashuWallet({vault,sdkFactory,allowedMints:[mintUrl],developerMint});
  const state=await wallet.restore();if(state.status==='disabled')await wallet.enable({mintUrl,password});else if(state.status==='locked')await wallet.unlock(password);
  if(wallet.state().selectedMint!==mintUrl)throw new Error('Demo wallet must use the test mint.');
  let queue=Promise.resolve();
  const serial=<T>(fn:()=>Promise<T>)=>{const result=queue.then(fn);queue=result.then(()=>{},()=>{});return result;};
  const validatePayment=(token:string,expectedAmount:string):void=>{
    const amount=boundedAmount(expectedAmount);
    if(typeof token!=='string'||token.length>256*1024)throw new Error('Invalid demo token.');
    const info=getTokenMetadata(token);
    if(info.mint!==mintUrl||info.unit!=='sat'||info.amount.toString()!==amount)throw new Error('Demo payment must match the test mint, unit and order amount.');
  };
  return {
    validatePayment,
    grant:(orderId:string,amount='128')=>serial(async()=>{
      amount=boundedAmount(amount);const key=await orderKey(orderId);
      // A small fixed fee allowance remains in this actor's test wallet; no real mint is contacted.
      if(fund){
        if(!developerMint)throw new Error('Custom demo funding requires the explicit local test mint.');
        const funded=await fund(orderId,String(BigInt(amount)+16n)),metadata=getTokenMetadata(funded.token);
        if(metadata.mint!==mintUrl||metadata.unit!=='sat'||metadata.amount.toString()!==String(BigInt(amount)+16n))throw new Error('Local test funding does not match the requested mint and amount.');
        await wallet.receive(funded.token,{operationId:`grant-fund:${key}`});
      } else {
      const invoice=await wallet.createInvoice(String(BigInt(amount)+16n),{invoiceId:`grant-mint:${key}`});
      for(let attempt=0;attempt<8;attempt++){
        const result=await wallet.checkInvoice(invoice.id);
        if(result.amount)break;
        if(attempt===7)throw new Error('Test mint has not issued demo credit yet. Retry this order.');
        await new Promise(resolve=>setTimeout(resolve,1500));
      }
      }
      const result=await wallet.send({amount,maxFee:'16',operationId:`grant-send:${key}`});
      if(!result.token)throw new Error('Demo grant is pending recovery. Retry this order.');
      return {token:result.token,mint:mintUrl,amount,unit:'sat' as const};
    }),
    redeem:(orderId:string,token:string,expectedAmount:string)=>serial(async()=>{
      const amount=boundedAmount(expectedAmount),key=await orderKey(orderId);
      validatePayment(token,amount);
      // receive performs a real mint swap; a payment message or unspent-state check never settles an order.
      const result=await wallet.receive(token,{operationId:`payment:${key}`});
      return {receiptId:result.id,mint:mintUrl,amount,received:result.amount,unit:'sat' as const};
    }),
    close:async()=>{await queue;await wallet.destroy();},
  };
}
export type DemoMoney=Awaited<ReturnType<typeof createTestMoney>>;
