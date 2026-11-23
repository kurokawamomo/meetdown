// A request another site made from the viewer's browser (a hidden form, a script on some page) must not
// reach the panes. Browsers mark such requests with Sec-Fetch-Site and Origin; meet-say sends neither.
export function crossSite({ method = 'GET', host = '', origin, fetchSite } = {}) {
  if (method === 'GET' || method === 'HEAD') return false;
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return true;
  if (origin && origin !== 'null') {
    try { return new URL(origin).host !== host; } catch (_) { return true; }
  }
  return origin === 'null';
}
