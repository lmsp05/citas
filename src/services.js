/** Motivos de cita ofrecidos por la parroquia. Editable segun la comunidad. */
export const SERVICES = (process.env.SERVICES || [
  'Confesion',
  'Direccion espiritual',
  'Preparacion de bautizo',
  'Preparacion matrimonial',
  'Bendicion',
  'Visita a enfermo',
  'Acompanamiento en duelo',
  'Asesoria pastoral',
  'Otro',
].join('|')).split('|').map((s) => s.trim()).filter(Boolean);
