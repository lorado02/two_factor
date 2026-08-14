import { useState } from 'react';
import AuthForm from './AuthForm';
import Dashboard from './Dashboard';
import './App.css';

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('token'));

  function handleAuthenticated(newToken) {
    localStorage.setItem('token', newToken);
    setToken(newToken);
  }

  function handleLogout() {
    localStorage.removeItem('token');
    setToken(null);
  }

  return (
    <div className="app">
      {token ? (
        <Dashboard token={token} onLogout={handleLogout} />
      ) : (
        <AuthForm onAuthenticated={handleAuthenticated} />
      )}
    </div>
  );
}
