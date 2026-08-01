/** Errores de validacion: se convierten en HTTP 400 con mensaje para el usuario. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const bad = (message) => {
  throw new HttpError(400, message);
};

export function str(value, field, { min = 1, max = 200, required = true } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') bad(`El campo ${field} no es valido.`);
  // Se eliminan caracteres de control que ensucian el almacenamiento y los correos.
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!clean) {
    if (required) bad(`El campo ${field} es obligatorio.`);
    return '';
  }
  if (clean.length < min) bad(`El campo ${field} debe tener al menos ${min} caracteres.`);
  if (clean.length > max) bad(`El campo ${field} no debe superar ${max} caracteres.`);
  return clean;
}

export function email(value, field = 'correo') {
  const clean = str(value, field, { max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(clean)) bad('El correo electronico no tiene un formato valido.');
  return clean;
}

export function phone(value, field = 'telefono', required = false) {
  const clean = str(value, field, { max: 25, required });
  if (!clean) return '';
  if (!/^[+()\d\s-]{7,25}$/.test(clean)) bad('El telefono solo puede contener numeros, espacios y + ( ) -');
  return clean;
}

export function isoDate(value, field = 'fecha') {
  const clean = str(value, field, { max: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) bad(`El campo ${field} debe tener formato AAAA-MM-DD.`);
  const [y, m, d] = clean.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    bad(`El campo ${field} no corresponde a una fecha real.`);
  }
  return clean;
}

export function hhmm(value, field = 'hora') {
  const clean = str(value, field, { max: 5 });
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(clean)) bad(`El campo ${field} debe tener formato HH:MM (24 horas).`);
  return clean;
}

export function intIn(value, field, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) bad(`El campo ${field} debe ser un entero entre ${min} y ${max}.`);
  return n;
}

export function oneOf(value, field, allowed) {
  const clean = str(value, field, { max: 40 });
  if (!allowed.includes(clean)) bad(`El campo ${field} tiene un valor no permitido.`);
  return clean;
}

export function password(value) {
  if (typeof value !== 'string') bad('Contrasena invalida.');
  if (value.length < 12) bad('La contrasena debe tener al menos 12 caracteres.');
  if (value.length > 200) bad('La contrasena es demasiado larga.');
  if (!/[a-zA-Z]/.test(value) || !/\d/.test(value)) {
    bad('La contrasena debe combinar letras y numeros.');
  }
  return value;
}
