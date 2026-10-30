import {createMessaging} from '../../src/messaging/client.ts';
import {createVault,type VaultRow} from '../../src/messaging/vault.ts';
import {orderContext} from '../../src/message-context.ts';
import {listingURL} from '../../src/routes.ts';
import {DEMO_SCENARIOS,simulationAt} from './simulation.ts';
import {demoReply} from './replies.ts';

type Client = ReturnType<typeof createMessaging>;
type Kind = 'delivery'|'ride';
const now = () => Math.floor(Date.now()/1000);

/** Real signed listings, private orders and NDR chat; only the journeys are simulated. */
export async function startDemoActors({relay,origin,durationMs=120000,model='',tickMs=2000}:{relay:string;origin:string;durationMs?:number;model?:string;tickMs?:number}) {
  if(!/^ws:\/\/127\.0\.0\.1:\d+$/.test(relay))throw new Error('Demo actors require a loopback relay.');
  const clients:Client[]=[], journeys=new Map(), answered=new Set<string>();
  const abort=new AbortController();let closing=false,busy=false,replyBusy=false;
  const replies:Array<{client:Client;peer:string;text:string;context:any;role:string}>=[];
  const errors:string[]=[];
  async function actor(name:string) {
    let row:VaultRow|undefined;
    const client=createMessaging({getRelays:()=>[relay],vault:createVault({backend:{read:async()=>structuredClone(row),write:async value=>{row=structuredClone(value);}}})});
    clients.push(client);await client.createAccount();await client.updateProfile({name});return client;
  }
  const shop=await actor('Demo shop'),drone=await actor('Demo drone'),driver=await actor('Demo driver');
  const sellers=[{kind:'delivery' as Kind,client:shop,courier:drone,title:'Demo parcel · drone delivery',id:'demo-drone-delivery'},
    {kind:'ride' as Kind,client:driver,courier:driver,title:'Demo ride · Helsinki',id:'demo-ride'}];
  const listings=[];
  for(const seller of sellers) {
    const author=seller.client.state().ownerPubkey!;
    const event=await seller.client.publishEvent({kind:30402,created_at:now(),tags:[['d',seller.id],['title',seller.title],['market','offer'],['t','transport'],['t',seller.kind==='ride'?'passenger':'parcel'],['price','0','EUR'],['location','Helsinki · simulation'],['g','ud9wr2'],['status','active']],
      content:seller.kind==='ride'?'A simulated ride from Helsinki Central Station to the waterfront. Request this free demo to follow the driver approaching, picking you up and completing the trip. No real driver, booking or payment. The route is fictional; your location is not used.':'A pretend parcel delivered by a simulated drone. Request this free demo to see the shop accept, the drone collect your parcel and its position move along the route. No real product, flight, delivery or payment. The route is fictional; your location is not used.'});
    const url=new URL(listingURL(`${author}:${seller.id}`,origin));url.searchParams.set('test-relay',relay);
    listings.push({kind:seller.kind,title:seller.title,url:url.href,event:event.event});
  }
  async function speak(client:Client,peer:string,text:string,id:string) {await client.send(peer,text,orderContext(id));}
  async function tick() {
    if(closing||busy)return;busy=true;
    let processing:{client:Client;id:string}|undefined;
    try {
      for(const seller of sellers)for(const order of seller.client.state().orders) {
        processing={client:seller.client,id:order.id};
        if(order.seller!==seller.client.state().ownerPubkey||order.items[0]?.id!==`${order.seller}:${seller.id}`)continue;
        if(['cancelled','delivered'].includes(order.status)){journeys.delete(order.id);continue;}
        let journey=journeys.get(order.id);
        if(!journey) {
          if(journeys.size>=8)continue;
          if(order.status==='requested')await seller.client.updateOrder(order.id,{status:'accepted'});
          const scenario=DEMO_SCENARIOS[seller.kind], frame=simulationAt(scenario,0,durationMs);
          await seller.client.updateOrder(order.id,{shipment:{eta:now()+Math.ceil(durationMs/1000),stops:frame.stops.map(stop=>({id:stop.id,label:stop.kind==='pickup'?(seller.kind==='ride'?'Pick up passenger':'Collect parcel'):(seller.kind==='ride'?'Drop off passenger':'Deliver parcel'),address:stop.name,coordinates:stop.coordinates,status:'pending',courierPubkey:seller.courier.state().ownerPubkey}))}});
          journey={seller,start:Date.now(),stage:'',done:new Map()};journeys.set(order.id,journey);
          await speak(seller.client,order.buyer,seller.kind==='ride'?'Demo ride accepted. Your simulated driver is on the way. Nothing is booked or charged.':'Demo order accepted. The simulated drone will collect your pretend parcel. Nothing is bought or charged.',order.id);
        }
        const courier=seller.courier, courierOrder=courier.state().orders.find(item=>item.id===order.id);
        if(!courierOrder?.routeId)continue;
        const frame=simulationAt(DEMO_SCENARIOS[seller.kind],Date.now()-journey.start,durationMs);
        for(const stop of frame.stops) {
          const current=courier.state().orders.find(item=>item.id===order.id)?.shipment.stops.find(item=>item.id===stop.id);
          if(current&&current.status!==stop.status&&stop.status!=='pending')await courier.updateOrder(order.id,{stopId:stop.id,status:stop.status});
        }
        // Let the seller receive courier stop changes before its next snapshot.
        // Otherwise a status update could overwrite the newer stop projection.
        if(seller.client.state().orders.find(item=>item.id===order.id)?.shipment.stops.some(stop=>frame.stops.find(item=>item.id===stop.id)?.status!==stop.status))continue;
        if(frame.stage!==journey.stage) {
          journey.stage=frame.stage;
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
          if(replies.length<8){
            replies.push({client,peer:thread.pubkey,text:message.text,context:message.context,role});
            answered.add(message.id);while(answered.size>2000)answered.delete(answered.values().next().value!);
          }
        }
      }
      void answer();
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
      const item=replies.shift()!;
      const result=await demoReply({model,prompt:`You are the ${item.role}. Answer this visitor's message about the simulated journey: ${item.text}`,fallback:'This is a simulation. Request a free demo order to follow the journey on the map. No payment or real delivery is involved.',signal:abort.signal});
      if(!closing)await item.client.send(item.peer,result.text,item.context);
    }}catch(error){if(!closing){errors.push(error instanceof Error?error.message:String(error));if(errors.length>10)errors.shift();}}finally{replyBusy=false;}
  }
  const timer=setInterval(()=>void tick(),tickMs);await tick();
  return {listings,clients,errors,active:()=>journeys.size,
    async close(){closing=true;clearInterval(timer);abort.abort();await Promise.all(clients.map(client=>client.destroy()));}};
}
