import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/ui/App';
import '@/index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('找不到 #root 掛載節點');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
