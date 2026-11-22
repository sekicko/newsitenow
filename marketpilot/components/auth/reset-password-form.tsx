'use client';

import { useState } from 'react';
import { ArrowRight, CheckCircle2, LockKeyhole } from 'lucide-react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

export function ResetPasswordForm() {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [complete, setComplete] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    if (password.length < 8 || !/\d/.test(password)) {
      setMessage({ text: 'Use at least 8 characters and include at least one number.', error: true });
      return;
    }
    if (password !== confirmation) {
      setMessage({ text: 'The passwords do not match.', error: true });
      return;
    }

    setBusy(true);
    try {
      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setComplete(true);
      setMessage({ text: 'Your password has been updated.', error: false });
    } catch (error) {
      const text = error instanceof Error ? error.message : 'The password could not be updated. Request a new reset link and try again.';
      setMessage({ text, error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="reset-card">
      <span className="reset-lock"><LockKeyhole size={20} /></span>
      <p className="eyebrow">SECURE ACCOUNT RECOVERY</p>
      <h1>Choose a new password</h1>
      <p className="reset-subtitle">Create a new password for your MarketPilot account.</p>
      <form className="auth-form" onSubmit={submit}>
        <label className="auth-field">
          <span>New password</span>
          <span className="auth-input-wrap"><LockKeyhole size={15} /><input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></span>
        </label>
        <label className="auth-field">
          <span>Confirm new password</span>
          <span className="auth-input-wrap"><LockKeyhole size={15} /><input type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required /></span>
        </label>
        <small className="password-hint">Use at least 8 characters and include a number.</small>
        {message && (
          <div className={`auth-message ${message.error ? 'error' : 'success'}`} role={message.error ? 'alert' : 'status'}>
            {!message.error && <CheckCircle2 size={16} />}
            <span>{message.text}</span>
          </div>
        )}
        {complete ? (
          <a className="auth-submit reset-back-button" href="/">Return to MarketPilot <ArrowRight size={16} /></a>
        ) : (
          <button className="auth-submit" type="submit" disabled={busy}>
            {busy ? 'Updating password…' : 'Update password'} <ArrowRight size={16} />
          </button>
        )}
      </form>
    </section>
  );
}
