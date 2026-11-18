import jsQR from 'jsqr';

/** Limit CPU and memory for both camera frames and user-selected images. */
export function readHandoffImage(source:HTMLVideoElement|ImageBitmap,canvas:HTMLCanvasElement) {
  const width='videoWidth' in source?source.videoWidth:source.width;
  const height='videoHeight' in source?source.videoHeight:source.height;
  if(!width || !height)return;
  const scale=Math.min(1,960/Math.max(width,height));
  canvas.width=Math.max(1,Math.round(width*scale));
  canvas.height=Math.max(1,Math.round(height*scale));
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  if(!ctx)throw Error('Image scanning is unavailable on this device.');
  ctx.drawImage(source,0,0,canvas.width,canvas.height);
  const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);
  return jsQR(pixels.data,pixels.width,pixels.height,{inversionAttempts:'dontInvert'})?.data;
}
