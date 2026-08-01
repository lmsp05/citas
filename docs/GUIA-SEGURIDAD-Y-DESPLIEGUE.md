# Guia para lanzar un servicio web de agendamiento de citas

Esta guia responde tres preguntas antes de publicar el servicio:

1. Que seguridad necesita.
2. Que confiabilidad necesita (que no se pierda ni se duplique una cita).
3. Donde alojarlo, y si su propio computador sirve.

Al final hay una lista de verificacion previa al lanzamiento.

---

## 0. Lo primero: usted va a manejar datos sensibles

Una cita para confesion, direccion espiritual o acompanamiento en duelo revela
**la religion y el estado emocional o de salud de una persona**. En la mayoria
de legislaciones eso no es un dato personal comun, es un **dato sensible**:

- Colombia: Ley 1581 de 2012 y Decreto 1074 de 2015. Los datos sobre
  convicciones religiosas son sensibles (art. 5). Requieren autorizacion
  previa, expresa e informada, y la persona puede negarse a darlos.
  Si maneja mas de 100.000 titulares debe inscribir sus bases en el RNBD ante
  la SIC; aun por debajo de ese umbral aplican todos los demas deberes.
- Espana / UE: RGPD art. 9, misma categoria especial.
- Mexico: LFPDPPP, datos sensibles.

Consecuencias practicas, todas implementadas o previstas en este proyecto:

- **Pedir lo minimo**: nombre, correo, telefono opcional. Nada de documento de
  identidad, direccion ni datos de familiares.
- **El motivo de la cita debe poder ser generico.** La lista incluye "Otro"
  justamente para que nadie se vea obligado a escribir mas de lo que quiere.
- **Aviso de privacidad visible** en el formulario y una politica de
  tratamiento de datos publicada (quien es el responsable, para que se usan,
  cuanto tiempo se guardan, como pedir supresion).
- **Retencion limitada**: `RETENTION_DAYS` anonimiza los datos personales de
  citas pasadas de forma automatica.
- **Acceso restringido**: cada lider ve solo su agenda; nadie mas ve los
  comentarios que la persona escribio.
- **Nunca** publicar en el sitio quien tiene cita a que hora. La vista publica
  solo muestra "libre" u "ocupado" sin nombres.

Si esto le parece mucho, hay una alternativa legitima: que el formulario no
pida el motivo y las citas se manejen como "atencion parroquial" a secas.
Menos datos = menos riesgo y menos obligaciones.

---

## 1. Seguridad

### 1.1 Los riesgos reales de una aplicacion de citas

No es que "lo hackeen" en abstracto. Los ataques concretos son:

| Riesgo | Que pasaria | Como se mitiga en este proyecto |
|---|---|---|
| Inyeccion SQL | Robo o borrado de toda la agenda | Consultas preparadas con parametros, sin concatenar texto |
| XSS (script inyectado) | Robo de sesiones de lideres | El front construye DOM con `textContent`, nunca `innerHTML`; CSP `script-src 'self'` |
| CSRF | Un sitio ajeno cancela citas usando la sesion del lider | Cookie `SameSite=Strict` + verificacion de `Origin` + token `X-CSRF-Token` |
| Fuerza bruta al login | Adivinan la clave del parroco | scrypt lento, limite por IP y por cuenta, mensaje generico, auditoria |
| Robo de cookie de sesion | Suplantacion del lider | Cookie `HttpOnly`, `Secure`, expiracion, rotacion al iniciar sesion |
| Enumeracion de datos | Alguien lista las citas de otros | La consulta publica exige codigo **y** correo; el codigo es aleatorio de 40 bits |
| Spam de reservas | Agenda llena de citas falsas | Limite por IP/hora, limite de citas activas por correo, confirmacion manual del lider |
| Escalada de privilegios | Un lider modifica la agenda de otro | Verificacion de propiedad en cada endpoint + rol admin separado |
| Path traversal | Descarga de `/etc/passwd` o del `.env` | Rutas normalizadas y confinadas a `public/`, extensiones en lista blanca |
| Fuga por logs | Datos personales en logs de terceros | Solo se registran metodo, ruta y estado; las IP se guardan como hash |

### 1.2 Contrasenas y cuentas

- Hash **scrypt** con sal por usuario (nunca MD5, SHA1 ni texto plano).
  Alternativas igual de validas: bcrypt o Argon2id.
