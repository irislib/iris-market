import {createSurface,type Surface} from './surface.ts'
import {createUserLocationStore} from './user-location-store.ts'
import type {NearbyPoint} from './location-filter.ts'
import type {createMarketMap} from './map/index.ts'

/** A ranking preference, independent of the explicit distance filter. */
export function setupUserLocation({onChange,isPreview=false}:{onChange:()=>void;isPreview?:boolean}) {
  let disposed=false,dialog:Surface|null=null,map:Awaited<ReturnType<typeof createMarketMap>>|null=null,mapTicket=0
  const controls=new Set<HTMLElement>()
  let storage:Storage|undefined;try{storage=localStorage}catch{}
  const store=createUserLocationStore({storage,isPreview,permissions:navigator.permissions,geolocation:navigator.geolocation,onChange(){paint();onChange()}})
  function paint(){for(const control of controls){control.querySelector<HTMLButtonElement>('.user-location-choose').textContent=store.label();control.querySelector<HTMLButtonElement>('.user-location-clear').hidden=!store.point()}}
  const button=(label:string,className:string)=>{const node=document.createElement('button');node.type='button';node.className=className;node.textContent=label;return node}
  function closeChooser(){
    mapTicket++;const previous=map;map=null;if(previous)void previous.destroy().catch(()=>{})
    const previousDialog=dialog;dialog=null;if(previousDialog){if(previousDialog.open)previousDialog.close();previousDialog.remove()}
  }
  async function chooseArea(){
    if(disposed)return;closeChooser();store.cancelPending();const version=++mapTicket
    const surface=createSurface({className:'user-location-dialog',label:'Your location'});dialog=surface
    const title=document.createElement('h2');title.textContent='Your location'
    const close=button('×','dialog-close');close.setAttribute('aria-label','Close location chooser');close.onclick=closeChooser
    const instructions=document.createElement('p');instructions.textContent='Move the map to choose your area.'
    const wrap=document.createElement('div');wrap.className='user-location-map-wrap'
    const canvas=document.createElement('div');canvas.className='user-location-map';canvas.setAttribute('aria-label','Choose your area on the map')
    const pin=document.createElement('span');pin.className='user-location-pin';pin.textContent='●';pin.setAttribute('aria-hidden','true');wrap.append(canvas,pin)
    const label=document.createElement('input');label.placeholder='Area name · optional';label.setAttribute('aria-label','Area name');label.maxLength=80;label.value=store.manual()?.label||''
    const message=document.createElement('p');message.className='user-location-status';message.setAttribute('role','status');message.textContent='Loading map…'
    const use=button('Use area','button primary');use.disabled=true
    let selected:NearbyPoint|null=store.point()
    use.onclick=()=>{if(selected){store.choose(selected,label.value);closeChooser()}}
    surface.append(title,close,instructions,wrap,label,message,use);surface.addEventListener('close',()=>{if(dialog===surface)closeChooser()},{once:true});surface.showModal()
    try {
      const {createMarketMap}=await import('./map/index.ts')
      if(disposed||version!==mapTicket)return
      const instance=await createMarketMap(canvas,{dark:document.documentElement.dataset.appearance==='dark'||document.documentElement.dataset.appearance!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches,onError:()=>{if(version===mapTicket)message.textContent='Map unavailable. Try again.'},createOverlay(raw){
        if(selected)raw.jumpTo({center:[...selected],zoom:10})
        const update=()=>{const center=raw.getCenter();selected=[center.lng,center.lat];use.disabled=false}
        raw.on('moveend',update);update()
        raw.getCanvas().setAttribute('aria-label','Area map. Use arrow keys to move the map, then choose Use area.')
        return {beginStyleChange(){},destroy(){raw.off('moveend',update)}}
      }})
      if(disposed||version!==mapTicket){await instance.destroy();return}
      map=instance;message.textContent='';map.resize()
    }catch{if(version===mapTicket)message.textContent='Map unavailable. Close and try again.'}
  }
  function createControl():HTMLElement {
    const root=document.createElement('div');root.className='user-location-control'
    const label=document.createElement('span');label.className='user-location-label';label.textContent='Your location'
    const choose=button('Choose area','user-location-choose');choose.onclick=()=>void chooseArea()
    const gps=button('⌖','user-location-gps');gps.setAttribute('aria-label','Use device location');gps.title='Use device location'
    const status=document.createElement('span');status.className='user-location-status';status.setAttribute('role','status')
    gps.onclick=async()=>{gps.disabled=true;gps.setAttribute('aria-busy','true');status.textContent='';const okay=await store.locate(true);gps.disabled=false;gps.removeAttribute('aria-busy');if(!okay&&!disposed)status.textContent='Choose an area on the map.'}
    const clear=button('Clear','user-location-clear');clear.onclick=()=>{store.clear();status.textContent=''}
    root.append(label,choose,gps,clear,status);controls.add(root);paint();return root
  }
  const routeClose=()=>closeChooser()
  const parentClose=(event:Event)=>{if(dialog&&event.target!==dialog)closeChooser()}
  window.addEventListener('popstate',routeClose);window.addEventListener('hashchange',routeClose);window.addEventListener('pagehide',routeClose);document.addEventListener('close',parentClose,true)
  void store.locate(false)
  return {point:store.point,createControl,closeChooser,dispose(){if(disposed)return;disposed=true;closeChooser();store.dispose();controls.clear();window.removeEventListener('popstate',routeClose);window.removeEventListener('hashchange',routeClose);window.removeEventListener('pagehide',routeClose);document.removeEventListener('close',parentClose,true)}}
}
