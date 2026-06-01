import { config } from 'dotenv';

config();

const profiles = {
  norte: {
    PUERTO_INTERFAZ: '3000',
    ID_SUCURSAL: '1',
    REGION_BANCARIA: 'Norte',
    ID_NODO: 'Norte-1',
    NOMBRE_SUCURSAL: 'Sucursal Norte 1',
    LOCALIDAD_SUCURSAL: 'Norte',
  },
  sur: {
    PUERTO_INTERFAZ: '5173',
    ID_SUCURSAL: '2',
    REGION_BANCARIA: 'Sur',
    ID_NODO: 'Sur-2',
    NOMBRE_SUCURSAL: 'Sucursal Sur 2',
    LOCALIDAD_SUCURSAL: 'Sur',
  },
};

const profileName = process.argv[2];
const profile = profiles[profileName];

if (!profile) {
  console.error(`Perfil de nodo invalido: ${profileName || '(vacio)'}`);
  console.error(`Perfiles disponibles: ${Object.keys(profiles).join(', ')}`);
  process.exit(1);
}

Object.assign(process.env, profile);

await import('../server/index.js');
