/** Documented Cashu FakeWallet mint: its tokens are unbacked test money. */
export const TEST_MINT = 'https://testnut.cashu.space';
export const DEFAULT_SUPPORTED_MINTS = ['https://mint.coinos.io', TEST_MINT];
/** Only an explicit local developer configuration may enable this address. */
export function localTestMint(value:unknown):string {
  if(typeof value!=='string')throw new Error('Invalid local test mint.');
  const url=new URL(value);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('Local test mint must be an explicit HTTP 127.0.0.1 port.');
  return url.origin;
}
export function configuredLocalTestMint(doc=globalThis.document,location=globalThis.location):string|undefined {
  if(!location||!['localhost','127.0.0.1','[::1]'].includes(location.hostname))return;
  const value=doc?.documentElement?.dataset?.demoMint;if(!value)return;
  try{return localTestMint(value);}catch{return;}
}
export const isTestMint = (mint:string) => {if(mint.replace(/\/+$/, '')===TEST_MINT)return true;try{return localTestMint(mint)===mint.replace(/\/+$/, '');}catch{return false;}};
export const mintUnitLabel = (mint:string) => isTestMint(mint) ? 'test sats' : 'sats';
