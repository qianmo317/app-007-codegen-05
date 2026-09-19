import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import Home from './pages/Home';
import Plan from './pages/Plan';
import PrintView from './pages/PrintView';
import LayoutPlanner from './pages/LayoutPlanner';

function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/plan/:id" element={<Plan />} />
        <Route path="/plan/:id/layout" element={<LayoutPlanner />} />
        <Route path="/plan/:id/print" element={<PrintView />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}

export default App;
