import {
  $, api, clear, daysInMonth, el, firstWeekday, hhmmLabel, isoOf, longDate,
  message, monthLabel, show,
} from './common.js';

const state = {
  config: null,
  leaderId: null,
  leaderName: '',
  year: 0,
  month: 0,        // 0-11
  slotsByDate: new Map(),
  selectedDate: null,
  selectedSlot: null,
};

const nodes = {
  aviso: $('#aviso'),
  leaders: $('#leaders'),
  calendar: $('#calendar'),
  monthLabel: $('#month-label'),
  slots: $('#slots'),
  slotsHint: $('#slots-hint'),
  resumen: $('#resumen'),
  formMsg: $('#form-msg'),
  pasos: {
    calendario: $('#paso-calendario'),
    horarios: $('#paso-horarios'),
    datos: $('#paso-datos'),
    listo: $('#paso-listo'),
  },
};

async function init() {
  try {
    state.config = await api('/api/config');
  } catch {
    message(nodes.aviso, 'No fue posible contactar el servidor. Intente mas tarde.');
    return;
  }
  document.title = `Agendamiento de citas | ${state.config.parish}`;
  $('#parish-name').textContent = state.config.parish;
  $('#footer-text').textContent =
    `${state.config.parish} - horarios en zona ${state.config.timezone}. `
    + `Las citas se solicitan con al menos ${state.config.min_lead_hours} horas de anticipacion.`;

  const select = $('#service');
  for (const service of state.config.services) select.append(el('option', { value: service, text: service }));

  const [y, m] = state.config.today.split('-').map(Number);
  state.year = y;
  state.month = m - 1;

  await loadLeaders();
}

async function loadLeaders() {
  const { leaders } = await api('/api/leaders');
  clear(nodes.leaders);
  if (leaders.length === 0) {
    nodes.leaders.append(el('p', { class: 'muted', text: 'Todavia no hay horarios de atencion publicados.' }));
    return;
  }
  for (const leader of leaders) {
    nodes.leaders.append(el('button', {
      type: 'button',
      class: 'leader',
      'aria-pressed': 'false',
      'data-id': leader.id,
      onclick: () => selectLeader(leader),
    },
      el('strong', { text: leader.name }),
      el('span', { text: leader.title || 'Lider parroquial' }),
      leader.bio ? el('span', { class: 'bio', text: leader.bio }) : null,
    ));
  }
}

