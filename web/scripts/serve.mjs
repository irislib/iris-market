import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
const port=Number(process.env.PORT||4173);
const base=resolve(import.meta.dirname,process.env.MARKET_SITE==='downloads'?'../../site/dist':'../dist');
const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json'};
const server=http.createServer(async(req,res)=>{try{const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const target=resolve(base,'.'+(name==='/'?'/index.html':name));if(!target.startsWith(base+sep)){res.writeHead(403);return res.end();}const data=await readFile(target);const headerText=await readFile(resolve(base,'_headers'),'utf8');for(const line of headerText.split('\n')){const h=line.match(/^  ([^:]+): (.*)$/);if(h)res.setHeader(h[1],h[2]);}res.setHeader('Content-Type',types[extname(target)]||'application/octet-stream');res.setHeader('Cache-Control','no-store');res.end(data);}catch{res.writeHead(404);res.end('Not found');}});
server.listen(port,'127.0.0.1',()=>console.log(`Local: http://127.0.0.1:${port}`));
