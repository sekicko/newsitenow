'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Eye,
  EyeOff,
  LockKeyhole,
  Mail,
  Phone,
  Search,
  ShieldCheck,
  UserRound,
  X,
} from 'lucide-react';
import { getCountries, getCountryCallingCode, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import type { User } from '@supabase/supabase-js';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import type { WalletAccount, WalletBalances } from '@/lib/wallets';

type AuthMode = 'login' | 'signup' | 'reset';
type AuthMessage = { text: string; tone: 'error' | 'success' | 'info' };
type CountryOption = { code: CountryCode; name: string; callingCode: string };

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const countries: CountryOption[] = getCountries()
  .map((code) => ({
    code,
    name: regionNames.of(code) ?? code,
    callingCode: getCountryCallingCode(code),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

type AuthControlsProps = {
  onUserChange: (user: User | null) => void;
  balances: WalletBalances | null;
  activeWallet: WalletAccount;
  walletLoading: boolean;
  walletError: string;
  onWalletChange: (wallet: WalletAccount) => void;
};

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return 'The account request could not be completed. Please try again.';
}

export function AuthControls({
  onUserChange,
  balances,
  activeWallet,
  walletLoading,
  walletError,
  onWalletChange,
}: AuthControlsProps) {
  const [user, setUser] = useState<User | null>(null);
  const [mode, setMode] = useState<AuthMode | null>(null);
  const [initialMessage, setInitialMessage] = useState<AuthMessage | null>(null);
  const [headerError, setHeaderError] = useState('');
  const [authClient, setAuthClient] = useState<ReturnType<typeof getSupabaseBrowserClient> | null>(null);
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const walletSwitcherRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!walletMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !walletSwitcherRef.current?.contains(event.target)) {
        setWalletMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setWalletMenuOpen(false);
        walletSwitcherRef.current?.querySelector<HTMLButtonElement>('.wallet-switcher-trigger')?.focus();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [walletMenuOpen]);

  useEffect(() => {
    let active = true;
    try {
      const supabase = getSupabaseBrowserClient();
      setAuthClient(supabase);
      supabase.auth.getSession().then(({ data, error }) => {
        if (!active) return;
        if (error) setHeaderError(error.message);
        const nextUser = data.session?.user ?? null;
        setUser(nextUser);
        onUserChange(nextUser);
      }).catch((error: unknown) => {
        if (active) setHeaderError(errorText(error));
      });
      const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
        if (!active) return;
        const nextUser = session?.user ?? null;
        setUser(nextUser);
        onUserChange(nextUser);
        if (session?.user) setMode(null);
      });
      return () => {
        active = false;
        subscription.unsubscribe();
      };
    } catch {
      return () => {
        active = false;
      };
    }
  }, [onUserChange]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('authError') === 'link') {
      setMode('login');
      setInitialMessage({
        text: 'That confirmation or reset link is invalid or has expired. Request a new email link to continue.',
        tone: 'error',
      });
      url.searchParams.delete('authError');
      window.history.replaceState({}, '', url);
    }
  }, []);

  const displayName = user?.user_metadata?.display_name;
  const accountName = typeof displayName === 'string' && displayName ? `@${displayName}` : user?.email ?? 'Account';
  const walletBalanceLabel = (wallet: WalletAccount) => balances
    ? `$${balances[wallet].toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : walletLoading ? 'Loading…' : 'Unavailable';

  const chooseWallet = (wallet: WalletAccount) => {
    onWalletChange(wallet);
    setWalletMenuOpen(false);
    walletSwitcherRef.current?.querySelector<HTMLButtonElement>('.wallet-switcher-trigger')?.focus();
  };

  const signOut = async () => {
    try {
      const supabase = authClient ?? getSupabaseBrowserClient();
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      setHeaderError('');
      onUserChange(null);
    } catch (error) {
      setHeaderError(errorText(error));
    }
  };

  return (
    <>
      {user ? (
        <div className="account-user">
          <span className="account-user-name" title={accountName}><UserRound size={14} />{accountName}</span>
          <div ref={walletSwitcherRef} className={`wallet-switcher wallet-switcher--${activeWallet}`}>
            <button
              type="button"
              className="wallet-switcher-trigger"
              onClick={() => setWalletMenuOpen((open) => !open)}
              aria-controls="wallet-switcher-menu"
              aria-expanded={walletMenuOpen}
              aria-label={`Current wallet: ${activeWallet === 'real' ? 'Real' : 'Demo'}, ${walletBalanceLabel(activeWallet)}. Switch wallet`}
            >
              <span>{activeWallet === 'real' ? 'REAL' : 'DEMO'}</span>
              <strong>{walletBalanceLabel(activeWallet)}</strong>
              <ChevronDown className={walletMenuOpen ? 'is-open' : ''} size={13} />
            </button>
            {walletMenuOpen && (
              <div id="wallet-switcher-menu" className="wallet-menu" role="group" aria-label="Select wallet">
                <span className="wallet-menu-heading">Select wallet</span>
                {(['real', 'demo'] as const).map((wallet) => (
                  <button
                    key={wallet}
                    type="button"
                    className={`wallet-menu-option wallet-menu-option--${wallet}${activeWallet === wallet ? ' is-selected' : ''}`}
                    aria-pressed={activeWallet === wallet}
                    onClick={() => chooseWallet(wallet)}
                    title={wallet === 'real' ? 'Deposits and real-money trading are not enabled' : 'Use the Demo wallet'}
                  >
                    <span className="wallet-menu-option-copy">
                      <strong>{wallet === 'real' ? 'Real' : 'Demo'}</strong>
                      <small>{wallet === 'real' ? 'Real account' : 'Demo account'}</small>
                    </span>
                    <strong className="wallet-menu-option-balance">{walletBalanceLabel(wallet)}</strong>
                    {activeWallet === wallet && <CheckCircle2 size={14} aria-hidden="true" />}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button type="button" className="account-button login-button" onClick={signOut}>Sign out</button>
        </div>
      ) : (
        <div className="account-actions">
          <button type="button" className="account-button login-button" onClick={() => { setInitialMessage(null); setMode('login'); }}>
            Log in
          </button>
          <button type="button" className="account-button signup-button" onClick={() => { setInitialMessage(null); setMode('signup'); }}>
            Create account
          </button>
        </div>
      )}
      {(headerError || walletError) && (
        <span className="auth-header-error" role="status">{headerError || walletError}</span>
      )}
      {mode && (
        <AuthModal
          mode={mode}
          initialMessage={initialMessage}
          setMode={setMode}
          onClose={() => setMode(null)}
        />
      )}
    </>
  );
}

function AuthModal({
  mode,
  initialMessage,
  setMode,
  onClose,
}: {
  mode: AuthMode;
  initialMessage: AuthMessage | null;
  setMode: (mode: AuthMode) => void;
  onClose: () => void;
}) {
  const [fullName, setFullName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [country, setCountry] = useState<CountryCode | ''>('');
  const [countryOpen, setCountryOpen] = useState(false);
  const [countrySearch, setCountrySearch] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<AuthMessage | null>(initialMessage);
  const countryPickerRef = useRef<HTMLDivElement>(null);
  const selectedCountry = useMemo(() => countries.find((item) => item.code === country), [country]);
  const filteredCountries = useMemo(() => {
    const query = countrySearch.trim().toLowerCase();
    const callingCodeQuery = query.replace(/[^\d]/g, '');
    if (!query) return countries;
    return countries.filter((item) =>
      item.name.toLowerCase().includes(query) ||
      item.code.toLowerCase().includes(query) ||
      (!!callingCodeQuery && item.callingCode.startsWith(callingCodeQuery)),
    );
  }, [countrySearch]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        if (countryOpen) {
          setCountryOpen(false);
          return;
        }
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [busy, countryOpen, onClose]);

  useEffect(() => {
    if (!countryOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!countryPickerRef.current?.contains(event.target as Node)) setCountryOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [countryOpen]);

  const chooseCountry = (item: CountryOption) => {
    setCountry(item.code);
    setPhone('');
    setCountrySearch('');
    setCountryOpen(false);
  };

  const openMode = (nextMode: AuthMode) => {
    setMessage(null);
    setMode(nextMode);
  };

  const login = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const supabase = getSupabaseBrowserClient();
      if (identifier.includes('@')) {
        const { error } = await supabase.auth.signInWithPassword({
          email: identifier.trim().toLowerCase(),
          password,
        });
        if (error) throw error;
      } else {
        const parsed = parsePhoneNumberFromString(identifier.trim());
        if (!parsed?.isValid()) {
          throw new Error('Enter your email or your full phone number including its +country code.');
        }
        const response = await fetch('/api/auth/phone-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: parsed.number, password }),
        });
        const result = await response.json() as { error?: string };
        if (!response.ok) throw new Error(result.error ?? 'Phone number or password is incorrect.');
        window.location.assign('/');
        return;
      }
      setMessage({ text: 'You are signed in.', tone: 'success' });
    } catch (error) {
      setMessage({ text: errorText(error), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const signup = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const cleanFullName = fullName.trim();
      const cleanDisplayName = displayName.trim();
      const cleanEmail = email.trim().toLowerCase();
      if (cleanFullName.length < 2) throw new Error('Enter your full name.');
      if (!/^[A-Za-z0-9_]{3,24}$/.test(cleanDisplayName)) {
        throw new Error('Username must be 3–24 characters using letters, numbers, or underscores.');
      }
      if (!country) throw new Error('Choose your country before entering your phone number.');
      const parsedPhone = parsePhoneNumberFromString(phone, country);
      if (!parsedPhone?.isValid() || parsedPhone.country !== country) {
        throw new Error('Enter a valid phone number for the selected country.');
      }
      if (password.length < 8 || !/\d/.test(password)) {
        throw new Error('Use at least 8 characters and include at least one number in your password.');
      }
      if (password !== confirmPassword) throw new Error('The passwords do not match.');
      if (!termsAccepted) throw new Error('You must agree to the Terms and Conditions to create an account.');

      const supabase = getSupabaseBrowserClient();
      const redirectTo = `${window.location.origin}/auth/callback?next=/`;
      const { data, error } = await supabase.auth.signUp({
        email: cleanEmail,
        password,
        options: {
          emailRedirectTo: redirectTo,
          data: {
            full_name: cleanFullName,
            display_name: cleanDisplayName,
            phone_e164: parsedPhone.number,
            terms_accepted_at: new Date().toISOString(),
          },
        },
      });
      if (error) {
        if (error.message.includes('Database error saving new user')) {
          throw new Error('That username or phone number may already be in use. Review your details or sign in instead.');
        }
        throw error;
      }
      if (data.session) {
        setMessage({ text: 'Your account is ready and you are signed in.', tone: 'success' });
      } else {
        setMessage({
          text: 'Account created. Check your email for the confirmation link, then return here to log in.',
          tone: 'success',
        });
      }
    } catch (error) {
      setMessage({ text: errorText(error), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const sendResetLink = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const supabase = getSupabaseBrowserClient();
      const redirectTo = `${window.location.origin}/auth/callback?next=/reset-password`;
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo });
      if (error) throw error;
      setMessage({
        text: 'If an account exists for that email, a password reset link will be sent.',
        tone: 'success',
      });
    } catch (error) {
      setMessage({ text: errorText(error), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="auth-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section className="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-title">
        <button type="button" className="auth-close" onClick={onClose} disabled={busy} aria-label="Close account dialog">
          <X size={18} />
        </button>
        <div className="auth-dialog-brand"><span className="auth-logo"><LockKeyhole size={18} /></span> MarketPilot</div>

        {mode !== 'reset' && (
          <div className="auth-switcher">
            <button type="button" className={mode === 'login' ? 'selected' : ''} onClick={() => openMode('login')}>Log in</button>
            <button type="button" className={mode === 'signup' ? 'selected' : ''} onClick={() => openMode('signup')}>Create account</button>
          </div>
        )}

        <div className="auth-heading">
          <p className="eyebrow">{mode === 'signup' ? 'SET UP YOUR DEMO ACCOUNT' : mode === 'reset' ? 'ACCOUNT RECOVERY' : 'WELCOME BACK'}</p>
          <h2 id="auth-title">{mode === 'signup' ? 'Create your account' : mode === 'reset' ? 'Reset your password' : 'Log in to MarketPilot'}</h2>
          <p>
            {mode === 'signup'
              ? 'Set up your profile to save your demo trade history.'
              : mode === 'reset'
                ? 'We’ll email you a secure link to choose a new password.'
                : 'Use the email or full phone number on your account.'}
          </p>
        </div>

        {mode === 'login' && (
          <form className="auth-form" onSubmit={login}>
            <label className="auth-field">
              <span>Email or phone</span>
              <span className="auth-input-wrap">
                <UserRound size={15} />
                <input
                  type="text"
                  name="username"
                  autoComplete="username"
                  placeholder="name@example.com or +1 555 123 4567"
                  value={identifier}
                  onChange={(event) => setIdentifier(event.target.value)}
                  required
                />
              </span>
              <small>For phone sign-in, include the +country code.</small>
            </label>
            <PasswordField
              label="Password"
              value={password}
              onChange={setPassword}
              visible={showPassword}
              setVisible={setShowPassword}
              autocomplete="current-password"
            />
            <button type="button" className="auth-text-button forgot-link" onClick={() => { setEmail(identifier.includes('@') ? identifier : ''); openMode('reset'); }}>
              Forgot password?
            </button>
            <button className="auth-submit" type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Log in'} <ArrowRight size={16} />
            </button>
          </form>
        )}

        {mode === 'signup' && (
          <form className="auth-form signup-form" onSubmit={signup}>
            <div className="auth-two-columns">
              <label className="auth-field">
                <span>Full name</span>
                <span className="auth-input-wrap"><UserRound size={15} /><input type="text" autoComplete="name" value={fullName} onChange={(event) => setFullName(event.target.value)} maxLength={120} required /></span>
              </label>
              <label className="auth-field">
                <span>Display name (username)</span>
                <span className="auth-input-wrap"><span className="input-at">@</span><input type="text" autoComplete="nickname" value={displayName} onChange={(event) => setDisplayName(event.target.value)} minLength={3} maxLength={24} pattern="[A-Za-z0-9_]{3,24}" required /></span>
              </label>
            </div>
            <label className="auth-field">
              <span>Email address</span>
              <span className="auth-input-wrap"><Mail size={15} /><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></span>
              <small>Required for email sign-in and password recovery.</small>
            </label>
            <div className="auth-field">
              <label id="signup-country-label">Country</label>
              <div className="country-picker" ref={countryPickerRef}>
                <button
                  type="button"
                  id="signup-country"
                  className="country-select-button"
                  aria-labelledby="signup-country-label signup-country-value"
                  aria-haspopup="listbox"
                  aria-expanded={countryOpen}
                  aria-controls="signup-country-options"
                  onClick={() => {
                    setCountrySearch('');
                    setCountryOpen((open) => !open);
                  }}
                >
                  <span id="signup-country-value">
                    {selectedCountry ? `${selectedCountry.name} (+${selectedCountry.callingCode})` : 'Select your country'}
                  </span>
                  <ChevronDown size={15} />
                </button>
                {countryOpen && (
                  <div className="country-dropdown">
                    <label className="country-search-wrap">
                      <Search size={14} />
                      <input
                        type="search"
                        autoFocus
                        aria-label="Search countries by name or calling code"
                        placeholder="Search countries or calling codes"
                        value={countrySearch}
                        onChange={(event) => setCountrySearch(event.target.value)}
                      />
                    </label>
                    <div className="country-options" id="signup-country-options" role="listbox" aria-label="Countries">
                      {filteredCountries.length ? filteredCountries.map((item) => (
                        <button
                          key={item.code}
                          type="button"
                          className={`country-option ${country === item.code ? 'selected' : ''}`}
                          role="option"
                          aria-selected={country === item.code}
                          onClick={() => chooseCountry(item)}
                        >
                          <span>{item.name}</span>
                          <small>{item.code} · +{item.callingCode}</small>
                        </button>
                      )) : (
                        <p className="country-no-results">No matching countries or calling codes.</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
            <label className="auth-field">
              <span>Phone number</span>
              <span className="auth-input-wrap">
                <Phone size={15} />
                {selectedCountry && <span className="phone-country-prefix">+{selectedCountry.callingCode}</span>}
                <input
                  type="tel"
                  className={selectedCountry ? 'has-country-prefix' : ''}
                  autoComplete="tel-national"
                  placeholder={selectedCountry ? 'Phone number' : 'Choose your country first'}
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  disabled={!country}
                  required
                />
              </span>
              {selectedCountry && <small>Saved with country calling code +{selectedCountry.callingCode}.</small>}
            </label>
            <div className="auth-two-columns">
              <PasswordField
                label="Password"
                value={password}
                onChange={setPassword}
                visible={showPassword}
                setVisible={setShowPassword}
                autocomplete="new-password"
              />
              <PasswordField
                label="Confirm password"
                value={confirmPassword}
                onChange={setConfirmPassword}
                visible={showConfirmation}
                setVisible={setShowConfirmation}
                autocomplete="new-password"
              />
            </div>
            <p className="password-hint">Use at least 8 characters and include a number.</p>
            <label className="terms-check">
              <input type="checkbox" checked={termsAccepted} onChange={(event) => setTermsAccepted(event.target.checked)} required />
              <span>I agree to the <a href="/terms" target="_blank" rel="noreferrer">Terms and Conditions</a>.</span>
            </label>
            <button className="auth-submit" type="submit" disabled={busy}>
              {busy ? 'Creating account…' : 'Create account'} <ArrowRight size={16} />
            </button>
          </form>
        )}

        {mode === 'reset' && (
          <form className="auth-form" onSubmit={sendResetLink}>
            <label className="auth-field">
              <span>Email address</span>
              <span className="auth-input-wrap"><Mail size={15} /><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></span>
            </label>
            <button className="auth-submit" type="submit" disabled={busy}>
              {busy ? 'Sending link…' : 'Send reset link'} <ArrowRight size={16} />
            </button>
            <button type="button" className="auth-text-button back-login" onClick={() => openMode('login')}>Back to log in</button>
          </form>
        )}

        {message && (
          <div className={`auth-message ${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>
            {message.tone === 'success' ? <CheckCircle2 size={16} /> : message.tone === 'info' ? <ShieldCheck size={16} /> : <X size={16} />}
            <span>{message.text}</span>
          </div>
        )}

        <div className="auth-security-note"><ShieldCheck size={14} /> Passwords are secured by Supabase Auth.</div>
      </section>
    </div>,
    document.body,
  );
}

function PasswordField({
  label,
  value,
  onChange,
  visible,
  setVisible,
  autocomplete,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  visible: boolean;
  setVisible: (visible: boolean) => void;
  autocomplete: string;
}) {
  return (
    <label className="auth-field">
      <span>{label}</span>
      <span className="auth-input-wrap">
        <LockKeyhole size={15} />
        <input
          type={visible ? 'text' : 'password'}
          autoComplete={autocomplete}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required
        />
        <button type="button" className="password-visibility" onClick={() => setVisible(!visible)} aria-label={visible ? 'Hide password' : 'Show password'}>
          {visible ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </span>
    </label>
  );
}