- Comparacion en tiempo constante (`timingSafeEqual`).
- Minimo 12 caracteres. Mejor una frase: `LaCatedralDeMiPueblo1876`.
- Contrasena inicial asignada por el administrador con cambio obligatorio.
- Al cambiar la clave se cierran las demas sesiones.
- Desactivar la cuenta de un lider corta sus sesiones de inmediato.
- **Pendiente recomendado si crece el equipo**: segundo factor (TOTP) para las
  cuentas de administrador.

### 1.3 HTTPS: no es opcional

Sin TLS, la contrasena del parroco viaja legible por cualquier wifi. Con
Caddy o Nginx + Let's Encrypt el certificado es gratuito y se renueva solo.
Ponga `SECURE_COOKIES=true` solo cuando ya tenga HTTPS, y active HSTS (ya lo
hace el servidor cuando esa variable esta activa).

### 1.4 Cabeceras que ya envia el servidor

`Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy` y
`Strict-Transport-Security` en produccion. Verifiquelo despues de desplegar en
https://securityheaders.com y https://observatory.mozilla.org.

### 1.5 Secretos y configuracion

- Todo lo sensible va en `.env`, que **no se sube al repositorio**
  (ya esta en `.gitignore`).
- Permisos del archivo: `chmod 600 .env`.
- Si un secreto se filtro alguna vez, se rota: no se "borra del historial" y ya.

### 1.6 Actualizaciones

Este proyecto no tiene dependencias de terceros a proposito: la superficie de
ataque se reduce a Node y al sistema operativo. Aun asi:

- Active actualizaciones automaticas de seguridad del sistema
  (`unattended-upgrades` en Debian/Ubuntu).
- Actualice Node a la ultima LTS al menos cada semestre.
- Si algun dia agrega dependencias npm, revise `npm audit` y fije versiones.

---

## 2. Confiabilidad

### 2.1 Que no haya dos personas en el mismo horario

Es el fallo mas probable y el mas visible ante la comunidad. Aqui se resuelve
con tres capas:

1. La disponibilidad **se calcula**, no se almacena: reglas semanales menos
   bloqueos menos citas vivas. No hay estados que sincronizar.
2. Antes de insertar se vuelve a verificar que el horario siga libre.
3. Un **indice unico parcial** en la base de datos
   (`leader_id + fecha + hora` cuando el estado es `pendiente` o `confirmada`)
   hace imposible la doble reserva incluso si dos personas envian el
   formulario en el mismo instante. La segunda recibe un 409 y elige otro
   horario.

### 2.2 Zona horaria

Todo se guarda y se muestra en la hora local de la parroquia
(`APP_TIMEZONE`). Es la unica forma de que "martes 9:00" signifique lo mismo
para el parroco y para alguien que abra la pagina desde otro pais.

### 2.3 Copias de seguridad (la parte que casi nadie hace)

Regla 3-2-1: **3** copias, en **2** medios distintos, **1** fuera del sitio.

```bash
# Copia consistente de SQLite sin detener el servicio
sqlite3 /ruta/data/citas.db ".backup '/respaldo/citas-$(date +%F).db'"
# Enviarla cifrada fuera del servidor
age -r <clave-publica> /respaldo/citas-$(date +%F).db | \
  rclone rcat b2:mi-bucket/citas-$(date +%F).db.age
```

Programelo diario con `cron` y, sobre todo, **pruebe la restauracion una vez
al mes**. Un respaldo que nunca se restauro no es un respaldo.

Retencion sugerida: 30 diarias, 12 mensuales.

### 2.4 Que el servicio se levante solo

Con systemd (`Restart=always`) o con el reinicio automatico que ofrece el
PaaS. Ademas:

- Monitoreo externo gratuito (UptimeRobot, Better Stack, Healthchecks.io) que
  avise por correo si el sitio cae.
- Revisar los logs al menos semanalmente las primeras semanas.

### 2.5 Cuando SQLite deja de ser suficiente

SQLite aguanta de sobra este caso: una parroquia con decenas de citas al dia y
unos pocos lideres. Piense en PostgreSQL solo si aparece alguno de estos:

- Varias instancias del servidor en paralelo (mas de un proceso escribiendo).
- Decenas de miles de citas al mes o cientos de escrituras por segundo.
- Necesidad de replica en caliente y failover automatico.

El resto del codigo cambiaria poco: las consultas ya son SQL estandar y estan
concentradas en `src/routes.js` y `src/slots.js`.

### 2.6 Correo y recordatorios (siguiente paso natural)

