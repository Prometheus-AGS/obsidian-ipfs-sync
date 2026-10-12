// @ts-check

// Sidebar skeleton. The sections the docs-03 content change will fill:
//   Setup, Concepts, CLI, Security, Limitations, Evidence
// They are intentionally not sidebar entries yet: empty categories do not
// build, and entries would dangle — onBrokenLinks: 'throw' is the proof
// that nothing here references a document that does not exist.

/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  docsSidebar: ['intro'],
};

module.exports = sidebars;
