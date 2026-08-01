import { config } from './config.js';

/**
 * Toda la agenda se maneja en hora local de la parroquia ("hora de pared").
 * Estas funciones convierten un instante real (Date) a esa hora local usando
 * Intl, que ya conoce los cambios de horario de verano de cada pais.
 */
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.timezone,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

export function localParts(date = new Date()) {
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hour}:${parts.minute}`,
  };
}

/** Instante actual + horas, expresado en hora local. */
export function localAfterHours(hours) {
  return localParts(new Date(Date.now() + hours * 3600 * 1000));
}

export function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** 0 = domingo ... 6 = sabado, igual que availability_rules.weekday. */
export function weekdayOf(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export const fromMinutes = (mins) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

/** Compara "fecha + hora" como una sola clave ordenable. */
export const stamp = (date, time) => `${date} ${time}`;

export const DAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado'];
