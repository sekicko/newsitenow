export default function TermsPage() {
  return (
    <main className="terms-page">
      <a className="auth-page-brand" href="/">MarketPilot</a>
      <article className="terms-card">
        <p className="eyebrow">MARKETPILOT</p>
        <h1>Terms and Conditions</h1>
        <p className="terms-updated">Effective November 21, 2026</p>
        <h2>Demo platform</h2>
        <p>MarketPilot is an educational demo tool. Demo trades are simulated, are not live orders, and do not use or risk real funds. No financial, investment, or trading advice is provided.</p>
        <h2>Market information</h2>
        <p>Market symbols, prices, contract conditions, and proposals may be delayed, interrupted, or unavailable. MarketPilot does not guarantee their accuracy or availability. A market data proposal is indicative and does not guarantee a demo outcome.</p>
        <h2>Account details</h2>
        <p>You must provide accurate account details, keep your password confidential, and use only an email address and phone number that you control. Account profile details are stored with the configured Supabase project. Do not use MarketPilot for unlawful activity.</p>
        <h2>Availability and changes</h2>
        <p>Features may change or become unavailable. You may stop using the service at any time. These terms should be reviewed and completed for the operator and jurisdiction before public launch.</p>
        <a className="terms-back" href="/">Back to MarketPilot</a>
      </article>
    </main>
  );
}