Hoy el sistema entrega un codigo en pantalla. Si quiere confirmaciones y
recordatorios por correo, no monte su propio servidor SMTP: use un proveedor
transaccional (Resend, Postmark, Brevo, Amazon SES) y configure SPF, DKIM y
DMARC en el dominio, o los correos caeran en spam. Para recordatorios por
WhatsApp existe la API de Meta, pero implica costo por mensaje y aprobacion de
plantillas.

---

## 3. Estructura de datos

```
users                 lideres y administradores (rol, hash de clave, estado)
  |
  |-- availability_rules   franjas semanales: dia, hora inicio/fin, minutos por cita
  |-- blocks               ausencias: rango de fechas, opcionalmente rango de horas
  |-- appointments         citas: fecha, hora, estado, datos del solicitante, codigo publico
sessions              sesiones activas (se guarda el hash del token, no el token)
audit_log             quien hizo que y cuando
rate_limits           control de abuso por IP y por cuenta
```

Decisiones que conviene conservar si reescribe esto en otra tecnologia:

- **La disponibilidad no se materializa.** Guardar cada hueco libre como fila
  obliga a regenerarlos, produce huecos fantasma y complica los cambios de
  horario. Calcularlos es mas simple y siempre coherente.
- **Estados explicitos** (`pendiente`, `confirmada`, `cancelada`, `atendida`)
  en lugar de borrar filas: se conserva la historia y se puede auditar.
- **Codigo publico aleatorio** en vez de exponer el `id` numerico: evita que
  alguien recorra `1, 2, 3...` y descubra citas ajenas.
- **Indices** en `(leader_id, date)` y el unico parcial de horario: sin ellos,
  la vista de calendario se vuelve lenta al crecer la tabla.
- **Auditoria separada** de los datos operativos.
- **Hash de IP en vez de IP**: se puede limitar el abuso sin guardar un dato
  personal mas.

---

## 4. Hosting: sirve su propio computador?

### 4.1 Respuesta corta

Para **exponerlo a internet, no**. Para la red interna de la parroquia (solo
la secretaria y los lideres, sin acceso desde fuera), si.

### 4.2 Por que no

| Problema | Detalle |
|---|---|
| Abrir puertos en el router de casa | Su IP publica recibe escaneos automatizados a los pocos minutos. Todo lo que corra ahi queda expuesto, no solo la app |
| Misma red que sus datos personales | Si comprometen el servicio, el atacante esta dentro de su red domestica |
| IP dinamica y CGNAT | Muchos operadores no dan IP publica fija; el sitio se cae al cambiar de IP o directamente no es alcanzable |
| Sin redundancia | Un corte de luz, de internet o un reinicio de Windows deja la parroquia sin agenda |
| Certificados y DNS | Se complican sin IP estable |
| Mantenimiento | Usted es el unico responsable de parches, respaldos, disco y ventiladores |
| Responsabilidad legal | Custodiar datos sensibles en un equipo personal es dificil de justificar ante un reclamo |

### 4.3 Excepciones razonables

- **Solo intranet parroquial**: `HOST=127.0.0.1` o IP local, sin abrir puertos.
- **Equipo dedicado** (una Raspberry Pi o un mini PC), en red separada de sus
  equipos personales, con **Cloudflare Tunnel** o **Tailscale Funnel** para no
  abrir puertos en el router. Es una opcion valida y barata si hay alguien que
  le de mantenimiento.
- Nunca su portatil de trabajo, y nunca con el router en "DMZ".

### 4.4 Proveedores recomendados

Tres caminos, de menos a mas control. Los precios son aproximados
(2026, USD/mes) y conviene verificarlos antes de contratar.

**a) PaaS: usted sube el codigo, ellos operan el servidor.** Lo mas sensato
para una parroquia sin equipo tecnico.

| Proveedor | Aprox. | Notas |
|---|---|---|
| Render | 7 | Muy simple. Requiere disco persistente (`Persistent Disk`) para SQLite |
| Railway | 5-10 | Similar; buen tablero de logs y variables |
| Fly.io | 3-8 | Volumenes persistentes, regiones en Sao Paulo y Santiago (buena latencia en LatAm) |
| Google Cloud Run | 0-5 | Escala a cero, pero el disco es efimero: exigiria mover la base a Postgres/Cloud SQL |
| Deno Deploy / Vercel / Netlify | 0-20 | Pensados para funciones sin estado. **No** sirven tal cual para SQLite en disco |

