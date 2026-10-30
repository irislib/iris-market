import {element} from './dom.ts';
import {createPlaceSearch} from './places/search.ts';
import {createServiceAreaOverlay} from './service-area-ui.ts';
import type {DeliveryPlace,Coordinates} from './orders.ts';
import type {createMarketMap} from './map/index.ts';

interface DeliveryPlaceInputOptions {
  label:string;value?:DeliveryPlace;onChange?:(value:DeliveryPlace)=>void;
  createMap?:typeof createMarketMap;
  geolocation?:Pick<Geolocation,'getCurrentPosition'>;
  searchPlaces?:(query:string)=>Promise<{name:string;displayName?:string;context?:string;lat:number;lng:number}[]>;
}
/** Private, transient meeting point editor. Nothing is saved or sent by this control. */
export function createDeliveryPlaceInput({label,value,onChange=()=>{},createMap,geolocation,searchPlaces}:DeliveryPlaceInputOptions) {
  const root=element('section',undefined,'delivery-place-input');root.setAttribute('aria-label',label);
  const addressLabel=element('label'),input=element('input');input.type='text';input.maxLength=500;input.required=true;input.autocomplete='off';input.placeholder='Address or meeting point';input.value=value?.address??'';input.setAttribute('aria-label',`${label} address or meeting point`);addressLabel.append(element('span',label),input);
  const tools=element('div',undefined,'service-area-tools'),locate=element('button',undefined,'locate-button');locate.type='button';locate.title='Use my location';locate.setAttribute('aria-label',`Use my location for ${label.toLowerCase()}`);
  locate.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v3m0 14v3M2 12h3m14 0h3" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>';
  const clear=element('button','Clear map point','text-button');clear.type='button';tools.append(locate,clear);
  const suggestions=element('div',undefined,'service-area-suggestions');suggestions.setAttribute('role','group');suggestions.setAttribute('aria-label',`${label} suggestions`);
  const status=element('p','','small muted');status.setAttribute('role','status');
  const details=element('details'),summary=element('summary','Map'),canvas=element('div',undefined,'service-area-map'),center=element('button','Use map center','button secondary');center.type='button';center.disabled=true;
  details.append(summary,element('p','Choose a point, or move the map and use its center.','small muted'),canvas,center);root.append(addressLabel,suggestions,tools,status,details);
  let point:Coordinates|undefined=value?.coordinates?[...value.coordinates]:undefined,placeLabel=value?.label??label,destroyed=false,searchTicket=0,locationTicket=0,mapTicket=0,opening=false;
  let timer:ReturnType<typeof setTimeout>,map:Awaited<ReturnType<typeof createMarketMap>>|null=null,overlay:ReturnType<typeof createServiceAreaOverlay>|null=null,rawMap:any=null;
  const source=searchPlaces?null:createPlaceSearch();
  const read=():DeliveryPlace=>{const address=input.value.trim();if(!address||address.length>500){input.focus?.();throw new Error(`Enter the ${label.toLowerCase()} address or meeting point.`);}return {label:placeLabel.slice(0,120),address,...(point?{coordinates:[...point] as Coordinates}:{})};};
  function changed(){clear.hidden=!point;overlay?.setCenters(point?{pickup:point}:{});if(input.value.trim())onChange(read());}
  function cancelSearch(){searchTicket++;clearTimeout(timer);suggestions.replaceChildren();}
  function choose(next:Coordinates){if(destroyed||next.length!==2||!next.every(Number.isFinite)||Math.abs(next[0])>180||Math.abs(next[1])>90)return;point=[...next];locationTicket++;locate.removeAttribute('aria-busy');status.textContent='Map point selected. Add an address or meeting point.';changed();}
  input.oninput=()=>{
    if(destroyed)return;cancelSearch();locationTicket++;locate.removeAttribute('aria-busy');point=undefined;placeLabel=label;status.textContent='';changed();
    if(input.value.trim().length<2)return;
    const ticket=searchTicket;timer=setTimeout(async()=>{try{const results=await(searchPlaces??source.search)(input.value);if(destroyed||ticket!==searchTicket)return;for(const place of results.slice(0,8)){const button=element('button',[place.name,place.context].filter(Boolean).join(' · '),'button secondary');button.type='button';button.onclick=()=>{if(destroyed||ticket!==searchTicket)return;input.value=(place.displayName||place.name).slice(0,500);placeLabel=place.name.slice(0,120);cancelSearch();choose([place.lng,place.lat]);status.textContent='Place selected. Add any entrance or meeting details.';rawMap?.jumpTo({center:[place.lng,place.lat],zoom:15});};suggestions.append(button);}}catch{if(!destroyed&&ticket===searchTicket)status.textContent='Place search unavailable. You can enter the address yourself.';}},250);
  };
  locate.onclick=()=>{if(destroyed)return;const api=geolocation??globalThis.navigator?.geolocation;if(!api){status.textContent='Location unavailable. Enter an address or choose a map point.';return;}const ticket=++locationTicket;locate.setAttribute('aria-busy','true');api.getCurrentPosition(position=>{if(destroyed||ticket!==locationTicket)return;choose([position.coords.longitude,position.coords.latitude]);rawMap?.jumpTo({center:point,zoom:15});},()=>{if(destroyed||ticket!==locationTicket)return;locate.removeAttribute('aria-busy');status.textContent='Could not get your location. Enter an address or choose a map point.';},{enableHighAccuracy:false,timeout:10000,maximumAge:60000});};
  clear.onclick=()=>{if(destroyed)return;locationTicket++;locate.removeAttribute('aria-busy');point=undefined;status.textContent='';changed();};
  center.onclick=()=>overlay?.pickCenter();
  const dark=()=>document.documentElement.dataset.appearance==='dark'||document.documentElement.dataset.appearance!=='light'&&!!globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const themeChanged=()=>{if(map)void map.setDark(dark()).catch(()=>{if(!destroyed)status.textContent='Map unavailable. Your entered address is still available.';});};
  globalThis.window?.addEventListener('market-themechange',themeChanged);
  const systemDark=globalThis.matchMedia?.('(prefers-color-scheme: dark)');systemDark?.addEventListener('change',themeChanged);
  details.ontoggle=async()=>{
    if(destroyed||!details.open)return;if(map){map.resize();return;}if(opening)return;opening=true;const ticket=++mapTicket;status.textContent='Loading map…';
    try{const factory=createMap??(await import('./map/index.ts')).createMarketMap;if(destroyed||ticket!==mapTicket)return;
      const instance=await factory(canvas,{dark:dark(),onError:()=>{if(!destroyed)status.textContent='Map unavailable. You can enter the address yourself.';},createOverlay(raw){rawMap=raw;const next=createServiceAreaOverlay(raw,{interactive:true,onPick:choose});overlay=next;next.setCenters(point?{pickup:point}:{});raw.getCanvas().setAttribute('aria-label',`${label} map. Click a point, or use arrow keys and press Enter.`);if(point)raw.jumpTo({center:point,zoom:15});return next;}});
      if(destroyed||ticket!==mapTicket){await instance.destroy();return;}map=instance;center.disabled=false;status.textContent='';if(details.open)map.resize();themeChanged();
    }catch{if(!destroyed)status.textContent='Map unavailable. Close and reopen Map to retry.';}finally{opening=false;}
  };
  clear.hidden=!point;
  return {element:root,read,destroy(){if(destroyed)return;destroyed=true;cancelSearch();locationTicket++;mapTicket++;globalThis.window?.removeEventListener('market-themechange',themeChanged);systemDark?.removeEventListener('change',themeChanged);void source?.close().catch(()=>{});const previous=map;map=null;rawMap=null;overlay=null;if(previous)void previous.destroy().catch(()=>{});root.remove();}};
}
