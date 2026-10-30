import {createMessaging} from '../../src/messaging/client.ts';
import {createVault,type VaultRow} from '../../src/messaging/vault.ts';
import {orderContext} from '../../src/message-context.ts';
import {listingURL} from '../../src/routes.ts';
import {DEMO_SCENARIOS,simulationAt} from './simulation.ts';
import {persistentVaultBackend} from './state.ts';
import {demoReply} from './replies.ts';
import {demoListingDraft,DEMO_RENEW_AFTER} from './listings.ts';
import {createTestMoney,TEST_MINT} from './test-money.ts';
import {join} from 'node:path';
import {localTestMint} from '../../src/wallet/mints.ts';
import {privateRelayUrls} from '../../src/messaging/transport.ts';

type Client = ReturnType<typeof createMessaging>;
type Kind = 'product'|'delivery'|'ride';
type DemoMoney = {validatePayment?:(token:string,amount:string)=>void;grant:(id:string,amount?:string)=>Promise<{token:string;mint:string;amount:string;unit:'sat'}>;redeem:(id:string,token:string,amount:string)=>Promise<unknown>;close:()=>Promise<void>};
const now = () => Math.floor(Date.now()/1000);

/** Real signed listings, private orders and NDR chat; only the journeys are simulated. */
export async function startDemoActors({relay,publicRelays,origin,durationMs=120000,model='',tickMs=2000,stateDir,password,modelReady=()=>true,moneyFactory,clockMs=Date.now,mintUrl=TEST_MINT}:{relay?:string;publicRelays?:string[];origin:string;durationMs?:number;model?:string;tickMs?:number;stateDir?:string;password?:string;modelReady?:()=>boolean;moneyFactory?:(name:string,vault:any)=>Promise<DemoMoney>;clockMs?:()=>number;mintUrl?:string}) {
  const publicMode=publicRelays!==undefined;
  if(publicMode&&(relay||!stateDir||new URL(origin).origin!=='https://market.iris.to'))throw new Error('Public demos require their own persistent state and Market origin.');
  const relays=publicMode?privateRelayUrls(publicRelays):[relay!];
  if(publicMode&&relays.some(value=>new URL(value).protocol!=='wss:'))throw new Error('Public demos require secure public relays.');
  if(!publicMode&&!/^ws:\/\/127\.0\.0\.1:\d+$/.test(relay??''))throw new Error('Local demo actors require a loopback relay.');
  if(stateDir&&(!password||password.length<8))throw new Error('Persistent demos require a vault password.');
  if(publicMode&&mintUrl!==TEST_MINT)throw new Error('Public demos require the public test mint.');
  if(!publicMode&&!moneyFactory)localTestMint(mintUrl);
  const developerMint=!publicMode&&mintUrl!==TEST_MINT?localTestMint(mintUrl):undefined;
  const vaults=[];
  const monies:DemoMoney[]=[];
  const clients:Client[]=[], journeys=new Map(), answered=new Set<string>(), replyTimes=new Map<string,number>();
  const abort=new AbortController();let closing=false,busy=false,replyBusy=false;
  const replies:Array<{client:Client;peer:string;text:string;context:any;role:string}>=[];
  const errors:string[]=[];
  const replyStatistics:{ollama:number;scripted:number;lastLatencyMs?:number;lastSource?:string}={ollama:0,scripted:0};
  try {
  async function actor(name:string) {
    let row:VaultRow|undefined;
    const vault=createVault({backend:stateDir?await persistentVaultBackend(stateDir,name.replaceAll(' ','-')+'.json'):{read:async()=>structuredClone(row),write:async value=>{row=structuredClone(value);}}});
    vaults.push(vault);const client=createMessaging({getRelays:()=>relays,vault,developerMint});
    clients.push(client);if((await vault.status()).exists){await client.restore();await client.unlock(password);}else {await client.createAccount({password:stateDir?password:undefined});if(!publicMode)await client.updateProfile({name});}return client;
  }
  const shop=await actor('Demo shop'),drone=await actor('Demo drone'),driver=await actor('Demo driver');
  const sellers=[{kind:'product' as Kind,client:shop,courier:shop,title:'Demo imaginary parcel',id:'demo-drone-delivery',price:'16'},
    {kind:'delivery' as Kind,client:drone,courier:drone,title:'Demo courier · Helsinki',id:'demo-courier',price:'8'},
    {kind:'ride' as Kind,client:driver,courier:driver,title:'Demo ride · Helsinki',id:'demo-ride',price:'8'}];
  for(const [index,name] of ['shop','drone','driver'].entries())monies.push(moneyFactory?await moneyFactory(name,vaults[index]):await createTestMoney({mintUrl,directory:stateDir?join(stateDir,name+'-money'):undefined,password:password??'',vault:vaults[index]}));
  const granted=new Set<string>(),paymentRetries=new Map<string,{attempt:number;nextAt:number}>();
  const saved=await vaults[0].get('demo/runtime');
  for(const id of saved?.granted??[])granted.add(id);
  for(const [id,value] of (saved?.paymentRetries??[]).slice(0,8))if(typeof id==='string'&&Number.isFinite(value?.nextAt)&&Number.isFinite(value?.attempt))paymentRetries.set(id,value);
  for(const id of saved?.answered??[])answered.add(id);
  for(const [key,time] of saved?.replyTimes??[])if(time>now()-60)replyTimes.set(key,time);
  for(const item of saved?.replies??[]){const client=clients[item.actor];if(client)replies.push({...item,client});}
  for(const item of saved?.journeys??[]){const seller=sellers.find(value=>value.kind===item.kind);if(seller&&seller.kind!=='product'&&seller.client.state().orders.some(order=>order.id===item.id&&order.seller===seller.client.state().ownerPubkey&&order.payment?.status==='received'&&!['cancelled','delivered'].includes(order.status))&&Number.isFinite(item.start))journeys.set(item.id,{seller,start:item.start,stage:item.stage});}
  let persistedRuntime=JSON.stringify(saved??null);
  const persist=()=>{
    const value={paymentRetries:[...paymentRetries].slice(0,8),granted:[...granted].slice(-2000),answered:[...answered].slice(-2000),replyTimes:[...replyTimes].filter(([,time])=>time>now()-60).slice(-500),replies:replies.slice(0,8).map(({client,...item})=>({...item,actor:clients.indexOf(client)})),journeys:[...journeys].slice(0,8).map(([id,item])=>({id,kind:item.seller.kind,start:item.start,stage:item.stage}))};
    const encoded=JSON.stringify(value);if(encoded===persistedRuntime)return Promise.resolve();
    persistedRuntime=encoded;return vaults[0].put('demo/runtime',value).catch(error=>{persistedRuntime='';throw error;});
  };
  const listings=[];
  let lastPublished=0,nextPublicationAttempt=0,publishing=false;
  async function publishListings() {
  if(publishing||closing)return;publishing=true;
  try {
  if(publicMode)for(const [index,client] of clients.entries()) {
    const name=['Demo shop','Demo drone','Demo driver'][index];
    await client.publishEvent({kind:0,created_at:now(),tags:[],content:JSON.stringify({name,display_name:name,bot:true,website:origin,picture:`${origin}/demo-${index===2?'ride':'delivery'}.svg`,about:'Automated Iris Market transport demo. Simulated products and journeys with test Cashu payments. Test sats have no monetary value. Try it at https://market.iris.to.'})});
  }
  for(const seller of sellers) {
    const author=seller.client.state().ownerPubkey!;
    const event=await seller.client.publishEvent(demoListingDraft(seller.kind,now(),publicMode));
    const url=new URL(listingURL(`${author}:${seller.id}`,origin));if(!publicMode)url.searchParams.set('test-relay',relay);
    const entry={kind:seller.kind,title:seller.title,url:url.href,event:event.event};
    const index=listings.findIndex(item=>item.kind===seller.kind);if(index===-1)listings.push(entry);else listings[index]=entry;
  }
  lastPublished=now();
  }finally{publishing=false;}
  }
  await publishListings();
  async function speak(client:Client,peer:string,text:string,id:string) {await client.send(peer,text,orderContext(id));}
  async function tick() {
    if(closing||busy)return;busy=true;
    let processing:{client:Client;id:string}|undefined;
    try {
      if(publicMode&&now()-lastPublished>=DEMO_RENEW_AFTER&&now()>=nextPublicationAttempt){
        nextPublicationAttempt=now()+300;
        try{await publishListings();}catch{errors.push('Demo listing renewal is waiting for a connection.');if(errors.length>10)errors.shift();}
      }
      for(const seller of sellers)for(const order of seller.client.state().orders) {
        processing={client:seller.client,id:order.id};
        if(order.seller!==seller.client.state().ownerPubkey||order.items[0]?.id!==`${order.seller}:${seller.id}`)continue;
        if(['cancelled','delivered'].includes(order.status)){journeys.delete(order.id);continue;}
        if(order.items.length!==1||order.items[0].price!==seller.price||order.items[0].currency!=='TESTSAT'||order.items[0].quantity!==1){
          if(order.status==='requested'){await seller.client.updateOrder(order.id,{status:'cancelled'});await speak(seller.client,order.buyer,'Please request one demo at its listed test-sat price.',order.id);}continue;
        }
        if(order.status==='requested'){
          if(seller.kind==='delivery'&&!order.deliveryRequest){await seller.client.updateOrder(order.id,{status:'cancelled'});await speak(seller.client,order.buyer,'Choose pickup and destination when requesting this courier.',order.id);continue;}
          const money=monies[clients.indexOf(seller.client)];
          if(!order.payment){await seller.client.updateOrder(order.id,{payment:{mint:mintUrl,amount:seller.price,unit:'sat',status:'requested'}});}
          if(!granted.has(order.id)){
            const outstanding=clients.flatMap(client=>client.state().orders).filter(item=>item.seller===clients.find(client=>client.state().ownerPubkey===item.seller)?.state().ownerPubkey&&item.status==='requested'&&granted.has(item.id));
            if(outstanding.length>=8)continue;
            const grant=await money.grant(order.id,'128');
            await speak(seller.client,order.buyer,`Test money only — no monetary value. Receive these 128 test sats in your Cashu wallet, then pay this order's ${seller.price} test sats: ${grant.token}`,order.id);
            granted.add(order.id);await persist();
          }
          if(seller.client.state().orders.find(item=>item.id===order.id)?.payment?.status!=='received')continue;
          if(seller.kind!=='product'&&(journeys.size>=8||(publicMode&&[...journeys].some(([id,item])=>item.seller.client.state().orders.find(value=>value.id===id)?.buyer===order.buyer))))continue;
          await seller.client.updateOrder(order.id,{status:'accepted'});
        }
        if(seller.kind==='product'){
          if(!order.shipment.stops.length){const pickup=DEMO_SCENARIOS.delivery.pickup;await seller.client.updateOrder(order.id,{shipment:{stops:[{id:pickup.id,label:'Collect imaginary parcel',address:pickup.name,coordinates:pickup.coordinates,status:'pending'}]}});await speak(seller.client,order.buyer,'Test payment received. Your imaginary parcel is ready for collection. Choose Arrange delivery to hire a courier separately.',order.id);}continue;
        }
        if(order.payment?.status!=='received')continue;
        let journey=journeys.get(order.id);
        if(!journey) {
          if(journeys.size>=8)continue;
          if(publicMode&&[...journeys].some(([id,item])=>item.seller.client.state().orders.find(value=>value.id===id)?.buyer===order.buyer))continue;
          if(order.status==='requested')await seller.client.updateOrder(order.id,{status:'accepted'});
          const scenario=scenarioFor(seller.kind,order), frame=simulationAt(scenario,0,durationMs);
          const existing=order.shipment.stops.length>0;
          if(!existing)await seller.client.updateOrder(order.id,{shipment:{eta:now()+Math.ceil(durationMs/1000),stops:frame.stops.map(stop=>({id:stop.id,label:stop.kind==='pickup'?(seller.kind==='ride'?'Pick up passenger':'Collect parcel'):(seller.kind==='ride'?'Drop off passenger':'Deliver parcel'),address:stop.name,coordinates:stop.coordinates,status:'pending',courierPubkey:seller.courier.state().ownerPubkey}))}});
          journey={seller,start:existing&&order.shipment.eta?(order.shipment.eta*1000-durationMs):clockMs(),stage:existing?'restored':''};journeys.set(order.id,journey);await persist();
          if(!existing)await speak(seller.client,order.buyer,seller.kind==='ride'?'Test payment received. Demo ride accepted. Your simulated driver is on the way.':'Test payment received. The simulated courier will collect your imaginary parcel.',order.id);
        }
        const courier=seller.courier, courierOrder=courier.state().orders.find(item=>item.id===order.id);
        if(!courierOrder?.routeId)continue;
        const frame=simulationAt(scenarioFor(seller.kind,order),clockMs()-journey.start,durationMs);
        for(const stop of frame.stops) {
          const current=courier.state().orders.find(item=>item.id===order.id)?.shipment.stops.find(item=>item.id===stop.id);
          if(current&&['pending','arrived','completed'].indexOf(current.status)<['pending','arrived','completed'].indexOf(stop.status))await courier.updateOrder(order.id,{stopId:stop.id,status:stop.status});
        }
        // Let the seller receive courier stop changes before its next snapshot.
        // Otherwise a status update could overwrite the newer stop projection.
        if(seller.client.state().orders.find(item=>item.id===order.id)?.shipment.stops.some(stop=>frame.stops.find(item=>item.id===stop.id)?.status!==stop.status))continue;
        if(frame.stage!==journey.stage) {
          journey.stage=frame.stage;await persist();
          const text=frame.stage==='pickup'?(seller.kind==='ride'?'Simulation: I am at the pickup. Boarding now.':'Simulation: collecting your parcel.'):
            frame.stage==='to_dropoff'?(seller.kind==='ride'?'Simulation: you are on board. Follow the ride on the map.':'Simulation: your parcel is airborne. Follow the drone on the map.'):
            frame.stage==='complete'?(seller.kind==='ride'?'Demo ride complete. Thanks for trying it—no actual trip took place.':'Demo delivery complete. Your imaginary parcel has landed.'):
            seller.kind==='ride'?'Simulation: driving to the pickup.':'Simulation: flying to collect your parcel.';
          await speak(courier,order.buyer,text,order.id);
          if(frame.stage==='to_dropoff')await seller.client.updateOrder(order.id,{status:'in-transit'});
        }
        if(frame.stage==='complete') {
          await seller.client.updateOrder(order.id,{status:'delivered'});journeys.delete(order.id);
        } else await courier.updateOrder(order.id,{location:{coordinates:frame.position,stopId:frame.activeStopId}});
      }
      const botKeys=new Set(clients.map(client=>client.state().ownerPubkey));
      for(const [client,role] of [[shop,'demo shop'],[drone,'simulated drone operator'],[driver,'simulated driver']] as const)for(const thread of client.state().conversations) {
        if(botKeys.has(thread.pubkey))continue;
        for(const message of thread.messages) {
          if(message.mine||message.system||answered.has(message.id))continue;
          const token=message.text.match(/cashu[AB][A-Za-z0-9_-]+/);
          if(token){
            const order=client.state().orders.find(value=>value.id===message.context?.order_id&&value.buyer===thread.pubkey&&value.seller===client.state().ownerPubkey);
            if(!order)continue;
            if(order.payment?.status==='received'||['cancelled','delivered'].includes(order.status)){paymentRetries.delete(message.id);answered.add(message.id);continue;}
            if(order.payment?.status!=='requested'||order.status!=='requested')continue;
            const money=monies[clients.indexOf(client)],retry=paymentRetries.get(message.id);
            if((retry&&retry.nextAt>Date.now())||(!retry&&paymentRetries.size>=8))continue;
            try{money.validatePayment?.(token[0],order.payment.amount);}catch{
              paymentRetries.delete(message.id);answered.add(message.id);await persist();
              await speak(client,thread.pubkey,'That test payment could not be verified. Use the requested mint and exact amount.',order.id);continue;
            }
            try{
              await money.redeem(order.id,token[0],order.payment.amount);
              await client.updateOrder(order.id,{payment:{...order.payment,status:'received'}});
              paymentRetries.delete(message.id);answered.add(message.id);await persist();
              await speak(client,thread.pubkey,'Test Cashu payment verified and received.',order.id);
            }catch{
              // Mint swaps and the received-order projection each have durable,
              // idempotent recovery. Never consume the message on transient failure.
              if(client.state().orders.find(value=>value.id===order.id)?.payment?.status==='received'){paymentRetries.delete(message.id);answered.add(message.id);}
              else {const attempt=Math.min(8,(retry?.attempt??0)+1);paymentRetries.set(message.id,{attempt,nextAt:Date.now()+Math.min(30000,250*2**attempt)});}
              await persist();
            }
            continue;
          }
          if(publicMode&&(message.createdAt<now()-600||message.createdAt>now()+60))continue;
          if(publicMode&&(replyTimes.get(thread.pubkey)??0)>now()-15){answered.add(message.id);continue;}
          if(replies.length<8){
            replies.push({client,peer:thread.pubkey,text:message.text,context:message.context,role});
            if(publicMode)replyTimes.set(thread.pubkey,now());
            answered.add(message.id);while(answered.size>2000)answered.delete(answered.values().next().value!);
          }
        }
      }
      for(const id of paymentRetries.keys())if(!clients.some(client=>client.state().conversations.some(thread=>thread.messages.some(message=>message.id===id))))paymentRetries.delete(id);
      while(answered.size>2000)answered.delete(answered.values().next().value!);
      for(const [key,time] of replyTimes)if(time<now()-60)replyTimes.delete(key);
      await persist();void answer();
    }catch(error){
      const status=processing?.client.state().orders.find(order=>order.id===processing.id)?.status;
      // Cancellation can arrive during an awaited update. The reducer rejects
      // further movement; that expected race is not a failed simulation.
      if(processing&&['cancelled','delivered'].includes(status))journeys.delete(processing.id);
      else {errors.push(error instanceof Error?error.message:String(error));if(errors.length>10)errors.shift();}
    }
    finally {busy=false;}
  }
  async function answer() {
    if(replyBusy||closing)return;replyBusy=true;
    try {while(replies.length&&!closing) {
      const item=replies[0]!;
      const replyStarted=Date.now();
      const result=await demoReply({model:modelReady()?model:'',prompt:`You are the ${item.role}. Answer this visitor's message about the simulated journey: ${item.text}`,fallback:'This is a simulation. Buy the imaginary parcel, then arrange a separate courier, or request a demo ride. Payments use test Cashu sats with no monetary value.',signal:abort.signal});
      replyStatistics[result.source]++;replyStatistics.lastSource=result.source;replyStatistics.lastLatencyMs=Date.now()-replyStarted;
      if(!closing){await item.client.send(item.peer,result.text,item.context);replies.shift();await persist();}
    }}catch(error){if(!closing){errors.push(error instanceof Error?error.message:String(error));if(errors.length>10)errors.shift();}}finally{replyBusy=false;}
  }
  const timer=setInterval(()=>void tick(),tickMs);await tick();
  return {listings,clients,errors,replyStats:()=>({...replyStatistics}),active:()=>journeys.size,
    async close(){closing=true;clearInterval(timer);abort.abort();while(busy||replyBusy||publishing)await new Promise(resolve=>setTimeout(resolve,10));await persist();await Promise.all(monies.map(money=>money.close()));await Promise.all(clients.map(client=>client.destroy()));}};
  }catch(error){abort.abort();await Promise.allSettled(monies.map(money=>money.close()));await Promise.allSettled(clients.map(client=>client.destroy()));throw error;}
}

function scenarioFor(kind:'delivery'|'ride',order:any) {
  const base=DEMO_SCENARIOS[kind],request=order.deliveryRequest;
  if(!request)return base;
  return {...base,pickup:{...base.pickup,name:request.pickup.address,coordinates:request.pickup.coordinates??base.pickup.coordinates},dropoff:{...base.dropoff,name:request.destination.address,coordinates:request.destination.coordinates??base.dropoff.coordinates}};
}
