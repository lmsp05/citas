import { $, api, clear, el, hhmmLabel, longDate, message, show } from './common.js';

const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado'];
const ESTADO_SLOT = {
  libre: 'libre',
  ocupado: 'reservado',
  bloqueado: 'bloqueado',
  fuera_de_plazo: 'ya paso el plazo',
  pendiente: 'pendiente',
  confirmada: 'confirmada',
};
const session = { csrf: null, user: null };

const post = (path, body) => api(path, { method: 'POST', body, csrf: session.csrf });
const del = (path) => api(path, { method: 'DELETE', csrf: session.csrf });

api('/api/config').then((cfg) => { $('#parish-name').textContent = cfg.parish; }).catch(() => {});

// --------------------------------------------------------------- sesion ---

async function restore() {
  try {
    const data = await api('/api/auth/me');
    session.csrf = data.csrf;
    session.user = data.user;
    enterPanel();
  } catch {
    show($('#login-card'), true);
  }
}

$('#form-login').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  message($('#login-msg'), '');
  try {
    const data = await post('/api/auth/login', { email: $('#email').value, password: $('#password').value });
    session.csrf = data.csrf;
    session.user = data.user;
    $('#password').value = '';
    enterPanel();
  } catch (err) {
    message($('#login-msg'), err.message);
  }
});

$('#salir').addEventListener('click', async (ev) => {
  ev.preventDefault();
  try { await post('/api/auth/logout', {}); } catch { /* la sesion ya no existe */ }
  location.reload();
});

function enterPanel() {
  show($('#login-card'), false);
  show($('#panel'), true);
  show($('#salir'), true);
  $('#quien').textContent = `${session.user.name} (${session.user.role})`;
  show($('#aviso-clave'), !!session.user.must_change_password);
  if (session.user.role === 'admin') show($('#tab-admin'), true);
  $('#p-title').value = session.user.title || '';
  $('#p-bio').value = session.user.bio || '';
  const hoy = new Date().toISOString().slice(0, 10);
  $('#filtro-desde').value = hoy;
  $('#b-desde').value = hoy;
  $('#b-hasta').value = hoy;
  for (let i = 0; i < 7; i++) $('#r-weekday').append(el('option', { value: i, text: DIAS[i] }));
  loadAppointments();
}

// ---------------------------------------------------------------- tabs ---

const TABS = {
  solicitudes: { node: '#tab-solicitudes', load: loadAppointments },
  agenda: { node: '#tab-agenda', load: loadAgenda },
  disponibilidad: { node: '#tab-disponibilidad', load: loadAvailability },
  cuenta: { node: '#tab-cuenta', load: () => {} },
  admin: { node: '#tab-admin-panel', load: loadAdmin },
};

for (const button of document.querySelectorAll('[role="tab"]')) {
  button.addEventListener('click', () => {
    for (const other of document.querySelectorAll('[role="tab"]')) {
      other.setAttribute('aria-selected', String(other === button));
    }
    for (const [name, tab] of Object.entries(TABS)) {
      show($(tab.node), name === button.dataset.tab);
    }
    TABS[button.dataset.tab].load();
  });
}

// --------------------------------------------------------- solicitudes ---

async function loadAppointments() {
  const params = new URLSearchParams();
  if ($('#filtro-estado').value) params.set('status', $('#filtro-estado').value);
  if ($('#filtro-desde').value) params.set('from', $('#filtro-desde').value);
  if ($('#filtro-hasta').value) params.set('to', $('#filtro-hasta').value);
  const tbody = $('#tabla-solicitudes');
  try {
    const { appointments } = await api(`/api/panel/appointments?${params}`);
    clear(tbody);
    if (appointments.length === 0) {
      tbody.append(el('tr', {}, el('td', { colspan: 6, class: 'muted', text: 'No hay citas con ese filtro.' })));
      return;
    }
    for (const appt of appointments) {
      tbody.append(el('tr', {},
        el('td', { text: longDate(appt.date) }),
        el('td', { text: `${hhmmLabel(appt.start_time)}-${hhmmLabel(appt.end_time)}` }),
        el('td', {},
          el('div', { text: appt.requester_name }),
          el('div', { class: 'muted', text: appt.requester_email }),
          appt.requester_phone ? el('div', { class: 'muted', text: appt.requester_phone }) : null,
        ),
        el('td', {},
          el('div', { text: appt.service }),
          appt.notes ? el('div', { class: 'muted', text: appt.notes }) : null,
          el('div', { class: 'muted', text: `Codigo ${appt.public_code}` }),
        ),
        el('td', {}, el('span', { class: `tag ${appt.status}`, text: appt.status })),
        el('td', { class: 'right' },
          appt.status === 'pendiente'
            ? el('button', { type: 'button', class: 'small', onclick: () => setStatus(appt, 'confirmada') }, 'Confirmar')
            : null,
          appt.status === 'confirmada'
            ? el('button', { type: 'button', class: 'small', onclick: () => setStatus(appt, 'atendida') }, 'Marcar atendida')
            : null,
          ['pendiente', 'confirmada'].includes(appt.status)
            ? el('button', { type: 'button', class: 'small', onclick: () => setStatus(appt, 'cancelada') }, 'Cancelar')
            : null,
        ),
      ));
    }
    message($('#msg-solicitudes'), '');
  } catch (err) {
    message($('#msg-solicitudes'), err.message);
  }
}

