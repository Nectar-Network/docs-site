import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';

export default function Home(): ReactNode {
  return (
    <Layout
      title="Nectar Network Docs"
      description="Documentation for Nectar Network — a pooled liquidation protocol for Soroban DeFi on Stellar."
    >
      <main>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '70vh',
            padding: '2rem',
            textAlign: 'center',
          }}
        >
          <h1 style={{fontSize: '3rem', marginBottom: '0.5rem'}}>
            Nectar Network Documentation
          </h1>
          <p
            style={{
              fontSize: '1.2rem',
              color: 'var(--ifm-color-emphasis-600)',
              maxWidth: '640px',
              marginBottom: '2rem',
            }}
          >
            Pooled liquidation protocol for Soroban DeFi. Deposit USDC, earn
            yield from automated liquidation activity. Run a keeper to operate
            the network.
          </p>
          <div style={{display: 'flex', gap: '1rem', flexWrap: 'wrap', justifyContent: 'center'}}>
            <Link
              to="/docs/getting-started"
              className="button button--primary button--lg"
            >
              Get Started
            </Link>
            <Link
              to="/docs/operators/setup"
              className="button button--outline button--lg"
            >
              Run a Keeper
            </Link>
            <Link
              to="/docs/developers/architecture"
              className="button button--outline button--lg"
            >
              Developer Docs
            </Link>
          </div>
        </div>
      </main>
    </Layout>
  );
}
