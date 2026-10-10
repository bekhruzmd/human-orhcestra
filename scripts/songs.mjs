#!/usr/bin/env node
// Lists the .mid files you dropped into public/songs/ so the Stage and phones can offer them.
// Runs automatically before `npm run dev` and `npm run build`.
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('public/songs', { recursive: true });
const files = readdirSync('public/songs').filter((f) => /\.midi?$/i.test(f)).sort();
writeFileSync('public/songs/index.json', JSON.stringify(files.map((f) => ({ name: f.replace(/\.midi?$/i, ''), file: f }))));
console.log(`songs: ${files.length} custom MIDI file(s) in public/songs/`);