async function setStatus(appt, status) {
  let note = '';
  if (status === 'cancelada') {
    note = prompt('Motivo para la persona (opcional):', '') || '';
  }
  try {
    await post(`/api/panel/appointments/${appt.id}/estado`, { status, leader_note: note });
    loadAppointments();
  } catch (err) {
    message($('#msg-solicitudes'), err.message);
  }
}

$('#recargar').addEventListener('click', loadAppointments);
$('#filtro-estado').addEventListener('change', loadAppointments);

// -------------------------------------------------------------- agenda ---

async function loadAgenda() {
  const container = $('#agenda');
  clear(container);
  const { slots } = await api('/api/panel/agenda');
  if (slots.length === 0) {
    container.append(el('p', { class: 'muted', text: 'No hay franjas configuradas todavia.' }));
    return;
  }
  const byDate = new Map();
  for (const slot of slots) {
    if (!byDate.has(slot.date)) byDate.set(slot.date, []);
    byDate.get(slot.date).push(slot);
  }
  for (const [date, daySlots] of byDate) {
    container.append(el('h3', { text: longDate(date) }));
    const wrap = el('div', { class: 'slots' });
    for (const slot of daySlots) {
      const appt = slot.appointment;
      const label = appt
        ? `${hhmmLabel(slot.start_time)} - ${appt.requester_name} (${ESTADO_SLOT[appt.status]})`
        : `${hhmmLabel(slot.start_time)} - ${ESTADO_SLOT[slot.status]}`;
      wrap.append(el('span', { class: `slot ${appt ? appt.status : slot.status}`, text: label }));
    }
    container.append(wrap);
  }
}

// ------------------------------------------------------ disponibilidad ---

async function loadAvailability() {
  const { rules } = await api('/api/panel/rules');
  const tbody = $('#tabla-reglas');
  clear(tbody);
  if (rules.length === 0) {
    tbody.append(el('tr', {}, el('td', { colspan: 5, class: 'muted', text: 'Aun no hay franjas de atencion.' })));
  }
  for (const rule of rules) {
    tbody.append(el('tr', {},
      el('td', { text: DIAS[rule.weekday] }),
      el('td', { text: `${hhmmLabel(rule.start_time)} a ${hhmmLabel(rule.end_time)}` }),
      el('td', { text: `${rule.slot_minutes} min` }),
      el('td', { text: rule.location || '-' }),
      el('td', { class: 'right' },
        el('button', {
          type: 'button', class: 'small',
          onclick: async () => {
            if (!confirm('Eliminar esta franja? Las citas ya reservadas no se borran.')) return;
            try { await del(`/api/panel/rules/${rule.id}`); loadAvailability(); }
            catch (err) { message($('#msg-reglas'), err.message); }
          },
        }, 'Eliminar'),
      ),
    ));
  }

  const { blocks } = await api('/api/panel/blocks');
  const tb = $('#tabla-bloqueos');
  clear(tb);
  if (blocks.length === 0) {
    tb.append(el('tr', {}, el('td', { colspan: 5, class: 'muted', text: 'Sin ausencias registradas.' })));
  }
  for (const block of blocks) {
    tb.append(el('tr', {},
      el('td', { text: block.date_from }),
      el('td', { text: block.date_to }),
      el('td', { text: block.start_time ? `${block.start_time}-${block.end_time}` : 'Dia completo' }),
      el('td', { text: block.reason || '-' }),
      el('td', { class: 'right' },
        el('button', {
          type: 'button', class: 'small',
          onclick: async () => {
            try { await del(`/api/panel/blocks/${block.id}`); loadAvailability(); }
            catch (err) { message($('#msg-bloqueos'), err.message); }
          },
        }, 'Eliminar'),
      ),
    ));
  }
}

