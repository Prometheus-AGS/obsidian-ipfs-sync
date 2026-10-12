import React from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import styles from './index.module.css';

const sections = ['Setup', 'Concepts', 'CLI', 'Security', 'Limitations', 'Evidence'];

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
              cloud.
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
              Placeholder sections — content lands with the docs-03 change.
            </p>
            <ul className={styles.sectionList}>
              {sections.map(section => (
                <li key={section} className={styles.sectionCard}>
                  {section}
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>
    </Layout>
  );
}
