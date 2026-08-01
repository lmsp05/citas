/** Utilidades compartidas por las tres paginas. */

export const $ = (sel, root = document) => root.querySelector(sel);

/**
 * Cliente HTTP: siempre JSON, siempre con la cookie de sesion del propio sitio
 * y con el token CSRF cuando existe. Nunca se inyecta HTML del servidor.
 */
export async function api(path, { method = 'GET', body, csrf } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* respuesta sin cuerpo */ }
  if (!res.ok) {
    const err = new Error(data.error || 'No fue posible completar la operacion.');
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Crea elementos con texto seguro (textContent, nunca innerHTML). */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, val] of Object.entries(attrs)) {
    if (val === undefined || val === null || val === false) continue;
    if (k === 'class') node.className = val;
    else if (k === 'text') node.textContent = val;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), val);
    else node.setAttribute(k, val === true ? '' : String(val));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };

export function show(node, visible = true) { node.hidden = !visible; }

export function message(node, text, kind = 'err') {
  if (!text) { node.hidden = true; return; }
  node.className = `msg ${kind}`;
  node.textContent = text;
  node.hidden = false;
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

/** Formatea 'AAAA-MM-DD' sin depender de la zona horaria del navegador. */
export function longDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const weekday = DIAS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday} ${d} de ${MESES[m - 1]} de ${y}`;
}

export const monthLabel = (y, m) => `${MESES[m]} ${y}`;
export const pad = (n) => String(n).padStart(2, '0');
export const isoOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
export const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
export const firstWeekday = (y, m) => new Date(Date.UTC(y, m, 1)).getUTCDay();
export const hhmmLabel = (t) => {
  const [h, m] = t.split(':').map(Number);
  const suffix = h < 12 ? 'a.m.' : 'p.m.';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${suffix}`;
};
