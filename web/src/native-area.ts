import {setupServiceAreaPicker} from './service-area-ui.ts';
import {validateServiceArea,type ServiceAreas} from './service-area.ts';

/** Dedicated draft-only channel; no listing IDs, accounts, messages or publishing API. */
export function mountNativeArea({createPicker=setupServiceAreaPicker}:{createPicker?:typeof setupServiceAreaPicker}={}) {
  let closed=false,serial=0,projection:string|undefined;
  const pending=new Map<string,{success:PositionCallback;failure:PositionErrorCallback;timer:ReturnType<typeof setTimeout>}>();
  const post=(value:Record<string,unknown>)=>{
    const host=window as any;
    if(host.webkit?.messageHandlers?.marketMap)host.webkit.messageHandlers.marketMap.postMessage(value);
    else if(value.type==='ready')host.MarketMapBridge?.areaReady();
    else if(value.type==='area')host.MarketMapBridge?.areaChanged(JSON.stringify(value.areas));
    else if(value.type==='locate')host.MarketMapBridge?.locate(value.id);
  };
  const fail=(id:string)=>{const entry=pending.get(id);if(!entry)return;pending.delete(id);clearTimeout(entry.timer);entry.failure?.({code:2,message:'Location unavailable'} as GeolocationPositionError);};
  const picker=createPicker({onChange:areas=>{projection=JSON.stringify(areas);post({type:'area',areas});},geolocation:{getCurrentPosition(success,failure){if(closed)return;const id=String(++serial);const timer=setTimeout(()=>fail(id),12000);pending.set(id,{success,failure,timer});post({type:'locate',id});}}});
  const canvas=document.getElementById('map-canvas');canvas.replaceWith(picker.element);
  document.querySelector<HTMLElement>('.map-storage').hidden=true;document.getElementById('map-status').hidden=true;
  const api={
    setValue(value:unknown){if(closed)return;try{if(value===null){if(projection!=='null'){projection='null';picker.setValue(null);}return;}if(JSON.stringify(value).length>32832||!value||Object.keys(value).some(key=>!['pickup','destination'].includes(key)))return;const areas=value as ServiceAreas;const normalized={pickup:validateServiceArea(areas.pickup),destination:validateServiceArea(areas.destination)},key=JSON.stringify(normalized);if(key!==projection){projection=key;picker.setValue(normalized);}}catch{/* Keep the existing valid draft. */}},
    setDark(dark:boolean){document.documentElement.dataset.appearance=dark?'dark':'light';window.dispatchEvent(new Event('market-themechange'));},
    setLocation(id:string,point:unknown){if(closed)return;const entry=pending.get(id);if(!entry)return;if(!Array.isArray(point)||point.length!==2||!point.every(Number.isFinite)||Math.abs(point[0])>180||Math.abs(point[1])>90){fail(id);return;}pending.delete(id);clearTimeout(entry.timer);entry.success({coords:{longitude:point[0],latitude:point[1]},timestamp:Date.now()} as GeolocationPosition);},
  };
  (window as any).marketArea=api;
  window.addEventListener('pagehide',()=>{closed=true;for(const id of pending.keys())fail(id);void picker.destroy();},{once:true});
  post({type:'ready',mode:'area',version:1});void picker.show();return api;
}
