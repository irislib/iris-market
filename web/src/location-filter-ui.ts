import {currentPosition,nearbyPoint,NEARBY_LABEL,type NearbyPoint} from './location-filter.ts'
export function setupLocationInputs({shipsTo,shipsButton,location,nearButton,error,dialog}:{shipsTo:HTMLSelectElement;shipsButton:HTMLButtonElement;location:HTMLInputElement;nearButton:HTMLButtonElement;error:HTMLElement;dialog:HTMLDialogElement}) {
  let pending:NearbyPoint|null=null,generation=0
  const buttons=[shipsButton,nearButton]
  const busy=(value:boolean)=>{for(const button of buttons){button.disabled=value;button.setAttribute('aria-busy',String(value))}}
  const cancel=()=>{generation++;busy(false)}
  async function locate(country:boolean){
    const attempt=++generation;error.textContent='';busy(true)
    try{
      const position=await currentPosition();if(attempt!==generation||!dialog.open)return
      if(country){
        const {countryForCoordinates}=await import('./location-country.ts')
        const code=await countryForCoordinates([position.coords.longitude,position.coords.latitude],{accuracyMeters:position.coords.accuracy})
        if(attempt!==generation||!dialog.open)return
        if(!code||![...shipsTo.options].some(option=>option.value===code))throw new Error('Could not identify your country. Please choose it from the list.')
        shipsTo.value=code
      }else{pending=nearbyPoint(position.coords);location.value=NEARBY_LABEL;nearButton.setAttribute('aria-pressed','true')}
    }catch(reason){if(attempt===generation&&dialog.open)error.textContent=reason instanceof Error?reason.message:'Could not find your location.'}
    finally{if(attempt===generation)busy(false)}
  }
  shipsButton.onclick=()=>void locate(true);nearButton.onclick=()=>void locate(false)
  location.addEventListener('input',()=>{pending=null;nearButton.setAttribute('aria-pressed','false');cancel()})
  shipsTo.addEventListener('change',cancel);dialog.addEventListener('close',cancel)
  return {pending:()=>pending,restore(point:NearbyPoint|null){cancel();pending=point;nearButton.setAttribute('aria-pressed',String(!!point))}}
}
