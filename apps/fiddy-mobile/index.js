// Polyfills must evaluate before anything that touches @farcaster/core, so this
// import is the FIRST thing the entry point does (see index.js).
import './src/polyfills';

import { registerRootComponent } from 'expo';

import App from './App';

registerRootComponent(App);