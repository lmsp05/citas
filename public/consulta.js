import { $, api, clear, el, hhmmLabel, longDate, message, show } from './common.js';

let current = null;

api('/api/config')
  .then((cfg) => { $('#parish-name').textContent = cfg.parish; })
  .catch(() => { /* la pagina sigue siendo utilizable */ });

const ESTADO_TEXTO = {
  pendiente: 'Pendiente de confirmacion por el lider',
  confirmada: 'Confirmada: le esperamos',
  cancelada: 'Cancelada',
  atendida: 'Atendida',
};

function render(appt) {
  const detalle = $('#detalle');
  clear(detalle);
  detalle.append(
    el('div', {}, 'Estado: ', el('span', { class: `tag ${appt.status}`, text: ESTADO_TEXTO[appt.status] })),
    el('div', {}, 'Con ', el('b', { text: appt.leader })),
    el('div', { text: longDate(appt.date) }),
    el('div', { text: `${hhmmLabel(appt.start_time)} a ${hhmmLabel(appt.end_time)}` }),
    el('div', { text: `Motivo: ${appt.service}` }),
    el('div', { text: `A nombre de: ${appt.requester_name}` }),
    appt.leader_note ? el('div', { text: `Nota del lider: ${appt.leader_note}` }) : null,
  );
  $('#cancelar').hidden = appt.status === 'cancelada' || appt.status === 'atendida';
  show($('#resultado'), true);
}

$('#form-consulta').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  message($('#msg'), '');
  message($('#msg2'), '');
  try {
    const { appointment } = await api('/api/appointments/consulta', {
      method: 'POST',
      body: { code: $('#code').value, email: $('#email').value },
    });
    current = { code: $('#code').value, email: $('#email').value };
    render(appointment);
  } catch (err) {
    show($('#resultado'), false);
    message($('#msg'), err.message);
  }
});

$('#cancelar').addEventListener('click', async () => {
  if (!current) return;
  if (!confirm('Confirma que desea cancelar esta cita?')) return;
  try {
    const data = await api('/api/appointments/cancelar', { method: 'POST', body: current });
    message($('#msg2'), data.message || 'Cita cancelada.', 'ok');
    $('#cancelar').hidden = true;
    const { appointment } = await api('/api/appointments/consulta', { method: 'POST', body: current });
    render(appointment);
    message($('#msg2'), 'Su cita fue cancelada. El horario vuelve a estar disponible.', 'ok');
  } catch (err) {
    message($('#msg2'), err.message, 'err');
  }
});
