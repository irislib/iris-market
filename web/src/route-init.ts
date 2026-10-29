import { routeBase } from './route-base.ts';
// This tiny, hash-authorized bootstrap runs before relative styles and modules.
const base = document.createElement('base');
base.href = routeBase(location.href).href;
document.head.prepend(base);
