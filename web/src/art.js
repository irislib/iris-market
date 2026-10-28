// A transparent canvas keeps missing photos neutral and lets the theme supply the surface.
const emptyPhoto = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="360" height="300" viewBox="0 0 360 300"></svg>');
export function art() { return emptyPhoto; }
