'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, KeyRound, Save, UserRound } from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

type SettingsMessage = { text: string; tone: 'error' | 'success' };

export function AccountSettings({ user }: { user: User }) {
  const [fullName, setFullName] = useState(
    typeof user.user_metadata.full_name === 'string' ? user.user_metadata.full_name : '',
  );
  const [username, setUsername] = useState(
    typeof user.user_metadata.display_name === 'string' ? user.user_metadata.display_name : '',
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sendingResetLink, setSendingResetLink] = useState(false);
  const [message, setMessage] = useState<SettingsMessage | null>(null);

  useEffect(() => {
    let active = true;
    const loadProfile = async () => {
      try {
        const { data, error } = await getSupabaseBrowserClient()
          .from('marketpilot_profiles')
          .select('full_name,display_name')
          .eq('id', user.id)
          .maybeSingle();
        if (error) throw error;
        if (active && data) {
          setFullName(data.full_name);
          setUsername(data.display_name);
        }
      } catch (error) {
        if (active) {
          setMessage({
            text: error instanceof Error ? error.message : 'Account details could not be loaded.',
            tone: 'error',
          });
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    void loadProfile();
    return () => {
      active = false;
    };
  }, [user.id]);

  const saveProfile = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);

    const cleanFullName = fullName.trim();
    const cleanUsername = username.trim();
    if (Array.from(cleanFullName).length < 2 || Array.from(cleanFullName).length > 120) {
      setMessage({ text: 'Full name must be 2–120 characters.', tone: 'error' });
      return;
    }
    if (!/^[A-Za-z0-9_]{3,24}$/.test(cleanUsername)) {
      setMessage({ text: 'Username must be 3–24 characters using letters, numbers, or underscores.', tone: 'error' });
      return;
    }

    setSaving(true);
    try {
      const { error } = await getSupabaseBrowserClient().auth.updateUser({
        data: {
          full_name: cleanFullName,
          display_name: cleanUsername,
        },
      });
      if (error) throw error;
      setFullName(cleanFullName);
      setUsername(cleanUsername);
      setMessage({ text: 'Your account details have been updated.', tone: 'success' });
    } catch (error) {
      setMessage({
        text: error instanceof Error ? error.message : 'Your account details could not be updated.',
        tone: 'error',
      });
    } finally {
      setSaving(false);
    }
  };

  const sendPasswordResetLink = async () => {
    if (!user.email) {
      setMessage({ text: 'No email address is associated with this account.', tone: 'error' });
      return;
    }

    setSendingResetLink(true);
    setMessage(null);
    try {
      const redirectTo = `${window.location.origin}/auth/callback?next=/reset-password`;
      const { error } = await getSupabaseBrowserClient().auth.resetPasswordForEmail(user.email, { redirectTo });
      if (error) throw error;
      setMessage({ text: 'Password reset link sent. Check your email to choose a new password.', tone: 'success' });
    } catch (error) {
      setMessage({
        text: error instanceof Error ? error.message : 'A password reset email could not be sent.',
        tone: 'error',
      });
    } finally {
      setSendingResetLink(false);
    }
  };

  return (
    <section className="account-settings-card" aria-labelledby="account-settings-title">
      <header className="account-settings-heading">
        <span className="account-settings-icon"><UserRound size={18} aria-hidden="true" /></span>
        <div>
          <p className="eyebrow">YOUR ACCOUNT</p>
          <h1 id="account-settings-title">Settings</h1>
          <p>Update your profile and password.</p>
        </div>
      </header>

      {message && (
        <p className={`settings-message is-${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>
          {message.tone === 'success' && <CheckCircle2 size={15} aria-hidden="true" />}
          {message.text}
        </p>
      )}

      <form className="settings-form" onSubmit={(event) => void saveProfile(event)}>
        <label className="settings-field">
          <span>Full name</span>
          <input
            type="text"
            autoComplete="name"
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
            disabled={loading || saving}
            required
          />
        </label>
        <label className="settings-field">
          <span>Username</span>
          <input
            type="text"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            disabled={loading || saving}
            minLength={3}
            maxLength={24}
            required
          />
          <small>3–24 letters, numbers, or underscores.</small>
        </label>
        <label className="settings-field">
          <span>Email address</span>
          <input type="email" value={user.email ?? ''} readOnly />
          <small>Email address changes are not available here.</small>
        </label>
        <button className="settings-save-button" type="submit" disabled={loading || saving}>
          <Save size={15} aria-hidden="true" />
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </form>

      <section className="settings-password-section" aria-labelledby="settings-password-title">
        <div>
          <h2 id="settings-password-title">Password</h2>
          <p>We’ll email a secure link to set a new password.</p>
        </div>
        <button
          className="settings-reset-button"
          type="button"
          onClick={() => void sendPasswordResetLink()}
          disabled={sendingResetLink}
        >
          <KeyRound size={15} aria-hidden="true" />
          {sendingResetLink ? 'Sending link…' : 'Send password reset link'}
        </button>
      </section>
    </section>
  );
}
