import {flushSync,mount,unmount} from 'svelte';
import {element} from './dom.ts';
import {serviceAreaBounds,serviceAreaCircle} from './service-area.ts';
import type {ServiceAreaGeometry,ServiceAreaPoint,ServiceAreas} from './service-area.ts';
import Picker from './service-area-view/Picker.svelte';
import {ServiceAreaPickerState,type PickerOptions,type Role} from './service-area-view/state.svelte.ts';

type Areas=Partial<ServiceAreas>;
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
export function setupServiceAreaPicker(options:PickerOptions={}) {
  const root=element('section',undefined,'service-area-picker');root.setAttribute('aria-label',options.readOnly?'Service areas':'Choose service areas');root.hidden=true;
  const picker=new ServiceAreaPickerState(root,options);
  const view=mount(Picker,{target:root,props:{picker}});flushSync();picker.paint();
  return {
    element:root,getValue:picker.getValue,validate:picker.validate,
    setValue(value:ServiceAreas|null){picker.setValue(value);flushSync();},
    async show(){await picker.show();flushSync();},
    hide(){picker.hide();flushSync();},
    async destroy(){if(!await picker.destroy())return;void unmount(view);root.remove();},
  };
}
