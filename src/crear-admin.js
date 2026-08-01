/**
 * Crea la primera cuenta de administrador en una base de datos limpia,
 * sin los datos de ejemplo de seed.js.
 *
 *   node src/crear-admin.js "Pbro. Andres Gomez" parroco@miparroquia.org
 *
 * La contrasena se toma de la variable ADMIN_PASSWORD o, si no existe, se
 * genera al azar y se imprime UNA sola vez.
 */
import { db, audit } from './db.js';
import { hashPassword, randomToken } from './security.js';
import { email as validarCorreo, password as validarClave, str } from './validate.js';

const [nombreArg, correoArg] = process.argv.slice(2);

if (!nombreArg || !correoArg) {
  console.error('Uso: node src/crear-admin.js "Nombre completo" correo@dominio.org');
  process.exit(1);
}

try {
  const nombre = str(nombreArg, 'nombre', { min: 3, max: 120 });
  const correo = validarCorreo(correoArg);
  const clave = process.env.ADMIN_PASSWORD || `${randomToken(9)}A1`;
  validarClave(clave);

  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(correo)) {
    console.error(`Ya existe una cuenta con el correo ${correo}.`);
    process.exit(1);
  }

  const cambioObligatorio = process.env.ADMIN_PASSWORD ? 0 : 1;
  db.prepare(
    'INSERT INTO users (name, email, role, password_hash, must_change_password) VALUES (?, ?, ?, ?, ?)',
  ).run(nombre, correo, 'admin', hashPassword(clave), cambioObligatorio);
  audit('crear-admin', 'usuario_creado', correo);

  console.log(`\nAdministrador creado: ${correo}`);
  if (!process.env.ADMIN_PASSWORD) {
    console.log(`Contrasena temporal: ${clave}`);
    console.log('Guardela en un gestor de contrasenas y cambiela al ingresar.');
  }
  console.log('\nIngrese en /panel para cargar sus franjas de atencion.');
} catch (err) {
  console.error(err.message);
  process.exit(1);
} finally {
  db.close();
}
