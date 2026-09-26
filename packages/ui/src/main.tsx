import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './theme.css';

const container = document.getElementById('root');
// Invariante do `index.html`, nunca texto de tela: sem o `#root` não há React
// para desenhar mensagem nenhuma, e quem lê isto é o console do dev.
if (!container) throw new Error('elemento #root não encontrado'); // i18n-ignore

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
