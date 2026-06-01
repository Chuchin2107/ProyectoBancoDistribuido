# Flux Banco

Aplicacion bancaria React + Express. El backend sirve el frontend compilado y expone la API REST sobre PostgreSQL usando `pg.Pool`.

## Configuracion

Cada nodo debe tener su propio `.env`:

```ini
PUERTO_INTERFAZ=3000
ID_SUCURSAL=1
REGION_BANCARIA="Norte"
ID_NODO="Norte-1"
NOMBRE_SUCURSAL="Sucursal Norte 1"
LOCALIDAD_SUCURSAL="Norte"
DB_HOST="localhost"
DB_USER="postgres"
DB_PASSWORD="tu_password"
DB_NAME="banco_regional"
DB_PORT=5432
DB_SSL=false
DB_POOL_MAX=10
DB_CONNECTION_TIMEOUT_MS=5000
SESSION_TTL_MINUTES=30
```

## Base de datos

`Flux.sql` ya esta convertido a PostgreSQL. Para preparar una base nueva:

```sql
CREATE DATABASE banco_regional;
```

Despues conectate a `banco_regional` y ejecuta el contenido de `Flux.sql`.

El esquema esta preparado para operacion distribuida con:

- `global_id UUID` para identificar registros entre nodos.
- `sucursal_id`, `region` y `nodo_origen` para firmar datos por dispositivo.
- `sincronizado` y `version` para procesos posteriores de replicacion/sincronizacion.
- Indices por nodo, sucursal, region y fecha de transaccion.

Para probar el inicio de sesion, debe existir una tarjeta activa ligada a una cuenta:

```sql
INSERT INTO tarjeta (
  id_cuenta,
  numero_tarjeta,
  nip,
  fecha_expiracion,
  sucursal_id,
  region,
  nodo_origen
)
SELECT
  id_cuenta,
  '1234567890123456',
  1234,
  CURRENT_DATE + INTERVAL '2 years',
  id_sucursal,
  region,
  nodo_origen
FROM cuenta
WHERE numero_cuenta = '10001';
```

## API

- `POST /api/cuentas`
  - Body: `{ "numero_cuenta": "10001", "cliente": "Juan Perez", "saldo_inicial": 500, "tipo_cuenta": "debito" }`
  - Tambien acepta `cliente` como objeto con `nombre`, `ap_pat`, `ap_mat` y `direccion`.

- `POST /api/auth/login`
  - Body: `{ "numero_tarjeta": "1234567890123456", "nip": "1234" }`
  - Valida tarjeta activa, NIP y fecha de expiracion.
  - Bloquea la cuenta para que no pueda abrirse desde otro nodo mientras la sesion este activa.

- `POST /api/auth/logout`
  - Libera el bloqueo de sesion de la cuenta.

- `GET /api/estado-db`
  - Confirma la conexion activa con PostgreSQL.

- `GET /api/cuentas/:numero_cuenta`
  - Regresa cuenta, sucursal y clientes ligados.

- `POST /api/transacciones`
  - Body: `{ "numero_cuenta": "10001", "tipo": "deposito", "monto": 100 }`
  - `tipo` puede ser `deposito` o `retiro`.

- `POST /api/transferencias`
  - Body: `{ "cuenta_origen": "10001", "cuenta_destino": "10002", "monto": 100, "concepto": "Pago de renta" }`
  - Valida que existan ambas cuentas y que la cuenta origen tenga saldo suficiente.

- `GET /api/transacciones/:numero_cuenta`
  - Regresa el historial de movimientos de la cuenta.

## Ejecucion

```bash
npm install
npm start
```

## Dos nodos locales

Para simular dos sucursales en la misma maquina, abre dos terminales:

```bash
npm run nodo:norte
```

Norte queda en:

```text
http://localhost:3000
```

En otra terminal:

```bash
npm run nodo:sur
```

Sur queda en:

```text
http://localhost:5173
```

Ambos nodos usan la misma configuracion de PostgreSQL del `.env`, pero cada puerto firma sus inserciones con una identidad distinta:

- `3000`: `ID_SUCURSAL=1`, `REGION_BANCARIA=Norte`, `ID_NODO=Norte-1`
- `5173`: `ID_SUCURSAL=2`, `REGION_BANCARIA=Sur`, `ID_NODO=Sur-2`

Cuando uses `5173` como sucursal Sur, no tengas corriendo `npm run dev`, porque Vite tambien intenta ocupar ese puerto.
