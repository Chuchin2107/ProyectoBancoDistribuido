import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

const requiredEnv = [
  'PUERTO_INTERFAZ',
  'ID_SUCURSAL',
  'REGION_BANCARIA',
  'DB_HOST',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'DB_PORT',
];

const missingEnv = requiredEnv.filter((key) => !process.env[key]);

if (missingEnv.length > 0) {
  throw new Error(`Faltan variables de entorno requeridas: ${missingEnv.join(', ')}`);
}

const port = Number(process.env.PUERTO_INTERFAZ);
const sucursalId = Number(process.env.ID_SUCURSAL);
const dbPort = Number(process.env.DB_PORT);
const regionBancaria = process.env.REGION_BANCARIA;
const nodoOrigen = process.env.ID_NODO || `${regionBancaria}-${sucursalId}`;
const nombreSucursal = process.env.NOMBRE_SUCURSAL || `Sucursal ${sucursalId}`;
const localidadSucursal = process.env.LOCALIDAD_SUCURSAL || regionBancaria;
const dbSsl = process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false;
const sessionTtlMinutes = Number(process.env.SESSION_TTL_MINUTES || 30);
const nodeIdentity = {
  id_sucursal: sucursalId,
  region: regionBancaria,
  id_nodo: nodoOrigen,
  nombre_sucursal: nombreSucursal,
  localidad: localidadSucursal,
  puerto: port,
};

if (!Number.isInteger(port) || port <= 0) {
  throw new Error('PUERTO_INTERFAZ debe ser un numero entero positivo.');
}

if (!Number.isInteger(sucursalId) || sucursalId <= 0) {
  throw new Error('ID_SUCURSAL debe ser un numero entero positivo.');
}

if (!Number.isInteger(dbPort) || dbPort <= 0) {
  throw new Error('DB_PORT debe ser un numero entero positivo.');
}

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: dbPort,
  ssl: dbSsl,
  max: Number(process.env.DB_POOL_MAX || 10),
  connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 5000),
});

const ensureRuntimeSchema = async () => {
  await pool.query(`
    ALTER TABLE transaccion
    ADD COLUMN IF NOT EXISTS concepto VARCHAR(140)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sesion_cuenta (
      numero_cuenta VARCHAR(20) PRIMARY KEY,
      session_token UUID NOT NULL,
      id_sucursal INTEGER NOT NULL,
      region VARCHAR(120) NOT NULL,
      nodo_origen VARCHAR(120) NOT NULL,
      nombre_sucursal VARCHAR(255) NOT NULL,
      abierta_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expira_en TIMESTAMPTZ NOT NULL
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sesion_cuenta_expira_en
    ON sesion_cuenta (expira_en)
  `);
};

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.join(__dirname, '..', 'dist');

app.use(express.json());

app.get('/api/nodo', (_req, res) => {
  res.json(nodeIdentity);
});

