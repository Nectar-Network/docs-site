import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import styles from './index.module.css';

function HiveMark(): ReactNode {
  return (
    <svg
      width="56"
      height="56"
      viewBox="0 0 48 48"
      fill="none"
      className={styles.mark}
      aria-label="Nectar Network"
      role="img">
      <g stroke="var(--ifm-color-primary)" strokeWidth="2" strokeLinejoin="round" fill="none" opacity="0.5">
        <polygon points="36.82,16.6 43.23,20.3 43.23,27.7 36.82,31.4 30.41,27.7 30.41,20.3" />
        <polygon points="11.18,16.6 17.59,20.3 17.59,27.7 11.18,31.4 4.77,27.7 4.77,20.3" />
        <polygon points="30.41,27.7 36.82,31.4 36.82,38.8 30.41,42.5 24,38.8 24,31.4" />
        <polygon points="30.41,5.5 36.82,9.2 36.82,16.6 30.41,20.3 24,16.6 24,9.2" />
        <polygon points="17.59,27.7 24,31.4 24,38.8 17.59,42.5 11.18,38.8 11.18,31.4" />
        <polygon points="17.59,5.5 24,9.2 24,16.6 17.59,20.3 11.18,16.6 11.18,9.2" />
      </g>
      <polygon points="24,16.6 30.41,20.3 30.41,27.7 24,31.4 17.59,27.7 17.59,20.3" fill="var(--ifm-color-primary)" />
      <path
        d="M20.9 26.84 a3.1 3.1 0 1 0 6.2 0 C27.1 24.36 25.24 21.88 24 20.02 C22.76 21.88 20.9 24.36 20.9 26.84 Z"
        fill="var(--ifm-background-color)"
      />
    </svg>
  );
}

const AUDIENCES = [
  {
    kicker: 'Depositors',
    title: 'Deposit & earn',
    desc: 'Supply USDC to the vault and earn yield from automated Blend liquidations — share-price based, no lockup beyond a short cooldown.',
    to: '/docs/depositors/deposit-guide',
    cta: 'Deposit guide →',
  },
  {
    kicker: 'Operators',
    title: 'Run a keeper',
    desc: 'Stake into the registry and run the Go keeper daemon to fill auctions with pooled capital. Docker or bare metal.',
    to: '/docs/operators/setup',
    cta: 'Operator setup →',
  },
  {
    kicker: 'Developers',
    title: 'Build & integrate',
    desc: 'Read the contract reference, wire up the keeper SDK, or write a ProtocolAdapter for a new protocol.',
    to: '/docs/developers/architecture',
    cta: 'Architecture →',
  },
];

export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout
      title="Documentation"
      description="Documentation for Nectar Network — a pooled liquidation protocol for Soroban DeFi on Stellar.">
      <main>
        <section className={styles.hero}>
          <div className={styles.heroInner}>
            <HiveMark />
            <div className={styles.eyebrow}>Nectar Network Documentation</div>
            <h1 className={styles.title}>
              Pooled liquidations for <span className={styles.accent}>Soroban DeFi</span>
            </h1>
            <p className={styles.subtitle}>
              Depositors pool USDC. Keeper operators use that capital to fill Blend
              Protocol liquidation auctions and return the profit as yield. {siteConfig.tagline}.
            </p>
            <div className={styles.status}>
              <span className={styles.dot}>●</span> Testnet live · SCF&nbsp;#42 Build Award · Blend Protocol
            </div>
            <div className={styles.ctas}>
              <Link className="button button--primary button--lg" to="/docs/getting-started">
                Get Started
              </Link>
              <Link className="button button--secondary button--outline button--lg" to="/docs/how-it-works">
                How It Works
              </Link>
              <Link
                className="button button--secondary button--outline button--lg"
                href="https://github.com/Nectar-Network/keeper-sdk">
                Keeper SDK
              </Link>
            </div>
          </div>
        </section>

        <div className={styles.cards}>
          {AUDIENCES.map((a) => (
            <Link key={a.kicker} className={styles.card} to={a.to}>
              <div className={styles.cardKicker}>{a.kicker}</div>
              <div className={styles.cardTitle}>{a.title}</div>
              <p className={styles.cardDesc}>{a.desc}</p>
              <span className={styles.cardLink}>{a.cta}</span>
            </Link>
          ))}
        </div>
      </main>
    </Layout>
  );
}
