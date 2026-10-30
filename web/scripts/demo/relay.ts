import {WebSocketServer} from 'ws';
import {matchFilters} from 'nostr-tools';
import {stateFile} from './state.ts';
import {verifiedPrivateEvent} from '../../src/messaging/transport.ts';

/** Optionally durable, loopback-only demo relay. It never forwards events anywhere. */
export async function startDemoRelay(port = 4787,{stateDir,allowedOrigin}:{stateDir?:string;allowedOrigin?:string}={}) {
  const disk=stateDir?await stateFile(stateDir,'relay.json',32*1024*1024):undefined;
  const events = new Map(), clients = new Map();
  const expired=event=>event.tags.some(tag=>tag[0]==='expiration'&&Number(tag[1])<=Date.now()/1000);
  const prune=()=>{for(const [id,event] of events)if(expired(event))events.delete(id);while(events.size>8000||Buffer.byteLength(JSON.stringify([...events.values()]))>30*1024*1024)events.delete(events.keys().next().value);};
  for(const raw of (await disk?.read())??[]){const event=verifiedPrivateEvent(raw);if(event&&!expired(event))events.set(event.id,event);}
  prune();await disk?.write([...events.values()]);
  let writes=Promise.resolve();
  const server = new WebSocketServer({host:'127.0.0.1',port,maxPayload:256*1024});
  server.on('connection', (socket, request) => {
    const origin = request.headers.origin;
    if(!/^(127\.0\.0\.1|localhost):\d+$/.test(request.headers.host??'')){socket.close();return;}
    if(origin&&allowedOrigin&&origin!==allowedOrigin){socket.close();return;}
    if (origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) {socket.close();return;}
    const subscriptions = new Map();clients.set(socket,subscriptions);
    socket.on('error',()=>{});
    socket.on('close',()=>clients.delete(socket));
    const send = frame => {if(socket.readyState===1)socket.send(JSON.stringify(frame));};
    socket.on('message', raw => {
      writes=writes.then(async()=>{
      try {
        const [type,id,...filters] = JSON.parse(raw.toString());
        if(type==='CLOSE'){subscriptions.delete(id);return;}
        if(type==='REQ') {
          if(typeof id!=='string'||filters.length>16||subscriptions.size>=128)return;
          subscriptions.set(id,filters);
          prune();const candidates=[...events.values()].sort((a,b)=>b.created_at-a.created_at);
          const sent=new Set();
          for(const filter of filters)for(const event of candidates.filter(event=>matchFilters([filter],event)).slice(0,Math.min(filter.limit??2000,2000))) {
            if(!sent.has(event.id)){send(['EVENT',id,event]);sent.add(event.id);}
          }
          send(['EOSE',id]);return;
        }
        if(type!=='EVENT')return;
        const event=verifiedPrivateEvent(id);
        if(!event||expired(event)){send(['OK',id?.id??'',false,'invalid event']);return;}
        if(!events.has(event.id)) {
          const previous=new Map(events);events.set(event.id,event);
          prune();try{await disk?.write([...events.values()]);}catch(error){events.clear();for(const [key,value] of previous)events.set(key,value);throw error;}
          for(const [client,active] of clients)if(client.readyState===1)for(const [sub,query] of active)if(matchFilters(query,event))client.send(JSON.stringify(['EVENT',sub,event]));
        }
        send(['OK',event.id,true,'']);
      } catch { /* Failed writes never receive a successful acknowledgement. */ }
      });
    });
  });
  await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  return {url:`ws://127.0.0.1:${(server.address() as {port:number}).port}`,eventCount:()=>events.size,
    close:async()=>{await writes;return new Promise<void>(resolve=>{for(const socket of clients.keys())socket.terminate();server.close(()=>resolve());});}};
}
