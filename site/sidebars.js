// @ts-check

// Sidebar for the docs-03 content set. Every entry names a real document:
// onBrokenLinks: 'throw' makes a dangling id a build failure.

/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  docsSidebar: [
    'intro',
    {
      type: 'category',
      label: 'Setup',
      items: ['setup-desktop', 'setup-mobile'],
    },
    {
      type: 'category',
      label: 'Concepts',
      items: ['how-it-works', 'security'],
    },
    {
      type: 'category',
      label: 'Reference',
      items: ['cli-reference', 'limitations', 'evidence', 'roadmap', 'coverage-matrix'],
    },
  ],
};

module.exports = sidebars;
