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
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options,
    });
  } catch {
    throw new Error('No hay conexion con el backend.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Error en la solicitud.');
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

  // NUEVO: Estado para rol de usuario
  const [rol, setRol] = useState('usuario'); 

  const saldo = Number(cuenta?.saldo || 0);
  const nombreCliente = cuenta?.clientes?.[0] ? `${cuenta.clientes[0].nombre} ${cuenta.clientes[0].ap_pat}` : 'Usuario';

  // --- Lógica de Auth actualizada ---
  const iniciarSesion = async (event) => {
    event.preventDefault();
    setCargando(true);
    try {
      const data = await apiRequest('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ numero_tarjeta: numeroTarjeta, nip }),
      });
      setCuenta(data.cuenta);
      setTarjeta(data.tarjeta);
      setNodo(data.nodo);
      setSesion(data.sesion);
      setRol(data.rol || 'usuario'); // El backend debe enviar el rol
      setVista(data.rol === 'admin' ? 'admin-dashboard' : 'dashboard');
    } catch (error) {
      setMensaje(error.message);
    } finally {
      setCargando(false);
    }
  };

  const abrirVista = (siguienteVista) => { setMensaje(''); setVista(siguienteVista); };
  
  const cerrarSesion = () => {
    setCuenta(null); setVista('inicio'); setRol('usuario');
  };

  return (
    <div className="app-container">

      {vista === 'inicio' && (
        <div className="screen-center">
          <h1 className="logo-title">FLUX</h1>
          <button className="btn-primary" onClick={() => setVista('login')}>Seguir</button>
        </div>
      )}

      {vista === 'login' && (
        <div className="screen-center">
          <form className="login-panel" onSubmit={iniciarSesion}>
            <input placeholder="Tarjeta" value={numeroTarjeta} onChange={(e) => setNumeroTarjeta(e.target.value)} />
            <input type="password" placeholder="NIP" value={nip} onChange={(e) => setNip(e.target.value)} />
            <button type="submit">Iniciar sesion</button>
          </form>
        </div>
      )}

 
      {vista === 'admin-dashboard' && (
        <div className="view-container">
          <h2>Panel de Control - Administrador</h2>
          <div className="menu-grid">
            <button className="option-card" onClick={() => abrirVista('admin-workers')}>
              <h4>⚙️ Gestión de Workers</h4>
            </button>
          </div>
          <button className="btn-logout" onClick={cerrarSesion}>Cerrar Sesión</button>
        </div>
      )}

      {vista === 'admin-workers' && (
        <div className="view-container">
          <button onClick={() => abrirVista('admin-dashboard')}>Volver</button>
          <h2>Estado de los Workers</h2>
          
          <p>Implementar lógica de monitoreo aquí.</p>
        </div>
      )}

      {vista === 'dashboard' && cuenta && (
         <div className="view-container">
            <h1>Bienvenido {nombreCliente}</h1>
            {/* ... tus otras opciones ... */}
            <button onClick={cerrarSesion}>Cerrar Sesion</button>
         </div>
      )}
    </div>
  );
}

export default App;