app.get('/api/estado-db', async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         NOW() AS fecha_servidor,
         current_database() AS base_datos,
         inet_server_addr() AS host_db,
         inet_server_port() AS puerto_db`,
    );

    return res.json({
      conectado: true,
      ...result.rows[0],
    });
  } catch (error) {
    console.error('Error al validar conexion a PostgreSQL:', error);
    return res.status(503).json({
      conectado: false,
      error: 'No se pudo conectar a PostgreSQL.',
    });
  }
});

const ensureCurrentSucursal = async (client) => {
  await client.query(
    `INSERT INTO sucursal (id_sucursal, nombre, localidad, region, nodo_origen)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id_sucursal)
     DO UPDATE SET
       nombre = EXCLUDED.nombre,
       localidad = EXCLUDED.localidad,
       region = EXCLUDED.region,
       nodo_origen = EXCLUDED.nodo_origen`,
    [sucursalId, nombreSucursal, localidadSucursal, regionBancaria, nodoOrigen],
  );
};

const normalizeCliente = (cliente) => {
  if (typeof cliente === 'object' && cliente !== null) {
    return {
      nombre: String(cliente.nombre || '').trim(),
      apPat: String(cliente.ap_pat || cliente.apellido_paterno || '').trim(),
      apMat: cliente.ap_mat || cliente.apellido_materno || null,
      direccion: cliente.direccion || null,
    };
  }

  return {
    nombre: String(cliente || '').trim(),
    apPat: 'No especificado',
    apMat: null,
    direccion: null,
  };
};

const getCuentaByNumero = async (client, numeroCuenta) => {
  const cuentaResult = await client.query(
    `SELECT
       c.id_cuenta,
       c.global_id,
       c.id_sucursal,
       c.numero_cuenta,
       c.tipo_cuenta,
       c.saldo,
       c.fecha_creacion,
       c.region,
       c.nodo_origen,
       c.version,
       c.sincronizado,
       c.creado_en,
       c.actualizado_en,
       s.nombre AS sucursal_nombre,
       s.localidad AS sucursal_localidad
     FROM cuenta c
     INNER JOIN sucursal s ON s.id_sucursal = c.id_sucursal
     WHERE c.numero_cuenta = $1`,
    [numeroCuenta],
  );

  if (cuentaResult.rowCount === 0) {
    return null;
  }

  const clientesResult = await client.query(
    `SELECT
       cl.id_cliente,
       cl.global_id,
       cl.nombre,
       cl.ap_pat,
       cl.ap_mat,
       cl.direccion,
       cc.rol
     FROM cliente_cuenta cc
     INNER JOIN cliente cl ON cl.id_cliente = cc.id_cliente
     WHERE cc.id_cuenta = $1
     ORDER BY cc.rol, cl.id_cliente`,
    [cuentaResult.rows[0].id_cuenta],
  );

  return {
    ...cuentaResult.rows[0],
    clientes: clientesResult.rows,
  };
};

app.post('/api/auth/login', async (req, res) => {
  const { numero_tarjeta, nip } = req.body;
  const nipNumerico = Number(nip);
  const sessionToken = crypto.randomUUID();

  if (!numero_tarjeta || !Number.isInteger(nipNumerico)) {
    return res.status(400).json({
      error: 'numero_tarjeta y nip son requeridos.',
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `SELECT
         t.id_tarjeta,
         t.numero_tarjeta,
         t.fecha_expiracion,
         t.activa,
         c.numero_cuenta
       FROM tarjeta t
       INNER JOIN cuenta c ON c.id_cuenta = t.id_cuenta
       WHERE t.numero_tarjeta = $1
         AND t.nip = $2
         AND t.activa = TRUE
         AND t.fecha_expiracion >= CURRENT_DATE`,
      [numero_tarjeta, nipNumerico],
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'Tarjeta o NIP incorrectos.' });
    }

    const numeroCuenta = result.rows[0].numero_cuenta;

    await client.query(
      'DELETE FROM sesion_cuenta WHERE expira_en <= NOW()',
    );

    const sessionResult = await client.query(
      `INSERT INTO sesion_cuenta (
         numero_cuenta,
         session_token,
         id_sucursal,
         region,
         nodo_origen,
         nombre_sucursal,
         expira_en
       )
       VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7::TEXT || ' minutes')::INTERVAL)
       ON CONFLICT (numero_cuenta)
       DO UPDATE SET
         session_token = EXCLUDED.session_token,
         id_sucursal = EXCLUDED.id_sucursal,
         region = EXCLUDED.region,
         nodo_origen = EXCLUDED.nodo_origen,
         nombre_sucursal = EXCLUDED.nombre_sucursal,
         abierta_en = NOW(),
         expira_en = EXCLUDED.expira_en
       WHERE sesion_cuenta.nodo_origen = EXCLUDED.nodo_origen
          OR sesion_cuenta.expira_en <= NOW()
       RETURNING *`,
      [
        numeroCuenta,
        sessionToken,
        sucursalId,
        regionBancaria,
        nodoOrigen,
        nombreSucursal,
        sessionTtlMinutes,
      ],
    );

    if (sessionResult.rowCount === 0) {
      const activeSession = await client.query(
        'SELECT * FROM sesion_cuenta WHERE numero_cuenta = $1',
        [numeroCuenta],
      );

      await client.query('ROLLBACK');

      return res.status(409).json({
        error: `La cuenta ${numeroCuenta} ya esta abierta en ${activeSession.rows[0]?.nombre_sucursal || 'otro nodo'}.`,
        sesion_activa: activeSession.rows[0] || null,
      });
    }

    const cuenta = await getCuentaByNumero(client, numeroCuenta);

    await client.query('COMMIT');

    return res.json({
      mensaje: 'Inicio de sesion correcto.',
      nodo: nodeIdentity,
      sesion: {
        session_token: sessionResult.rows[0].session_token,
        expira_en: sessionResult.rows[0].expira_en,
      },
      tarjeta: {
        id_tarjeta: result.rows[0].id_tarjeta,
        numero_tarjeta: result.rows[0].numero_tarjeta,
        fecha_expiracion: result.rows[0].fecha_expiracion,
      },
      cuenta,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al iniciar sesion:', error);
    return res.status(500).json({ error: 'No se pudo iniciar sesion.' });
  } finally {
    client.release();
  }
});

app.post('/api/auth/logout', async (req, res) => {
  const { numero_cuenta, session_token } = req.body;

  if (!numero_cuenta || !session_token) {
    return res.status(400).json({ error: 'numero_cuenta y session_token son requeridos.' });
  }

  try {
    await pool.query(
      `DELETE FROM sesion_cuenta
       WHERE numero_cuenta = $1
         AND session_token = $2
         AND nodo_origen = $3`,
      [numero_cuenta, session_token, nodoOrigen],
    );

    return res.json({ mensaje: 'Sesion cerrada correctamente.' });
  } catch (error) {
    console.error('Error al cerrar sesion:', error);
    return res.status(500).json({ error: 'No se pudo cerrar la sesion.' });
  }
});

app.post('/api/cuentas', async (req, res) => {
  const { numero_cuenta, cliente, saldo_inicial, tipo_cuenta = 'debito' } = req.body;
  const saldoInicial = Number(saldo_inicial);
  const clienteNormalizado = normalizeCliente(cliente);

  if (
    !numero_cuenta
    || !clienteNormalizado.nombre
    || !clienteNormalizado.apPat
    || !['debito', 'credito', 'ahorro'].includes(tipo_cuenta)
    || !Number.isFinite(saldoInicial)
    || saldoInicial < 0
  ) {
    return res.status(400).json({
      error: 'numero_cuenta, cliente, tipo_cuenta y saldo_inicial valido son requeridos.',
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await ensureCurrentSucursal(client);

    const clienteResult = await client.query(
      `INSERT INTO cliente (
         nombre,
         ap_pat,
         ap_mat,
         direccion,
         sucursal_alta_id,
         region,
         nodo_origen
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        clienteNormalizado.nombre,
        clienteNormalizado.apPat,
        clienteNormalizado.apMat,
        clienteNormalizado.direccion,
        sucursalId,
        regionBancaria,
        nodoOrigen,
      ],
    );

    const cuentaResult = await client.query(
      `INSERT INTO cuenta (
         id_sucursal,
         numero_cuenta,
         tipo_cuenta,
         saldo,
         region,
         nodo_origen
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [sucursalId, numero_cuenta, tipo_cuenta, saldoInicial, regionBancaria, nodoOrigen],
    );

    await client.query(
      `INSERT INTO cliente_cuenta (id_cliente, id_cuenta, rol)
       VALUES ($1, $2, 'titular')`,
      [clienteResult.rows[0].id_cliente, cuentaResult.rows[0].id_cuenta],
    );

    await client.query('COMMIT');

    const cuenta = await getCuentaByNumero(pool, numero_cuenta);
    return res.status(201).json(cuenta);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al crear cuenta:', error);

    if (error.code === '23505') {
      return res.status(409).json({ error: 'El numero de cuenta ya existe.' });
    }

    return res.status(500).json({ error: 'No se pudo crear la cuenta.' });
  } finally {
    client.release();
  }
});

app.get('/api/cuentas/:id', async (req, res) => {
  try {
    const cuenta = await getCuentaByNumero(pool, req.params.id);

    if (!cuenta) {
      return res.status(404).json({ error: 'Cuenta no encontrada.' });
    }

    return res.json(cuenta);
  } catch (error) {
    console.error('Error al consultar cuenta:', error);
    return res.status(500).json({ error: 'No se pudo consultar la cuenta.' });
  }
});

app.post('/api/transacciones', async (req, res) => {
  const { numero_cuenta, tipo, monto } = req.body;
  const montoMovimiento = Number(monto);

  if (!numero_cuenta || !['deposito', 'retiro'].includes(tipo) || !Number.isFinite(montoMovimiento) || montoMovimiento <= 0) {
    return res.status(400).json({
      error: "numero_cuenta, tipo ('deposito' o 'retiro') y monto positivo son requeridos.",
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await ensureCurrentSucursal(client);

    const cuentaResult = await client.query(
      'SELECT * FROM cuenta WHERE numero_cuenta = $1 FOR UPDATE',
      [numero_cuenta],
    );

    if (cuentaResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Cuenta no encontrada.' });
    }

    const saldoActual = Number(cuentaResult.rows[0].saldo);
    const nuevoSaldo = tipo === 'deposito'
      ? saldoActual + montoMovimiento
      : saldoActual - montoMovimiento;

    if (nuevoSaldo < 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Saldo insuficiente.' });
    }

    await client.query(
      `UPDATE cuenta
       SET saldo = $1,
           version = version + 1,
           sincronizado = FALSE
       WHERE numero_cuenta = $2`,
      [nuevoSaldo, numero_cuenta],
    );

    const transaccionResult = await client.query(
      `INSERT INTO transaccion (
         id_cuenta,
         tipo,
         monto,
         saldo_resultante,
         cuenta_origen,
         cuenta_destino,
         sucursal_id,
         region,
         nodo_origen
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        cuentaResult.rows[0].id_cuenta,
        tipo,
        montoMovimiento,
        nuevoSaldo,
        tipo === 'retiro' ? numero_cuenta : null,
        tipo === 'deposito' ? numero_cuenta : null,
        sucursalId,
        regionBancaria,
        nodoOrigen,
      ],
    );

    await client.query('COMMIT');

    return res.json({
      mensaje: 'Transaccion procesada correctamente.',
      numero_cuenta,
      nuevo_saldo: nuevoSaldo,
      transaccion: transaccionResult.rows[0],
      sucursal_id: sucursalId,
      region: regionBancaria,
      nodo_origen: nodoOrigen,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al procesar transaccion:', error);
    return res.status(500).json({ error: 'No se pudo procesar la transaccion.' });
  } finally {
    client.release();
  }
});

