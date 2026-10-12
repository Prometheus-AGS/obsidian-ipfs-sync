import React from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import styles from './index.module.css';

const sections = [
  {label: 'Setup', to: '/docs/setup-desktop', note: 'Desktop and mobile install'},
  {label: 'Concepts', to: '/docs/how-it-works', note: 'The snapshot sync model'},
  {label: 'CLI', to: '/docs/cli-reference', note: 'Commands, flags, exit codes'},
  {label: 'Security', to: '/docs/security', note: 'Threat model, stated plainly'},
  {label: 'Limitations', to: '/docs/limitations', note: 'Limits and troubleshooting'},
  {label: 'Evidence', to: '/docs/evidence', note: 'What actually ran'},
];

export default function Home() {
  return (
    <Layout
      title="IPFS Sync for Obsidian"
      description="Sync your vault over IPFS through a kubo node you run or trust."
    >
      <main className={styles.main}>
        <section className={styles.hero} aria-labelledby="home-title">
          <div className="container">
            <p className={styles.eyebrow}>IPFS Sync for Obsidian</p>
            <h1 id="home-title">Sync your vault over IPFS.</h1>
            <p className={styles.lead}>
              Through a kubo node you run or trust. No Obsidian Sync subscription, no third-party
              cloud. There is no default node.
            </p>
            <div className={styles.actions}>
              <Link className="button button--primary button--lg" to="/docs/intro">
                Read the docs
              </Link>
            </div>
          </div>
        </section>

        <section className={styles.map} aria-labelledby="map-title">
          <div className="container">
            <h2 id="map-title">Documentation map</h2>
            <p className={styles.mapNote}>
              Honest docs: what is verified, what is not, and what is only designed — each page
              says which.
            </p>
            <ul className={styles.sectionList}>
              {sections.map(section => (
                <li key={section.label} className={styles.sectionCard}>
                  <Link to={section.to}>{section.label}</Link>
                  <p>{section.note}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>
    </Layout>
  );
}
