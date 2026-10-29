import {build} from 'esbuild'
import {copyFile,readFile,writeFile} from 'node:fs/promises'
import {resolve,relative,sep} from 'node:path'
import {createHash} from 'node:crypto'

/** Add only outputs of this exact build, never stale directory contents. */
export async function buildPwa({root,dest,results}) {
  const pwaFiles=['manifest.webmanifest',...['180','192','512','1024'].map(size=>`pwa-icon-${size}.png`)]
  for(const file of pwaFiles)await copyFile(resolve(root,file),resolve(dest,file))
  const paths=new Set(['index.html','styles.css','profiles.css','account.css','wallet.css','orders.css','notifications.css','maplibre-gl.css','theme-init.js','icon.svg','social-graph.bin',...pwaFiles,'maplibre-gl-worker.mjs','maplibre-gl-shared.mjs'])
  for(const result of results)for(const output of Object.keys(result.metafile.outputs)){
    const path=relative(dest,resolve(root,output)).split(sep).join('/')
    if(!path.startsWith('../')&&!path.endsWith('.map'))paths.add(path)
  }
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex'),assets=[]
  for(const path of [...paths].sort()){
    const bytes=await readFile(resolve(dest,path));assets.push({path,bytes:bytes.length,sha256:digest(bytes)})
  }
  if(assets.length>256||assets.reduce((total,asset)=>total+asset.bytes,0)>24*1024*1024)throw new Error('Offline app shell exceeds its bounded cache')
  const options={absWorkingDir:root,entryPoints:[resolve(root,'src/service-worker.ts')],bundle:true,minify:true,format:'esm',target:'es2022',write:false,define:{__MARKET_SHELL__:JSON.stringify(assets),__MARKET_REVISION__:JSON.stringify('0'.repeat(64))}}
  const provisional=await build(options),revision=digest(Buffer.concat([Buffer.from(JSON.stringify(assets)),provisional.outputFiles[0].contents]))
  const final=await build({...options,define:{...options.define,__MARKET_REVISION__:JSON.stringify(revision)}})
  await writeFile(resolve(dest,'sw.js'),final.outputFiles[0].contents)
  return{revision,assets:assets.length,bytes:assets.reduce((total,asset)=>total+asset.bytes,0)}
}