**b) VPS: una maquina virtual completa.** Mas barato y flexible, exige saber
administrar Linux.

| Proveedor | Aprox. | Notas |
|---|---|---|
| Hetzner | 4-6 | La mejor relacion precio/recursos; centros en Alemania, Finlandia y EE. UU. |
| DigitalOcean | 6-12 | Documentacion excelente para principiantes |
| Vultr / Linode (Akamai) | 5-12 | Nodos en Sao Paulo, Santiago, Mexico |
| AWS Lightsail | 5-12 | Precio fijo dentro del ecosistema AWS |
| Contabo | 5-8 | Muy barato, rendimiento y soporte irregulares |

**c) Hosting compartido tipo cPanel**: evitelo. Casi ninguno soporta procesos
Node persistentes de forma confiable.

**Recomendacion concreta**: si nadie del equipo administra Linux, un PaaS
(Render o Fly.io) con disco persistente y respaldo automatico. Si hay alguien
tecnico, un VPS de 2 GB con Caddy delante, `ufw` cerrando todo salvo 80/443,
SSH solo con llave y `fail2ban`. Presupuesto realista total, con dominio:
**60 a 150 USD al ano**.

### 4.5 Donde alojar los datos

Si la comunidad esta en Colombia, prefiera una region en America (Sao Paulo,
Santiago, Miami) por latencia. Si algun dia atiende personas en la UE, la
region europea simplifica el cumplimiento del RGPD.

### 4.6 Configuracion minima de un VPS

```bash
# Usuario sin privilegios para el servicio
adduser --system --group citas

# Firewall: solo SSH, HTTP y HTTPS
ufw default deny incoming && ufw allow 22,80,443/tcp && ufw enable

# SSH sin contrasena (solo llave) en /etc/ssh/sshd_config
PermitRootLogin no
PasswordAuthentication no
```

`Caddyfile` (obtiene y renueva el certificado TLS automaticamente):

```
citas.miparroquia.org {
    encode gzip
    reverse_proxy 127.0.0.1:3000
}
```

Servicio systemd en `/etc/systemd/system/citas.service`:

```ini
[Unit]
Description=Agenda de citas parroquiales
After=network.target

[Service]
Type=simple
User=citas
WorkingDirectory=/opt/citas
EnvironmentFile=/opt/citas/.env
ExecStart=/usr/bin/node --no-warnings src/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/citas/data

[Install]
WantedBy=multi-user.target
```

---

## 5. Lista de verificacion antes de lanzar

**Seguridad**

- [ ] HTTPS activo y `SECURE_COOKIES=true`
- [ ] `TRUST_PROXY=true` solo si hay proxy inverso propio delante
- [ ] `ALLOWED_ORIGINS` con el dominio real
- [ ] `IP_SALT` cambiado por una cadena aleatoria larga
- [ ] Contrasenas iniciales cambiadas; ninguna compartida entre lideres
- [ ] `.env` fuera del repositorio y con permisos 600
- [ ] Firewall activo, SSH solo con llave
- [ ] Revision en securityheaders.com

**Confiabilidad**

- [ ] Respaldo diario automatico y cifrado, fuera del servidor
- [ ] Restauracion probada al menos una vez
- [ ] Servicio con reinicio automatico
- [ ] Monitoreo externo con alerta por correo
- [ ] `APP_TIMEZONE` correcta

**Datos personales**

- [ ] Politica de tratamiento de datos publicada y enlazada
- [ ] Aviso de privacidad en el formulario
- [ ] `RETENTION_DAYS` acorde a la politica
- [ ] Canal para solicitar consulta, correccion o supresion de datos
- [ ] Solo los lideres necesarios tienen acceso al panel

**Operacion**

- [ ] Franjas de atencion reales cargadas por cada lider
- [ ] Alguien revisa las solicitudes pendientes a diario
- [ ] Telefono o correo de la casa parroquial visible para quien no use internet
- [ ] Probado en telefono movil

---

## 6. Que dejar para despues

En orden de utilidad real:

1. Correo automatico de confirmacion y recordatorio 24 horas antes.
2. Archivo `.ics` para que la cita entre al calendario del lider y del fiel.
3. Segundo factor (TOTP) para administradores.
4. Reprogramacion desde la pagina de consulta.
5. Panel de estadisticas: citas por motivo, ausencias, horas mas solicitadas.
6. Multiples sedes o parroquias en una misma instalacion.
