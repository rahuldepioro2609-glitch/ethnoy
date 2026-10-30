/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { X, LogIn, User, ShieldCheck, Building2, CheckCircle2, Lock } from 'lucide-react';
import { apiRequest } from '../api';

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLoginSuccess: (user: { name: string; role: string; id: string }) => void;
}

export const LoginModal: React.FC<LoginModalProps> = ({ isOpen, onClose, onLoginSuccess }) => {
  const [role, setRole] = useState<'candidate' | 'center' | 'official'>('candidate');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loggedInNotice, setLoggedInNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const { user } = await apiRequest<{
        user: { id: string; loginId: string; name: string; role: 'candidate' | 'center' | 'official' };
      }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ loginId: username.trim(), password, role }),
      });
      const roleLabels = {
        candidate: 'Registered Candidate',
        center: 'Test Center Admin',
        official: 'Assessment Official',
      };
      setLoggedInNotice(`Signed in as ${user.name} (${roleLabels[user.role]})`);
      onLoginSuccess({ name: user.name, role: roleLabels[user.role], id: user.loginId });
      onClose();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'Sign in failed. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/75 backdrop-blur-xs flex items-center justify-center p-3 sm:p-6 animate-in fade-in duration-150">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-md overflow-hidden my-6">
        {/* Top Navy Bar */}
        <div className="bg-[#0F172A] text-white px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-emerald-500/20 text-emerald-400 rounded-lg">
              <LogIn className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold leading-none">
                National Portal Login
              </h2>
              <span className="text-xs text-slate-400">
                Unified Authentication Gateway
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            aria-label="Close login dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <div className="p-6 space-y-5">
          {/* Role Tabs */}
          <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100 rounded-xl text-xs font-semibold">
            <button
              onClick={() => setRole('candidate')}
              className={`py-2 rounded-lg transition-colors flex items-center justify-center gap-1 ${
                role === 'candidate' ? 'bg-white text-slate-900 shadow-2xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <User className="w-3.5 h-3.5" />
              <span>Candidate</span>
            </button>
            <button
              onClick={() => setRole('center')}
              className={`py-2 rounded-lg transition-colors flex items-center justify-center gap-1 ${
                role === 'center' ? 'bg-white text-slate-900 shadow-2xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Building2 className="w-3.5 h-3.5" />
              <span>Center</span>
            </button>
            <button
              onClick={() => setRole('official')}
              className={`py-2 rounded-lg transition-colors flex items-center justify-center gap-1 ${
                role === 'official' ? 'bg-white text-slate-900 shadow-2xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Official</span>
            </button>
          </div>

          {loggedInNotice && (
            <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>{loggedInNotice}</span>
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-4">
            {error && (
              <div role="alert" className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs">
                {error}
              </div>
            )}
            <div>
              <label htmlFor="portal-login-id" className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                {role === 'candidate' ? 'Application Number / Roll No' : 'Staff / Node ID'}
              </label>
              <input
                id="portal-login-id"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-mono font-bold focus:ring-2 focus:ring-emerald-500 focus:outline-hidden uppercase"
                required
              />
            </div>

            <div>
              <label htmlFor="portal-login-pass" className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                Password / Passkey
              </label>
              <input
                id="portal-login-pass"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-mono focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                required
              />
            </div>

            <div className="pt-2 space-y-2">
              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full py-3 bg-[#10B981] hover:bg-[#059669] text-white font-bold text-xs rounded-xl shadow-md transition-colors flex items-center justify-center gap-1.5 uppercase tracking-wider"
              >
                <Lock className="w-4 h-4" />
                <span>{isSubmitting ? 'Signing In…' : 'Secure Sign In'}</span>
              </button>
            </div>
          </form>

          <div className="text-[11px] text-slate-400 text-center border-t border-slate-100 pt-3">
            Accounts must be provisioned by a portal administrator.
          </div>
        </div>
      </div>
    </div>
  );
};
