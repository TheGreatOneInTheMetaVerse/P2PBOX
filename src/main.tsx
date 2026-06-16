import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import P2PBOXApp from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <P2PBOXApp />
  </StrictMode>,
)
