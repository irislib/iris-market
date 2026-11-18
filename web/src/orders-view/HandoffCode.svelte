<script lang="ts">
  import {onMount,tick} from 'svelte'
  import qrcode from 'qrcode-generator'
  import type {OrdersState} from './state.svelte.ts'

  let {orders,label,imageLabel=label,description='',expires=false,showCode,readCode}: {
    orders:OrdersState;label:string;imageLabel?:string;description?:string;expires?:boolean;
    showCode?:()=>Promise<string>;readCode?:(value:string)=>Promise<unknown>
  }=$props()
  let opened=$state(false), busy=$state(false), error=$state(''), image=$state(''), expired=$state(false)
  let video:HTMLVideoElement, stream=$state.raw<MediaStream>(), timer:ReturnType<typeof setTimeout>, generation=0

  function stop() {
    generation++
    clearTimeout(timer)
    stream?.getTracks().forEach(track=>track.stop())
    stream=undefined
    if(video)video.srcObject=null
    image=''; busy=false
  }
  function close() {stop();opened=false;error='';expired=false}
  onMount(()=>{
    const hidden=()=>{if(document.visibilityState==='hidden')close()}
    orders.dialog.addEventListener('close',close)
    window.addEventListener('pagehide',close)
    document.addEventListener('visibilitychange',hidden)
    return ()=>{
      orders.dialog.removeEventListener('close',close)
      window.removeEventListener('pagehide',close)
      document.removeEventListener('visibilitychange',hidden)
      stop()
    }
  })
  async function show() {
    stop();const attempt=generation
    opened=true;busy=true;error='';expired=false
    try {
      const value=await showCode()
      if(attempt!==generation)return
      const qr=qrcode(0,'M');qr.addData(value,'Byte');qr.make()
      image='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(qr.createSvgTag({cellSize:4,margin:16,scalable:true}))
      if(expires){
        const until=(Number(value.split(':')[4])+120)*1000-Date.now()
        timer=setTimeout(()=>{image='';expired=true},Math.max(0,until))
      }
    } catch(cause) {if(attempt===generation)error=cause.message}
    finally {if(attempt===generation)busy=false}
  }
  async function check(value:string,attempt:number) {
    if(attempt!==generation)return
    stop();const checking=generation;busy=true
    try {
      await readCode(value)
      if(checking===generation){close();orders.render()}
    }catch(cause){if(checking===generation){error=cause.message;busy=false}}
  }
  async function scan() {
    stop();const attempt=generation
    opened=true;error='';busy=true
    try {
      if(!navigator.mediaDevices?.getUserMedia)throw Error()
      const [camera,reader]=await Promise.all([
        navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:960}}}).then(camera=>{
          if(attempt===generation)stream=camera
          else camera.getTracks().forEach(track=>track.stop())
          return camera
        }),
        import('./handoff-image.ts')
      ])
      if(attempt!==generation)return
      await tick();if(attempt!==generation)return
      video.srcObject=camera;await video.play();if(attempt!==generation)return
      const canvas=document.createElement('canvas')
      const read=()=>{
        if(attempt!==generation)return
        try {
          const value=reader.readHandoffImage(video,canvas)
          if(value){void check(value,attempt);return}
          timer=setTimeout(read,250)
        }catch{stop();error='Could not read from this camera. Choose a QR image instead.'}
      }
      busy=false;read()
    }catch{if(attempt===generation){stop();error='Camera unavailable. Allow camera access or choose a QR image.'}}
  }
  async function file(event:Event) {
    const input=event.currentTarget as HTMLInputElement
    const file=input.files?.[0];input.value=''
    if(!file)return
    stop();const attempt=generation;error='';busy=true
    let bitmap:ImageBitmap
    try{
      if(file.size>10*1024*1024)throw Error('Choose an image smaller than 10 MB.')
      const {readHandoffImage}=await import('./handoff-image.ts')
      bitmap=await createImageBitmap(file)
      if(attempt!==generation)return
      const value=readHandoffImage(bitmap,document.createElement('canvas'))
      if(!value)throw Error('No QR code found. Choose a clear image of the whole code.')
      await check(value,attempt)
    }catch(cause){if(attempt===generation)error=cause.message||'Could not read this image.'}
    finally {bitmap?.close();if(attempt===generation)busy=false}
  }
</script>

{#if !opened}
  <button type="button" class="button secondary" onclick={showCode?show:scan}>{label}</button>
{:else}
  <section class="handoff" aria-label={label}>
    <h3>{label}</h3>
    {#if showCode}
      {#if image}<img src={image} alt={imageLabel} />{#if description}<p class="small muted">{description}</p>{/if}{/if}
      {#if expired}<p role="status">This code expired.</p>{/if}
      {#if !busy && !image}<button type="button" class="button secondary" onclick={show}>Show fresh code</button>{/if}
    {:else}
      <video bind:this={video} class:active={!!stream} muted playsinline aria-label="Handoff camera"></video>
      {#if !stream && !busy}<button type="button" class="button secondary" onclick={scan}>Try camera again</button>{/if}
      <label class="button secondary">Choose QR image<input class="sr-only" type="file" accept="image/*" onchange={file} /></label>
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <button type="button" class="text-button" onclick={close}>Close</button>
  </section>
{/if}

<style>
  .handoff { display:grid; justify-items:start; gap:.6rem; }
  .handoff img,.handoff video { width:min(100%,18rem); height:auto; }
  .handoff img { background:white; }
  .handoff video:not(.active) { display:none; }
  .handoff label { cursor:pointer; }
  .handoff label:focus-within { outline:2px solid currentColor; }
</style>
