# Fourth Temple Cleanup

A standalone browser-based editor for cleaning up raw Mixamo FBX animations.

It focuses on:

- importing raw FBX files into named animation folders
- adding and moving custom bones
- painting and redistributing skin weights
- editing FK/IK pose corrections and curve keys
- saving cleanup patches next to the imported animation files

Run locally with:

```bash
npm install
npm run dev
```

Then open `http://127.0.0.1:4174`.

## Static hosting

The app is designed to run as a static browser app. Project folders, imported
animation files, and saved cleanup patches use browser-local storage by default,
so the hosted site does not need a write server or database.

Build a static copy with:

```bash
npm run build
```

The build output is written to `dist/`. It includes the app, public assets, and
the runtime dependency files that the browser imports. Local files under
`assets/models/animation-library/` are intentionally excluded from the hosted
build so imported project files are not uploaded accidentally.

This repository includes a GitHub Pages workflow that runs `npm ci`,
`npm run check`, `npm run build`, and deploys `dist/` from pushes to `main`.
For the `fourthtemple/cleanup` project repository, the project page will be
served at `https://fourthtemple.github.io/cleanup/` after GitHub Pages is
enabled for GitHub Actions. The organization homepage at
`https://fourthtemple.github.io/` can link to that project page.
