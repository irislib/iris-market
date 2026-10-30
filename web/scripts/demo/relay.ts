import {WebSocketServer} from 'ws';
import {matchFilters} from 'nostr-tools';
import {verifiedPrivateEvent} from '../../src/messaging/transport.ts';

/** In-memory, loopback-only demo relay. It never forwards events anywhere. */
export async function startDemoRelay(port = 4787) {
  const server = new WebSocketServer({host:'127.0.0.1',port,maxPayload:256*1024});
  const events = new Map(), clients = new Map();
  server.on('connection', (socket, request) => {
    const origin = request.headers.origin;
    if (origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) {socket.close();return;}
    const subscriptions = new Map();clients.set(socket,subscriptions);
    socket.on('error',()=>{});
    socket.on('close',()=>clients.delete(socket));
    const send = frame => {if(socket.readyState===1)socket.send(JSON.stringify(frame));};
    socket.on('message', raw => {
      try {
        const [type,id,...filters] = JSON.parse(raw.toString());
        if(type==='CLOSE'){subscriptions.delete(id);return;}
        if(type==='REQ') {
          if(typeof id!=='string'||filters.length>16||subscriptions.size>=128)return;
          subscriptions.set(id,filters);
          const candidates=[...events.values()].sort((a,b)=>b.created_at-a.created_at);
          const sent=new Set();
          for(const filter of filters)for(const event of candidates.filter(event=>matchFilters([filter],event)).slice(0,Math.min(filter.limit??2000,2000))) {
            if(!sent.has(event.id)){send(['EVENT',id,event]);sent.add(event.id);}
          }
          send(['EOSE',id]);return;
        }
        if(type!=='EVENT')return;
        const event=verifiedPrivateEvent(id);
        if(!event){send(['OK',id?.id??'',false,'invalid event']);return;}
        if(!events.has(event.id)) {
          events.set(event.id,event);
          while(events.size>8000)events.delete(events.keys().next().value);
          for(const [client,active] of clients)if(client.readyState===1)for(const [sub,query] of active)if(matchFilters(query,event))client.send(JSON.stringify(['EVENT',sub,event]));
        }
        send(['OK',event.id,true,'']);
      } catch { /* Malformed frames do not affect other local clients. */ }
    });
  });
  await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  return {url:`ws://127.0.0.1:${(server.address() as {port:number}).port}`,eventCount:()=>events.size,
    close:()=>new Promise<void>(resolve=>{for(const socket of clients.keys())socket.terminate();server.close(()=>resolve());})};
}
