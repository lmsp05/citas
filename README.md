# Agenda de citas eclesiasticas

Aplicativo web para que una parroquia publique la disponibilidad de sus lideres
(parroco, vicarios, agentes de pastoral) y las personas soliciten una cita en un
horario libre.

- **Publico**: elegir lider, ver un calendario con los dias que tienen cupos,
  escoger la hora, dejar sus datos y recibir un codigo para consultar o cancelar.
- **Lideres**: definir franjas de atencion semanales, registrar ausencias,
  confirmar o cancelar solicitudes y ver su agenda.
- **Administrador**: crear y desactivar cuentas, restablecer contrasenas y
  revisar el registro de auditoria.

Sin dependencias de terceros: solo Node.js 22+ y su SQLite integrado.
La guia de seguridad, confiabilidad y hosting esta en
[`docs/GUIA-SEGURIDAD-Y-DESPLIEGUE.md`](docs/GUIA-SEGURIDAD-Y-DESPLIEGUE.md).

## Puesta en marcha

```bash
cp .env.example .env      # ajuste parroquia, zona horaria y secretos
npm run seed              # crea datos de ejemplo e imprime las contrasenas
npm start                 # http://127.0.0.1:3000
npm test                  # 15 pruebas: disponibilidad, reservas, permisos, CSRF
```

Para empezar en limpio, sin datos de ejemplo: borre `data/citas.db` y cree la
primera cuenta de administrador.

```bash
node src/crear-admin.js "Pbro. Andres Gomez" parroco@miparroquia.org
```

Rutas: `/` solicitar cita, `/consulta` consultar o cancelar, `/panel` lideres.

## Estructura

```
src/config.js     configuracion por variables de entorno
src/db.js         esquema SQLite e indices (incluye el unico que evita doble reserva)
src/security.js   scrypt, sesiones, CSRF, rate limiting, cabeceras
src/validate.js   validacion de toda entrada del usuario
src/time.js       hora local de la parroquia (sin depender del navegador)
src/slots.js      calculo de disponibilidad: reglas - bloqueos - citas
src/routes.js     API HTTP
src/server.js     servidor, archivos estaticos, mantenimiento periodico
src/crear-admin.js  primera cuenta de administrador (base de datos limpia)
public/           interfaz (HTML + CSS + JS sin framework)
test/             pruebas de extremo a extremo con node:test
```

## Decisiones de diseno

- **La disponibilidad se calcula, no se guarda.** Cada consulta parte de las
  franjas semanales del lider, resta ausencias y citas vivas. No hay huecos
  fantasma que sincronizar.
- **Doble reserva imposible**: indice unico parcial sobre
  `(leader_id, date, start_time)` para citas pendientes o confirmadas.
- **Hora local de la parroquia** en toda la agenda (`APP_TIMEZONE`).
- **Datos minimos**: nombre, correo y telefono opcional. Los datos personales
  de citas antiguas se anonimizan solos segun `RETENTION_DAYS`.
- **Sin framework en el navegador**: el DOM se construye con `textContent`, lo
  que hace inviable la inyeccion de HTML, y permite una CSP estricta.

## Seguridad implementada

Contrasenas con scrypt y sal; sesiones con token aleatorio guardado como hash,
cookie `HttpOnly` + `SameSite=Strict` + `Secure`; CSRF por doble verificacion
(`Origin` + `X-CSRF-Token`); limites de intentos de login por IP y por cuenta;
limites de reservas por IP y por correo; consultas SQL parametrizadas;
validacion estricta de entradas; cabeceras `CSP`, `HSTS`, `X-Frame-Options`,
`nosniff`, `Referrer-Policy`, `Permissions-Policy`; registro de auditoria;
IP almacenada solo como hash; separacion de roles lider/administrador.

Detalle y tareas pendientes (2FA, correo, respaldos) en la guia de `docs/`.
