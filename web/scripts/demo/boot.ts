// Loaded only by the loopback demo server, before the normal app starts.
localStorage.setItem('market-ai-mode-v1','off');
localStorage.setItem('iris-market-image-settings',JSON.stringify({useProxy:false}));
const href=new URL(location.href);
if(!href.searchParams.has('test-relay')) {
  href.searchParams.set('test-relay',document.documentElement.dataset.demoRelay!);
  history.replaceState(null,'',href);
}
document.addEventListener('DOMContentLoaded',()=>{
  const banner=document.createElement('aside');banner.className='demo-banner';
  banner.append('Simulation · No real booking, delivery or payment');
  const link=document.createElement('a');link.href='/demo';link.textContent='Choose a demo';banner.append(link);
  document.body.prepend(banner);
});
