import { routeBase } from './route-base.ts';
// The following base-uri CSP meta also keeps speculative loads behind this bootstrap.
const base = document.createElement('base');
base.href = routeBase(location.href).href;
document.head.prepend(base);
