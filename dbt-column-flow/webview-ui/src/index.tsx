import { createRoot } from 'react-dom/client';
import { App } from './App';
import reactFlowStyles from '@xyflow/react/dist/style.css';
import { postMessage } from './vscode';

// Inject ReactFlow CSS (esbuild bundles it as a string via loader: { '.css': 'text' })
// plus dark overrides — ReactFlow ships Controls/MiniMap styled for a light canvas.
const style = document.createElement('style');
style.textContent = (reactFlowStyles as unknown as string) + `
  .react-flow__controls { box-shadow: none; }
  .react-flow__controls-button {
    background: #111111;
    border-bottom: 1px solid #2a2a2a;
    fill: #a1a1aa;
  }
  .react-flow__controls-button:hover { background: #1f1f1f; fill: #fafafa; }
  .react-flow__attribution { display: none; }
`;
document.head.appendChild(style);

const root = createRoot(document.getElementById('root')!);
root.render(<App />);

// Signal to extension host that the webview is ready
postMessage({ type: 'ready' });
