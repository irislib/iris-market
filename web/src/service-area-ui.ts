import {createPlaceSearch} from './places/search.ts';
import {element} from './dom.ts';
import {serviceAreaBounds,serviceAreaCircle,validateServiceArea,MIN_SERVICE_AREA_RADIUS_KM,MAX_SERVICE_AREA_RADIUS_KM} from './service-area.ts';
import type {ServiceAreaGeometry,ServiceAreaPoint,ServiceAreas} from './service-area.ts';
import type {createMarketMap} from './map/index.ts';

type Role='pickup'|'destination';
type Areas=Partial<ServiceAreas>;
type MapFactory=typeof createMarketMap;
type MapInstance=Awaited<ReturnType<MapFactory>>;
interface PickerOptions {
  value?:ServiceAreas|null;
  onChange?:(value:ServiceAreas|null)=>void;
  readOnly?:boolean;
  createMap?:MapFactory;
  geolocation?:Pick<Geolocation,'getCurrentPosition'>;
  searchPlaces?:(query:string)=>Promise<{name:string;displayName?:string;context?:string;contextParts?:string[];lat:number;lng:number}[]>;
}
const labels:Record<Role,string>={pickup:'Pickup',destination:'Destination'};
const keyFor=(value:unknown)=>JSON.stringify(value);

/** Geometry only: this overlay does not query listings, identities or private routes. */
export function createServiceAreaOverlay(map,{areas={},interactive=false,onPick=(_point:ServiceAreaPoint)=>{}}:{areas?:Areas;interactive?:boolean;onPick?:(point:ServiceAreaPoint)=>void}={}) {
  let pin:any=null,points:Partial<Record<Role,ServiceAreaPoint>>={};
  let current=areas,ready=false,destroyed=false,fit=true,active:Role='pickup';
  const canvas=map.getCanvas(),oldLabel=canvas.getAttribute('aria-label');
  canvas.setAttribute('aria-label',interactive?'Service area map. Click to choose a center, or pan with arrow keys and press Enter.':'Public service areas map.');
  function update(){
    if(!ready||destroyed)return;
    const same=current.pickup&&current.destination&&keyFor(current.pickup)===keyFor(current.destination);
    const features=(['pickup','destination'] as const).filter(role=>current[role]&&!(role==='destination'&&same)).map(role=>({type:'Feature',properties:{role:same?'both':role},geometry:current[role]}));
    const data={type:'FeatureCollection',features},source=map.getSource('service-areas');
    if(source)source.setData(data);else map.addSource('service-areas',{type:'geojson',data});
    if(!map.getLayer('service-area-fill'))map.addLayer({id:'service-area-fill',type:'fill',source:'service-areas',paint:{'fill-color':['match',['get','role'],'destination','#648e9d','#8c79c8'],'fill-opacity':.16}});
    if(!map.getLayer('service-area-line'))map.addLayer({id:'service-area-line',type:'line',source:'service-areas',paint:{'line-color':['match',['get','role'],'destination','#648e9d','#8c79c8'],'line-width':2}});
    const point=points[active];
    if(interactive&&point){
      if(pin)pin.setLngLat(point);
      else if(typeof map.getContainer==='function')void import('maplibre-gl').then(({Marker})=>{if(destroyed||pin||!points[active])return;pin=new Marker({draggable:true,color:'#52735e'}).setLngLat(points[active]).addTo(map);pin.on('dragend',()=>{const p=pin.getLngLat();if(!destroyed)onPick([p.lng,p.lat]);});});
    }else if(pin){pin.remove();pin=null;}
    if(fit&&features.length){
      const bounds=features.map(feature=>serviceAreaBounds(feature.geometry)).reduce((a,b)=>[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[2],b[2]),Math.max(a[3],b[3])]);
      map.fitBounds([[bounds[0],bounds[1]],[bounds[2],bounds[3]]],{padding:40,maxZoom:13,duration:0});fit=false;
    }
  }
  const loaded=()=>{ready=true;update();};
  const pick=event=>{if(interactive&&!destroyed&&event.lngLat)onPick([event.lngLat.lng,event.lngLat.lat]);};
  const pickCenter=()=>{if(interactive&&!destroyed){const center=map.getCenter();onPick([center.lng,center.lat]);}};
  const keydown=event=>{if(interactive&&event.target===canvas&&event.key==='Enter'){event.preventDefault();pickCenter();}};
  map.on('load',loaded);map.on('style.load',loaded);if(interactive)map.on('click',pick);canvas.addEventListener('keydown',keydown);
  return {
    setCenters(value:Partial<Record<Role,ServiceAreaPoint>>){points=value;update();},
    setAreas(value:Areas){if(keyFor(value)!==keyFor(current))fit=true;current=value;update();},
    focus(role:Role){active=role;update();const value=current[active];if(ready&&value){const [w,s,e,n]=serviceAreaBounds(value);map.fitBounds([[w,s],[e,n]],{padding:40,maxZoom:13,duration:0});}},
    pickCenter,
    beginStyleChange(){ready=false;},
    destroy(){destroyed=true;pin?.remove();pin=null;map.off('load',loaded);map.off('style.load',loaded);if(interactive)map.off('click',pick);canvas.removeEventListener('keydown',keydown);if(oldLabel===null)canvas.removeAttribute('aria-label');else canvas.setAttribute('aria-label',oldLabel);},
  };
}

