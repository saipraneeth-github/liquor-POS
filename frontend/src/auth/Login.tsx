import { useState, useEffect } from 'react';
import { useAuth } from './AuthProvider';
import { api } from '../api/client';
import { useNavigate } from 'react-router-dom';

export function Login() {
  const [email, setEmail] = useState('cashier@liquor.com');
  const [password, setPassword] = useState('Password@123');
  const [loginError, setLoginError] = useState('');
  const { login, error: contextError } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (contextError) {
      setLoginError(contextError);
    }
  }, [contextError]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await api.post<{ token: string; user: any }>('/auth/login', {
        email,
        password,
      });
      // Mock user since the API might not return everything needed in the first iteration
      const mockUser = {
        id: '1',
        email,
        name: email.split('@')[0],
        role: email.split('@')[0] as 'owner' | 'manager' | 'cashier' | 'steward'
      };
      login(res.token, res.user || mockUser);
      navigate('/');
    } catch (err: any) {
      setLoginError(err.message || 'Login failed');
    }
  };

  const loginAs = (role: string) => {
    setEmail(`${role}@liquor.com`);
    setPassword('Password@123');
  };

  return (
    <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-900" id="loginPage">
      <div className="w-full max-w-md p-8 bg-white dark:bg-gray-800 rounded-lg shadow-md">
        <h1 className="text-2xl font-bold mb-6 text-center dark:text-white">Liquor Counter POS</h1>
        {loginError && <div className="text-red-500 mb-4 text-center" id="loginError">{loginError}</div>}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1 dark:text-gray-300">Email</label>
            <input
              id="loginEmail"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full p-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 dark:text-gray-300">Password</label>
            <input
              id="loginPass"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full p-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              required
            />
          </div>
          <button
            type="submit"
            id="loginBtn"
            className="w-full bg-purple-600 text-white p-2 rounded hover:bg-purple-700"
          >
            Sign In
          </button>
        </form>
        <div className="mt-4 text-center">
          <div className="text-gray-500 text-sm mb-2">Demo accounts</div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <button type="button" onClick={() => loginAs('owner')} className="p-2 border rounded">👑 Owner</button>
            <button type="button" onClick={() => loginAs('manager')} className="p-2 border rounded">🛠 Manager</button>
            <button type="button" onClick={() => loginAs('cashier')} className="p-2 border rounded">💰 Cashier</button>
            <button type="button" onClick={() => loginAs('steward')} className="p-2 border rounded">🍽 Steward</button>
          </div>
        </div>
      </div>
    </div>
  );
}
