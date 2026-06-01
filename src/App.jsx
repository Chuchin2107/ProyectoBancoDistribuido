import { useState } from 'react';
import './App.css';

const currency = new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'MXN',
});

const apiRequest = async (url, options = {}) => {
  let response;

  try {
    response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      ...options,
    });
  } catch {
    throw new Error('No hay conexion con el backend. Verifica que el nodo de esta sucursal este corriendo.');
  }

  const data = await response.json().catch(async () => ({
    error: await response.text().catch(() => ''),
  }));

  if (!response.ok) {
    throw new Error(data.error || `No se pudo completar la solicitud. Codigo HTTP ${response.status}.`);
  }

  return data;
};

function App() {
  const [vista, setVista] = useState('inicio');
  const [cuenta, setCuenta] = useState(null);
  const [tarjeta, setTarjeta] = useState(null);
  const [nodo, setNodo] = useState(null);
  const [sesion, setSesion] = useState(null);
  const [movimientos, setMovimientos] = useState([]);
  const [numeroTarjeta, setNumeroTarjeta] = useState('');
  const [nip, setNip] = useState('');
  const [monto, setMonto] = useState('');
  const [cuentaDestino, setCuentaDestino] = useState('');
  const [conceptoTransferencia, setConceptoTransferencia] = useState('');
  const [mensaje, setMensaje] = useState('');
  const [cargando, setCargando] = useState(false);

  const saldo = Number(cuenta?.saldo || 0);
  const clienteTitular = cuenta?.clientes?.[0];
  const nombreCliente = clienteTitular
    ? `${clienteTitular.nombre} ${clienteTitular.ap_pat} ${clienteTitular.ap_mat || ''}`.trim()
    : 'Cliente Flux';

  const limpiarFormulario = () => {
    setMonto('');
    setCuentaDestino('');
    setConceptoTransferencia('');
  };

  const refrescarCuenta = async (numeroCuenta = cuenta?.numero_cuenta) => {
    if (!numeroCuenta) return null;

    const cuentaActualizada = await apiRequest(`/api/cuentas/${numeroCuenta}`);
    setCuenta(cuentaActualizada);
    return cuentaActualizada;
  };

  const cargarMovimientos = async (numeroCuenta = cuenta?.numero_cuenta) => {
    if (!numeroCuenta) return;

    const historial = await apiRequest(`/api/transacciones/${numeroCuenta}`);
    setMovimientos(historial);
  };

  const abrirVista = (siguienteVista) => {
    setMensaje('');
    limpiarFormulario();
    setVista(siguienteVista);
  };

  const abrirMovimientos = async () => {
    setMensaje('');
    setVista('movimientos');

    try {
      await cargarMovimientos();
    } catch (error) {
      setMensaje(error.message);
    }
  };

  const iniciarSesion = async (event) => {
    event.preventDefault();
    setMensaje('');
    setCargando(true);

    try {
      const data = await apiRequest('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          numero_tarjeta: numeroTarjeta,
          nip,
        }),
      });

      setCuenta(data.cuenta);
      setTarjeta(data.tarjeta);
      setNodo(data.nodo);
      setSesion(data.sesion);
      setNumeroTarjeta('');
      setNip('');
      setVista('dashboard');
      await cargarMovimientos(data.cuenta.numero_cuenta);
    } catch (error) {
      setMensaje(error.message);
    } finally {
      setCargando(false);
    }
  };

  const procesarMovimiento = async (tipo) => {
    const val = Number(monto);

    if (!cuenta?.numero_cuenta || !Number.isFinite(val) || val <= 0) {
      setMensaje('Ingresa un monto valido.');
      return;
    }

    setMensaje('');
    setCargando(true);

    try {
      await apiRequest('/api/transacciones', {
        method: 'POST',
        body: JSON.stringify({
          numero_cuenta: cuenta.numero_cuenta,
          tipo,
          monto: val,
        }),
      });

      await refrescarCuenta();
      await cargarMovimientos();
      limpiarFormulario();
      setVista('dashboard');
    } catch (error) {
      setMensaje(error.message);
    } finally {
      setCargando(false);
    }
  };

  const procesarTransferencia = async () => {
    const val = Number(monto);

    if (!cuenta?.numero_cuenta || !cuentaDestino || !Number.isFinite(val) || val <= 0) {
      setMensaje('Ingresa cuenta destino y monto valido.');
      return;
    }

    setMensaje('');
    setCargando(true);

    try {
      await apiRequest('/api/transferencias', {
        method: 'POST',
        body: JSON.stringify({
          cuenta_origen: cuenta.numero_cuenta,
          cuenta_destino: cuentaDestino,
          concepto: conceptoTransferencia,
          monto: val,
        }),
      });

      await refrescarCuenta();
      await cargarMovimientos();
      limpiarFormulario();
      setVista('dashboard');
    } catch (error) {
      setMensaje(error.message);
    } finally {
      setCargando(false);
    }
  };

  const cerrarSesion = async () => {
    const cuentaActual = cuenta;
    const sesionActual = sesion;

    setCuenta(null);
    setTarjeta(null);
    setNodo(null);
    setSesion(null);
    setMovimientos([]);
    limpiarFormulario();
    setMensaje('');
    setVista('inicio');

    if (cuentaActual?.numero_cuenta && sesionActual?.session_token) {
      try {
        await apiRequest('/api/auth/logout', {
          method: 'POST',
          body: JSON.stringify({
            numero_cuenta: cuentaActual.numero_cuenta,
            session_token: sesionActual.session_token,
          }),
        });
      } catch {
        // La sesion expira automaticamente si no se puede liberar al cerrar.
      }
    }
  };

  const esIngreso = (tipo) => ['deposito', 'transferencia_entrada'].includes(tipo);

  return (
    <div className="app-container">
      {vista === 'inicio' && (
        <div className="screen-center">
          <h1 className="logo-title">FLUX</h1>
          <p className="slogan">SIMPLIFICANDO TUS FINANZAS</p>
          <button className="btn-primary" onClick={() => setVista('login')}>Seguir</button>
        </div>
      )}

      {vista === 'login' && (
        <div className="screen-center">
          <form className="login-panel" onSubmit={iniciarSesion}>
            <button type="button" className="back-link" onClick={() => setVista('inicio')}>
              Volver
            </button>
            <h2>Acceso a cuenta</h2>
            <p className="muted">Ingresa los datos de tu tarjeta bancaria.</p>

            <label htmlFor="numero_tarjeta">Numero de tarjeta</label>
            <input
              id="numero_tarjeta"
              inputMode="numeric"
              maxLength="16"
              placeholder="16 digitos"
              value={numeroTarjeta}
              onChange={(event) => setNumeroTarjeta(event.target.value.replace(/\D/g, ''))}
            />

            <label htmlFor="nip">NIP</label>
            <input
              id="nip"
              inputMode="numeric"
              type="password"
              maxLength="6"
              placeholder="NIP"
              value={nip}
              onChange={(event) => setNip(event.target.value.replace(/\D/g, ''))}
            />

            {mensaje && <p className="alert">{mensaje}</p>}

            <button className="btn-primary" type="submit" disabled={cargando}>
              {cargando ? 'Validando...' : 'Iniciar sesion'}
            </button>
          </form>
        </div>
      )}

      {vista === 'dashboard' && cuenta && (
        <div className="view-container">
          <header className="topbar">
            <div>
              <h1>Bienvenido, {nombreCliente}</h1>
              <p>Cuenta {cuenta.numero_cuenta} - {cuenta.tipo_cuenta}</p>
            </div>
            <span className="branch-pill">
              {nodo ? `${nodo.nombre_sucursal} - Region ${nodo.region}` : cuenta.sucursal_nombre}
            </span>
          </header>

          <div className="balance-card blue">
            <p>Saldo Disponible</p>
            <h2>{currency.format(saldo)}</h2>
            {tarjeta && <span>Tarjeta terminacion {tarjeta.numero_tarjeta.slice(-4)}</span>}
          </div>

          {mensaje && <p className="alert">{mensaje}</p>}

          <h3>Operaciones Principales</h3>
          <div className="menu-grid">
            <button className="option-card" onClick={() => abrirVista('deposito')}>
              <div className="icon">💰</div>
              <h4>Depositos</h4>
              <p>Suma saldo a tu cuenta</p>
            </button>
            <button className="option-card" onClick={abrirMovimientos}>
              <div className="icon">🔍</div>
              <h4>Consultas</h4>
              <p>Mira tus movimientos</p>
            </button>
            <button className="option-card" onClick={() => abrirVista('retiro')}>
              <div className="icon">🏧</div>
              <h4>Retiros</h4>
              <p>Retira saldo de tu cuenta</p>
            </button>
            <button className="option-card" onClick={() => abrirVista('transferencia')}>
              <div className="icon">💸</div>
              <h4>Transferencias</h4>
              <p>Envia dinero rapido</p>
            </button>
          </div>
          <button className="btn-logout" onClick={cerrarSesion}>Cerrar Sesion</button>
        </div>
      )}

      {vista === 'deposito' && cuenta && (
        <div className="view-container">
          <button className="back-link" onClick={() => setVista('dashboard')}>Volver</button>
          <h2>Depositos</h2>
          <div className="balance-card turquoise">
            <p>Saldo Actual</p>
            <h2>{currency.format(saldo)}</h2>
          </div>
          <div className="form-container">
            <label>Monto a Depositar</label>
            <input type="number" placeholder="$ 0.00" value={monto} onChange={(event) => setMonto(event.target.value)} />
            {mensaje && <p className="alert">{mensaje}</p>}
            <button className="btn-turquoise" onClick={() => procesarMovimiento('deposito')} disabled={cargando}>
              {cargando ? 'Procesando...' : 'Realizar Deposito'}
            </button>
          </div>
        </div>
      )}

      {vista === 'retiro' && cuenta && (
        <div className="view-container">
          <button className="back-link" onClick={() => setVista('dashboard')}>Volver</button>
          <h2>Retiro de efectivo</h2>
          <div className="balance-card blue-gradient">
            <p>Saldo Disponible</p>
            <h2>{currency.format(saldo)}</h2>
          </div>
          <div className="form-container">
            <label>Monto a retirar</label>
            <input type="number" placeholder="Monto $ 0.00" value={monto} onChange={(event) => setMonto(event.target.value)} />
            {mensaje && <p className="alert">{mensaje}</p>}
            <button className="btn-black" onClick={() => procesarMovimiento('retiro')} disabled={cargando}>
              {cargando ? 'Procesando...' : 'Confirmar Retiro'}
            </button>
          </div>
        </div>
      )}

      {vista === 'transferencia' && cuenta && (
        <div className="view-container">
          <button className="back-link" onClick={() => setVista('dashboard')}>Volver</button>
          <h2>Nueva Transferencia</h2>
          <div className="balance-card blue-gradient">
            <p>Saldo Disponible</p>
            <h2>{currency.format(saldo)}</h2>
          </div>
          <div className="form-container">
            <label>Cuenta destino</label>
            <input
              type="text"
              placeholder="Numero de cuenta destino"
              value={cuentaDestino}
              onChange={(event) => setCuentaDestino(event.target.value.replace(/\D/g, ''))}
            />
            <label>Concepto</label>
            <input
              type="text"
              maxLength="140"
              placeholder="Ej. Pago de renta"
              value={conceptoTransferencia}
              onChange={(event) => setConceptoTransferencia(event.target.value)}
            />
            <label>Monto a transferir</label>
            <input type="number" placeholder="Monto $ 0.00" value={monto} onChange={(event) => setMonto(event.target.value)} />
            {mensaje && <p className="alert">{mensaje}</p>}
            <button className="btn-black" onClick={procesarTransferencia} disabled={cargando}>
              {cargando ? 'Procesando...' : 'Confirmar Envio'}
            </button>
          </div>
        </div>
      )}

      {vista === 'movimientos' && cuenta && (
        <div className="view-container">
          <button className="back-link" onClick={() => setVista('dashboard')}>Volver</button>
          <h2>Historial de Movimientos</h2>
          <div className="history-list">
            {movimientos.length === 0 && (
              <div className="empty-state">No hay movimientos registrados.</div>
            )}

            {movimientos.map((movimiento) => (
              <div key={movimiento.id_transaccion} className="history-item">
                <div className="history-info">
                  <strong>{movimiento.concepto || movimiento.tipo.replaceAll('_', ' ')}</strong>
                  <span>{movimiento.fecha} - {movimiento.hora}</span>
                </div>
                <div className={`history-amount ${esIngreso(movimiento.tipo) ? 'ingreso' : 'gasto'}`}>
                  {esIngreso(movimiento.tipo) ? '+' : '-'} {currency.format(Number(movimiento.monto))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
