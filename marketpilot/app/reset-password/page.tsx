import { ResetPasswordForm } from '@/components/auth/reset-password-form';

export default function ResetPasswordPage() {
  return (
    <main className="auth-page">
      <a className="auth-page-brand" href="/">MarketPilot</a>
      <ResetPasswordForm />
    </main>
  );
}