async function selectLeader(leader) {
  state.leaderId = leader.id;
  state.leaderName = leader.name;
  state.selectedDate = null;
  state.selectedSlot = null;
  for (const btn of nodes.leaders.querySelectorAll('.leader')) {
    btn.setAttribute('aria-pressed', String(Number(btn.dataset.id) === leader.id));
  }
  show(nodes.pasos.calendario, true);
  show(nodes.pasos.horarios, false);
  show(nodes.pasos.datos, false);
  show(nodes.pasos.listo, false);
  await loadMonth();
  nodes.pasos.calendario.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function loadMonth() {
  const { year, month } = state;
  const from = isoOf(year, month, 1);
  const to = isoOf(year, month, daysInMonth(year, month));
  nodes.monthLabel.textContent = monthLabel(year, month);
  try {
    const { slots } = await api(`/api/availability?leader=${state.leaderId}&from=${from}&to=${to}`);
    state.slotsByDate = new Map();
    for (const slot of slots) {
      if (!state.slotsByDate.has(slot.date)) state.slotsByDate.set(slot.date, []);
      state.slotsByDate.get(slot.date).push(slot);
    }
    message(nodes.aviso, '');
  } catch (err) {
    message(nodes.aviso, err.message);
    state.slotsByDate = new Map();
  }
  renderCalendar();
}

function renderCalendar() {
  const { year, month } = state;
  clear(nodes.calendar);
  for (let i = 0; i < firstWeekday(year, month); i++) {
    nodes.calendar.append(el('div', { class: 'day empty' }));
  }
  const total = daysInMonth(year, month);
  let freeDays = 0;
  for (let d = 1; d <= total; d++) {
    const iso = isoOf(year, month, d);
    const slots = state.slotsByDate.get(iso) || [];
    const free = slots.length > 0;
    if (free) freeDays++;
    const classes = ['day'];
    if (free) classes.push('free');
    if (iso === state.config.today) classes.push('today');
    nodes.calendar.append(el('button', {
      type: 'button',
      class: classes.join(' '),
      disabled: !free,
      'aria-pressed': String(state.selectedDate === iso),
      'aria-label': free ? `${longDate(iso)}: ${slots.length} horarios libres` : `${longDate(iso)}: sin atencion`,
      onclick: free ? () => selectDate(iso) : undefined,
    },
      el('span', { text: String(d) }),
      free ? el('span', { class: 'count', text: `${slots.length} cupos` }) : null,
    ));
  }
  $('#calendar-hint').textContent = freeDays > 0
    ? `${state.leaderName}: los dias en verde tienen horarios libres.`
    : `${state.leaderName} no tiene horarios libres este mes. Pruebe el mes siguiente.`;
}

function selectDate(iso) {
  state.selectedDate = iso;
  state.selectedSlot = null;
  renderCalendar();
  const slots = state.slotsByDate.get(iso) || [];
  nodes.slotsHint.textContent = `${longDate(iso)} - ${slots.length} horarios disponibles`;
  clear(nodes.slots);
  for (const slot of slots) {
    nodes.slots.append(el('button', {
      type: 'button',
      class: 'slot',
      'aria-pressed': 'false',
      onclick: (ev) => selectSlot(slot, ev.currentTarget),
    }, `${hhmmLabel(slot.start_time)} - ${hhmmLabel(slot.end_time)}`));
  }
  show(nodes.pasos.horarios, true);
  show(nodes.pasos.datos, false);
  nodes.pasos.horarios.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function selectSlot(slot, button) {
  state.selectedSlot = slot;
  for (const btn of nodes.slots.querySelectorAll('.slot')) btn.setAttribute('aria-pressed', 'false');
  button.setAttribute('aria-pressed', 'true');
  clear(nodes.resumen);
  nodes.resumen.append(
    el('div', {}, 'Cita con ', el('b', { text: state.leaderName })),
    el('div', { text: longDate(slot.date) }),
    el('div', { text: `${hhmmLabel(slot.start_time)} a ${hhmmLabel(slot.end_time)}` }),
    slot.location ? el('div', { text: `Lugar: ${slot.location}` }) : null,
  );
  show(nodes.pasos.datos, true);
  nodes.pasos.datos.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('#prev-month').addEventListener('click', () => {
  state.month -= 1;
  if (state.month < 0) { state.month = 11; state.year -= 1; }
  if (state.leaderId) loadMonth();
});

$('#next-month').addEventListener('click', () => {
  state.month += 1;
  if (state.month > 11) { state.month = 0; state.year += 1; }
  if (state.leaderId) loadMonth();
});

$('#form-cita').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!state.selectedSlot) return;
  const btn = $('#enviar');
  btn.disabled = true;
  message(nodes.formMsg, '');
  try {
    const data = await api('/api/appointments', {
      method: 'POST',
      body: {
        leader_id: state.leaderId,
        date: state.selectedSlot.date,
        start_time: state.selectedSlot.start_time,
        service: $('#service').value,
        requester_name: $('#requester_name').value,
        requester_email: $('#requester_email').value,
        requester_phone: $('#requester_phone').value,
        notes: $('#notes').value,
      },
    });
    $('#codigo').textContent = data.code;
    const final = $('#resumen-final');
    clear(final);
    final.append(
      el('div', {}, 'Cita con ', el('b', { text: data.leader })),
      el('div', { text: longDate(data.date) }),
      el('div', { text: `${hhmmLabel(data.start_time)} a ${hhmmLabel(data.end_time)}` }),
      data.location ? el('div', { text: `Lugar: ${data.location}` }) : null,
      el('div', { text: `Motivo: ${$('#service').value}` }),
    );
    show(nodes.pasos.calendario, false);
    show(nodes.pasos.horarios, false);
    show(nodes.pasos.datos, false);
    show(nodes.pasos.listo, true);
    $('#form-cita').reset();
    nodes.pasos.listo.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    message(nodes.formMsg, err.message);
    if (err.status === 409) await loadMonth(); // el horario se ocupo: refrescar
  } finally {
    btn.disabled = false;
  }
});

$('#otra').addEventListener('click', () => {
  show(nodes.pasos.listo, false);
  show(nodes.pasos.calendario, true);
  state.selectedSlot = null;
  loadMonth();
});

init();
