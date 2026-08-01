import { db } from './db.js';
import { config } from './config.js';
import { addDays, fromMinutes, localAfterHours, localParts, stamp, toMinutes, weekdayOf } from './time.js';

/**
 * La disponibilidad NO se almacena como filas de horarios libres: se calcula
 * a partir de las reglas semanales del lider, menos los bloqueos y menos las
 * citas vivas. Asi nunca hay estados inconsistentes que sincronizar.
 */
export function slotsForRange(leaderId, fromDate, toDate, { includeTaken = false } = {}) {
  const rules = db.prepare(
    'SELECT weekday, start_time, end_time, slot_minutes, location FROM availability_rules WHERE leader_id = ? AND active = 1',
  ).all(leaderId);
  if (rules.length === 0) return [];

  const blocks = db.prepare(
    'SELECT date_from, date_to, start_time, end_time FROM blocks WHERE leader_id = ? AND date_to >= ? AND date_from <= ?',
  ).all(leaderId, fromDate, toDate);

  const taken = new Set(
    db.prepare(`SELECT date, start_time FROM appointments
                WHERE leader_id = ? AND date BETWEEN ? AND ? AND status IN ('pendiente','confirmada')`)
      .all(leaderId, fromDate, toDate)
      .map((r) => stamp(r.date, r.start_time)),
  );

  const earliest = localAfterHours(config.minLeadHours);
  const horizon = addDays(localParts().date, config.maxDaysAhead);
  const out = [];

  for (let date = fromDate; date <= toDate; date = addDays(date, 1)) {
    const weekday = weekdayOf(date);
    for (const rule of rules.filter((r) => r.weekday === weekday)) {
      const end = toMinutes(rule.end_time);
      for (let m = toMinutes(rule.start_time); m + rule.slot_minutes <= end; m += rule.slot_minutes) {
        const startTime = fromMinutes(m);
        const endTime = fromMinutes(m + rule.slot_minutes);
        const isTaken = taken.has(stamp(date, startTime));
        const blocked = blocks.some((b) => overlapsBlock(b, date, m, m + rule.slot_minutes));
        const tooSoon = stamp(date, startTime) < stamp(earliest.date, earliest.time);
        const tooFar = date > horizon;

        if (!includeTaken && (isTaken || blocked || tooSoon || tooFar)) continue;
        out.push({
          date,
          start_time: startTime,
          end_time: endTime,
          location: rule.location,
          status: isTaken ? 'ocupado' : blocked ? 'bloqueado' : tooSoon || tooFar ? 'fuera_de_plazo' : 'libre',
        });
      }
    }
  }
  out.sort((a, b) => stamp(a.date, a.start_time).localeCompare(stamp(b.date, b.start_time)));
  return out;
}

function overlapsBlock(block, date, startMin, endMin) {
  if (date < block.date_from || date > block.date_to) return false;
  if (!block.start_time || !block.end_time) return true; // bloqueo de dia completo
  return startMin < toMinutes(block.end_time) && endMin > toMinutes(block.start_time);
}

/** Verifica que un horario concreto exista en las reglas y siga libre. */
export function findFreeSlot(leaderId, date, startTime) {
  return slotsForRange(leaderId, date, date).find((s) => s.start_time === startTime) || null;
}