/** Recover editor controls only for an exact circle produced by our public geometry format.
 * Arbitrary saved boundaries stay exact and are never guessed into a radius. */
export function restoreServiceAreaCircle(area:ServiceAreaGeometry):{point:ServiceAreaPoint;radius:number}|null {
  if(area.type!=='Polygon'||area.coordinates.length!==1||area.coordinates[0].length!==65)return null;
  const ring=area.coordinates[0],point:ServiceAreaPoint=[ring[0][0],(ring[0][1]+ring[32][1])/2];
  const estimate=(ring[0][1]-ring[32][1])*Math.PI/360*6371.0088,rounded=Number(estimate.toFixed(3));
  const radius=Math.abs(estimate-rounded)<0.0001?rounded:Number(estimate.toFixed(6));
  try{const restored=serviceAreaCircle(point,radius);if(restored.coordinates[0].every((p,i)=>p.every((v,j)=>Math.abs(v-ring[i][j])<0.000002)))return{point,radius};}catch{}
  return null;
}

/** Starts unselected. Only an explicit map/location action creates a public boundary. */
export function setupServiceAreaPicker({value=null,onChange=()=>{},readOnly=false,createMap,geolocation,searchPlaces}:PickerOptions={}) {
  const root=element('section',undefined,'service-area-picker');root.setAttribute('aria-label',readOnly?'Service areas':'Choose service areas');root.hidden=true;
  const tabs=element('div',undefined,'service-area-tabs segments');tabs.setAttribute('role','group');tabs.setAttribute('aria-label','Service area');
  const sameLabel=element('label',undefined,'service-area-same'),same=element('input');same.type='checkbox';same.checked=true;sameLabel.append(same,element('span','Same as pickup'));
  const tools=element('div',undefined,'service-area-tools'),radiusLabel=element('label',undefined,'service-area-radius'),radius=element('input');radius.type='number';radius.min=String(MIN_SERVICE_AREA_RADIUS_KM);radius.max=String(MAX_SERVICE_AREA_RADIUS_KM);radius.step='0.1';radius.value='10';radiusLabel.append(element('span','Radius (km)'),radius);
  const center=element('button','Use map center','button secondary');center.type='button';center.disabled=true;
  const clear=element('button','Clear area','text-button');clear.type='button';
  const locate=element('button',undefined,'locate-button');locate.type='button';locate.setAttribute('aria-label','Use my location for service area');locate.title='Use my location';
  locate.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v3m0 14v3M2 12h3m14 0h3" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>';
  tools.append(radiusLabel,center,locate,clear);
  const selection=element('p','','small muted'),canvas=element('div',undefined,'service-area-map'),message=element('p','','small muted'),error=element('p','','error small'),retry=element('button','Retry map','button secondary');retry.type='button';retry.hidden=true;error.setAttribute('role','alert');message.setAttribute('role','status');
  const searchStatus=element('p','','small muted');searchStatus.setAttribute('role','status');
  const searchLabel=element('label'),search=element('input'),suggestions=element('div',undefined,'service-area-suggestions');search.type='search';search.maxLength=160;search.placeholder='Search places';search.autocomplete='off';search.setAttribute('aria-label','Search places');searchLabel.append(search);suggestions.setAttribute('role','group');suggestions.setAttribute('aria-label','Place suggestions');
  root.append(tabs,sameLabel,searchLabel,suggestions,searchStatus,tools,selection,canvas,message,error,retry);
  searchLabel.hidden=readOnly;
  const placeSource=searchPlaces?null:createPlaceSearch();let searchTicket=0,searchTimer:ReturnType<typeof setTimeout>;
  function cancelSearch(){searchTicket++;clearTimeout(searchTimer);suggestions.replaceChildren();searchStatus.textContent='';}
  search.oninput=()=>{cancelSearch();if(search.value.trim().length<2)return;searchStatus.textContent='Searching places…';const version=searchTicket,role=active;searchTimer=setTimeout(async()=>{try{const values=await(searchPlaces??placeSource.search)(search.value);if(destroyed||!visible||version!==searchTicket||role!==active)return;searchStatus.textContent=values.length?'':'No matching places. Choose a point on the map.';suggestions.replaceChildren();for(const place of values.slice(0,8)){const button=element('button',[place.name,place.context||place.contextParts?.join(', ')].filter(Boolean).join(' · '),'button secondary');button.type='button';button.onclick=()=>{if(version!==searchTicket||role!==active)return;choose([place.lng,place.lat]);search.value=place.name;cancelSearch();overlay?.focus(role);};suggestions.append(button);}}catch{if(version===searchTicket){searchStatus.textContent='';error.textContent='Place search unavailable. Choose a point on the map.';}}},250);};
  if(!readOnly)root.append(element('p','These boundaries will be public when you post.','small muted'));
  sameLabel.hidden=readOnly;tools.hidden=readOnly;
  let areas:Areas={},samePickup=true,active:Role='pickup',destroyed=false,visible=false,mapFailed=false,ticket=0,locationTicket=0,map:MapInstance|null=null,mapDark:boolean|null=null,opening:Promise<void>|null=null,overlay:ReturnType<typeof createServiceAreaOverlay>|null=null;
  const themeEvents=globalThis.window,systemDark=globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  const darkAppearance=()=>{const appearance=globalThis.document?.documentElement?.dataset.appearance;return appearance==='dark'||appearance!=='light'&&!!systemDark?.matches;};
  const themeChanged=()=>{const current=map,dark=darkAppearance();if(destroyed||!visible||!current||dark===mapDark)return;mapDark=dark;void current.setDark(dark).catch(()=>{if(!destroyed&&map===current){mapDark=null;mapFailed=true;message.textContent='Map unavailable.';retry.hidden=false;}});};
  themeEvents?.addEventListener('market-themechange',themeChanged);systemDark?.addEventListener('change',themeChanged);
  const centers:Partial<Record<Role,ServiceAreaPoint>>={},radii:Record<Role,number>={pickup:10,destination:10},buttons=new Map<Role,HTMLButtonElement>();
  const projected=():Areas=>samePickup&&areas.pickup?{pickup:areas.pickup,destination:areas.pickup}:areas;
  const getValue=():ServiceAreas|null=>{const value=projected();return value.pickup&&value.destination?{pickup:value.pickup,destination:value.destination}:null;};
  const validate=():ServiceAreas|null=>{const value=projected();if(!value.pickup&&!value.destination)return null;if(!value.pickup)throw new Error('Choose a pickup area.');if(!value.destination)throw new Error('Choose a destination area.');return{pickup:value.pickup,destination:value.destination};};
  function paint(){
    same.checked=samePickup;
    for(const [role,button] of buttons){button.setAttribute('aria-pressed',String(role===active));button.classList.toggle('selected',role===active);}
    const selected=projected()[active];radius.value=String(radii[active]);radius.disabled=readOnly||active==='destination'&&samePickup;center.disabled=readOnly||!map||active==='destination'&&samePickup;locate.disabled=readOnly||active==='destination'&&samePickup;
    clear.disabled=readOnly||!selected;
    selection.textContent=selected?(active==='destination'&&samePickup?'Same as pickup':centers[active]?`${radii[active]} km around the selected point`:'Custom boundary selected'):readOnly?'Area not set':`Choose a ${active==='pickup'?'pickup':'destination'} area on the map.`;
    overlay?.setCenters(samePickup&&centers.pickup?{pickup:centers.pickup,destination:centers.pickup}:centers);overlay?.setAreas(projected());
  }
  const changed=()=>{paint();onChange(getValue());};
  function choose(point:ServiceAreaPoint){
    if(destroyed||readOnly||active==='destination'&&samePickup)return;
    locationTicket++;locate.removeAttribute('aria-busy');
    try{const geometry=serviceAreaCircle(point,radii[active]);areas={...areas,[active]:geometry};centers[active]=[...point];error.textContent='';changed();}catch(cause){error.textContent=cause.message||'Choose a different area.';}
  }
  for(const role of ['pickup','destination'] as const){const button=element('button',labels[role]);button.type='button';button.onclick=()=>{locationTicket++;locate.removeAttribute('aria-busy');active=role;cancelSearch();search.value='';error.textContent='';paint();overlay?.focus(role);};buttons.set(role,button);tabs.append(button);}
  same.onchange=()=>{locationTicket++;locate.removeAttribute('aria-busy');samePickup=same.checked;error.textContent='';changed();};
  radius.onchange=()=>{const next=Number(radius.value);if(!Number.isFinite(next)||next<MIN_SERVICE_AREA_RADIUS_KM||next>MAX_SERVICE_AREA_RADIUS_KM){error.textContent='Choose a radius from 0.1 to 2000 km.';return;}const previous=radii[active];radii[active]=next;if(centers[active]){try{areas={...areas,[active]:serviceAreaCircle(centers[active],next)};error.textContent='';changed();}catch(cause){radii[active]=previous;error.textContent=cause.message||'Choose a smaller area.';}}else{error.textContent='';paint();}};
  center.onclick=()=>overlay?.pickCenter();
  clear.onclick=()=>{if(destroyed||readOnly)return;locationTicket++;locate.removeAttribute('aria-busy');if(samePickup){areas={};delete centers.pickup;delete centers.destination;}else{areas={...areas};delete areas[active];delete centers[active];}error.textContent='';changed();};
  locate.onclick=()=>{
    if(destroyed||readOnly||active==='destination'&&samePickup)return;const api=geolocation??globalThis.navigator?.geolocation;if(!api){error.textContent='Location is unavailable. Choose an area on the map.';return;}
    const current=++locationTicket,role=active,version=ticket;locate.setAttribute('aria-busy','true');
    api.getCurrentPosition(position=>{if(destroyed||!visible||current!==locationTicket||version!==ticket)return;locate.removeAttribute('aria-busy');if(role!==active)return;choose([position.coords.longitude,position.coords.latitude]);},()=>{if(destroyed||current!==locationTicket||version!==ticket)return;locate.removeAttribute('aria-busy');error.textContent='Could not get your location. Choose an area on the map.';},{enableHighAccuracy:false,timeout:10000,maximumAge:60000});
  };
  async function startMap(){
    if(destroyed||!visible||map)return;
    if(opening){await opening;if(!destroyed&&visible&&!map&&!mapFailed)return startMap();return;}
    const current=ticket;mapFailed=false;message.textContent='Loading map…';retry.hidden=true;
    const operation=(async()=>{
      try{
        const factory=createMap??(await import('./map/index.ts')).createMarketMap;
        if(destroyed||!visible||current!==ticket)return;
        const dark=darkAppearance();
        const instance=await factory(canvas,{dark,onError:()=>{if(!destroyed&&visible&&current===ticket){mapFailed=true;message.textContent='Map unavailable.';retry.hidden=false;}},createOverlay:instance=>{
          const next=createServiceAreaOverlay(instance,{areas:projected(),interactive:!readOnly,onPick:point=>{if(!destroyed&&visible&&current===ticket)choose(point);}});if(current===ticket)overlay=next;return next;
        }});
        if(destroyed||!visible||current!==ticket){await instance.destroy();return;}
        map=instance;mapDark=dark;if(!mapFailed)message.textContent='';paint();map.resize();themeChanged();
      }catch{if(!destroyed&&visible&&current===ticket){mapFailed=true;message.textContent='Map unavailable.';retry.hidden=false;}}
    })();opening=operation;await operation;if(opening===operation)opening=null;
  }
  function setValue(value:ServiceAreas|null){
    const next=value?{pickup:validateServiceArea(value.pickup),destination:validateServiceArea(value.destination)}:{};
    areas=next;samePickup=!value||keyFor(next.pickup)===keyFor(next.destination);if(samePickup)areas={pickup:next.pickup};delete centers.pickup;delete centers.destination;for(const role of ['pickup','destination'] as const){const area=next[role],circle=area&&restoreServiceAreaCircle(area);if(circle){centers[role]=circle.point;radii[role]=circle.radius;}}active='pickup';error.textContent='';locationTicket++;locate.removeAttribute('aria-busy');paint();
  }
  async function closeMap(){const previous=map;map=null;mapDark=null;overlay=null;center.disabled=true;if(previous)try{await previous.destroy();}catch{/* Closing the view must not leave an unhandled cache-close rejection. */}}
  retry.onclick=async()=>{ticket++;mapFailed=false;await closeMap();await startMap();};
  setValue(value);
  return {
    element:root,getValue,validate,setValue,
    async show(){if(destroyed)return;const wasVisible=visible;visible=true;root.hidden=false;if(wasVisible&&mapFailed)return;await startMap();if(visible&&!destroyed)map?.resize();},
    hide(){cancelSearch();visible=false;root.hidden=true;ticket++;locationTicket++;locate.removeAttribute('aria-busy');void closeMap();},
    async destroy(){if(destroyed)return;cancelSearch();void placeSource?.close();destroyed=true;visible=false;ticket++;locationTicket++;themeEvents?.removeEventListener('market-themechange',themeChanged);systemDark?.removeEventListener('change',themeChanged);await closeMap();await opening;root.remove();},
  };
}
