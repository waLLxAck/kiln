import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import Palette from './Palette';
import './styles.css';
import { startDiagnostics } from './diagnostics';
startDiagnostics();
createRoot(document.getElementById('root')!).render(<React.StrictMode>{location.hash === '#palette' ? <Palette /> : <App />}</React.StrictMode>);