$('#form-regla').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await post('/api/panel/rules', {
      weekday: Number($('#r-weekday').value),
      start_time: $('#r-inicio').value,
      end_time: $('#r-fin').value,
      slot_minutes: Number($('#r-mins').value),
      location: $('#r-lugar').value,
    });
    message($('#msg-reglas'), '');
    loadAvailability();
  } catch (err) {
    message($('#msg-reglas'), err.message);
  }
});

$('#b-todo-el-dia').addEventListener('change', (ev) => {
  $('#b-inicio').disabled = ev.target.checked;
  $('#b-fin').disabled = ev.target.checked;
});

$('#form-bloqueo').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const allDay = $('#b-todo-el-dia').checked;
  try {
    await post('/api/panel/blocks', {
      date_from: $('#b-desde').value,
      date_to: $('#b-hasta').value,
      all_day: allDay,
      start_time: allDay ? undefined : $('#b-inicio').value,
      end_time: allDay ? undefined : $('#b-fin').value,
      reason: $('#b-motivo').value,
    });
    message($('#msg-bloqueos'), '');
    loadAvailability();
  } catch (err) {
    message($('#msg-bloqueos'), err.message);
  }
});

// -------------------------------------------------------------- cuenta ---

$('#form-perfil').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await post('/api/panel/perfil', { title: $('#p-title').value, bio: $('#p-bio').value });
    message($('#msg-perfil'), 'Presentacion actualizada.', 'ok');
  } catch (err) {
    message($('#msg-perfil'), err.message, 'err');
  }
});

$('#form-clave').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await post('/api/auth/password', {
      current_password: $('#c-actual').value,
      new_password: $('#c-nueva').value,
    });
    $('#form-clave').reset();
    show($('#aviso-clave'), false);
    message($('#msg-clave'), 'Contrasena actualizada. Las otras sesiones fueron cerradas.', 'ok');
  } catch (err) {
    message($('#msg-clave'), err.message, 'err');
  }
});

// ------------------------------------------------------ administracion ---

async function loadAdmin() {
  if (session.user.role !== 'admin') return;
  const { users } = await api('/api/admin/users');
  const tbody = $('#tabla-usuarios');
  clear(tbody);
  for (const user of users) {
    tbody.append(el('tr', {},
      el('td', { text: user.name }),
      el('td', { text: user.email }),
      el('td', { text: user.role }),
      el('td', { text: user.active ? 'Activo' : 'Inactivo' }),
      el('td', { class: 'right' },
        el('button', {
          type: 'button', class: 'small',
          onclick: async () => {
            try {
              await post(`/api/admin/users/${user.id}/estado`, { active: !user.active });
              loadAdmin();
            } catch (err) { message($('#msg-usuarios'), err.message); }
          },
        }, user.active ? 'Desactivar' : 'Activar'),
        el('button', {
          type: 'button', class: 'small',
          onclick: async () => {
            const nueva = prompt('Nueva contrasena temporal (minimo 12 caracteres, letras y numeros):');
            if (!nueva) return;
            try {
              await post(`/api/admin/users/${user.id}/password`, { password: nueva });
              message($('#msg-usuarios'), 'Contrasena restablecida. El usuario debera cambiarla.', 'ok');
            } catch (err) { message($('#msg-usuarios'), err.message); }
          },
        }, 'Restablecer clave'),
      ),
    ));
  }

  const { entries } = await api('/api/admin/audit');
  const tb = $('#tabla-auditoria');
  clear(tb);
  for (const entry of entries) {
    tb.append(el('tr', {},
      el('td', { text: entry.at }),
      el('td', { text: entry.actor }),
      el('td', { text: entry.action }),
      el('td', { text: entry.detail }),
    ));
  }
}

$('#form-usuario').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await post('/api/admin/users', {
      name: $('#u-nombre').value,
      email: $('#u-email').value,
      title: $('#u-cargo').value,
      role: $('#u-rol').value,
      password: $('#u-clave').value,
    });
    $('#form-usuario').reset();
    message($('#msg-usuarios'), 'Usuario creado.', 'ok');
    loadAdmin();
  } catch (err) {
    message($('#msg-usuarios'), err.message);
  }
});

restore();