app.post('/api/transferencias', async (req, res) => {
  const { cuenta_origen, cuenta_destino, monto, concepto } = req.body;
  const montoMovimiento = Number(monto);
  const conceptoTransferencia = String(concepto || 'Transferencia bancaria').trim().slice(0, 140);

  if (!cuenta_origen || !cuenta_destino || cuenta_origen === cuenta_destino) {
    return res.status(400).json({
      error: 'cuenta_origen y cuenta_destino son requeridas y deben ser diferentes.',
    });
  }

  if (!Number.isFinite(montoMovimiento) || montoMovimiento <= 0) {
    return res.status(400).json({ error: 'El monto debe ser mayor a cero.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await ensureCurrentSucursal(client);

    const cuentasResult = await client.query(
      `SELECT *
       FROM cuenta
       WHERE numero_cuenta IN ($1, $2)
       ORDER BY numero_cuenta
       FOR UPDATE`,
      [cuenta_origen, cuenta_destino],
    );

    const cuentaOrigen = cuentasResult.rows.find((cuentaItem) => cuentaItem.numero_cuenta === cuenta_origen);
    const cuentaDestino = cuentasResult.rows.find((cuentaItem) => cuentaItem.numero_cuenta === cuenta_destino);

    if (!cuentaOrigen) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'La cuenta origen no existe.' });
    }

    if (!cuentaDestino) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'La cuenta destino no existe.' });
    }

    const saldoOrigenNuevo = Number(cuentaOrigen.saldo) - montoMovimiento;
    const saldoDestinoNuevo = Number(cuentaDestino.saldo) + montoMovimiento;

    if (saldoOrigenNuevo < 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Saldo insuficiente para realizar la transferencia.' });
    }

    await client.query(
      `UPDATE cuenta
       SET saldo = $1,
           version = version + 1,
           sincronizado = FALSE
       WHERE id_cuenta = $2`,
      [saldoOrigenNuevo, cuentaOrigen.id_cuenta],
    );

    await client.query(
      `UPDATE cuenta
       SET saldo = $1,
           version = version + 1,
           sincronizado = FALSE
       WHERE id_cuenta = $2`,
      [saldoDestinoNuevo, cuentaDestino.id_cuenta],
    );

    const token = crypto.randomUUID();

    const salidaResult = await client.query(
      `INSERT INTO transaccion (
         id_cuenta,
         tipo,
         monto,
         saldo_resultante,
         cuenta_origen,
         cuenta_destino,
         concepto,
         token,
         sucursal_id,
         region,
         nodo_origen
       )
       VALUES ($1, 'transferencia_salida', $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        cuentaOrigen.id_cuenta,
        montoMovimiento,
        saldoOrigenNuevo,
        cuenta_origen,
        cuenta_destino,
        conceptoTransferencia,
        token,
        sucursalId,
        regionBancaria,
        nodoOrigen,
      ],
    );

    const entradaResult = await client.query(
      `INSERT INTO transaccion (
         id_cuenta,
         tipo,
         monto,
         saldo_resultante,
         cuenta_origen,
         cuenta_destino,
         concepto,
         token,
         sucursal_id,
         region,
         nodo_origen
       )
       VALUES ($1, 'transferencia_entrada', $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        cuentaDestino.id_cuenta,
        montoMovimiento,
        saldoDestinoNuevo,
        cuenta_origen,
        cuenta_destino,
        conceptoTransferencia,
        token,
        sucursalId,
        regionBancaria,
        nodoOrigen,
      ],
    );

    await client.query('COMMIT');

    return res.json({
      mensaje: 'Transferencia procesada correctamente.',
      cuenta_origen,
      cuenta_destino,
      nuevo_saldo_origen: saldoOrigenNuevo,
      nuevo_saldo_destino: saldoDestinoNuevo,
      concepto: conceptoTransferencia,
      token,
      transacciones: {
        salida: salidaResult.rows[0],
        entrada: entradaResult.rows[0],
      },
      sucursal_id: sucursalId,
      region: regionBancaria,
      nodo_origen: nodoOrigen,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al procesar transferencia:', error);
    return res.status(500).json({ error: 'No se pudo procesar la transferencia.' });
  } finally {
    client.release();
  }
});

