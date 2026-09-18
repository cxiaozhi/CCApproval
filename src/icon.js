'use strict';
/**
 * The app mark.
 *
 * The files in assets/ are the deliverables; assets/icon.svg is the source of truth
 * and `npm run icon` regenerates the rasters from it. Nothing here draws anything —
 * serving an icon is handing out bytes, so a missing or broken image toolchain can
 * never take the panel down with it.
 *
 * server.js answers these routes *before* the token check: a <link rel=icon> is a
 * page-relative GET that cannot carry `?t=`, so gating them would only ever put a
 * broken-image default in the tab. They expose no log data.
 */
const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'assets');

const ROUTES = {
  '/favicon.svg': { file: 'icon.svg', contentType: 'image/svg+xml; charset=utf-8' },
  '/favicon.ico': { file: 'icon.ico', contentType: 'image/x-icon' },
  '/icon-180.png': { file: 'icon-180.png', contentType: 'image/png' },
  '/icon-512.png': { file: 'icon-512.png', contentType: 'image/png' }
};

const cache = new Map();

/**
 * @param {string} pathname
 * @returns {{contentType: string, body: Buffer}|null} null for anything that is not an
 *   icon, and for an icon whose file is missing — either way the request falls through
 *   to the normal routing instead of 500ing.
 */
function iconFor(pathname) {
  if (!Object.prototype.hasOwnProperty.call(ROUTES, pathname)) return null;
  const route = ROUTES[pathname];
  if (!cache.has(route.file)) {
    try {
      cache.set(route.file, fs.readFileSync(path.join(ASSETS, route.file)));
    } catch {
      return null;
    }
  }
  return { contentType: route.contentType, body: cache.get(route.file) };
}

module.exports = { iconFor, ASSETS };