app.get('/api/transacciones/:numero_cuenta', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         t.id_transaccion,
         t.global_id,
         t.tipo,
         t.monto,
         t.saldo_resultante,
         t.cuenta_origen,
         t.cuenta_destino,
         t.concepto,
         t.fecha,
         t.hora,
         t.token,
         t.sucursal_id,
         t.region,
         t.nodo_origen,
         t.sincronizado,
         t.creado_en
       FROM transaccion t
       INNER JOIN cuenta c ON c.id_cuenta = t.id_cuenta
       WHERE c.numero_cuenta = $1
       ORDER BY t.fecha DESC, t.hora DESC, t.id_transaccion DESC`,
      [req.params.numero_cuenta],
    );

    return res.json(result.rows);
  } catch (error) {
    console.error('Error al consultar transacciones:', error);
    return res.status(500).json({ error: 'No se pudo consultar el historial.' });
  }
});

app.use(express.static(distPath));

app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

try {
  await ensureRuntimeSchema();

  app.listen(port, () => {
    console.log(`🚀 Servidor de la Sucursal ${sucursalId} (Región ${regionBancaria}) corriendo en el puerto ${port}`);
  });
} catch (error) {
  console.error('No se pudo inicializar el servidor o validar el esquema de PostgreSQL:', error);
  process.exit(1);
}
