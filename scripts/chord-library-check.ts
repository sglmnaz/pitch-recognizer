// Self-check for ts/chord-library.ts: picker grouping, keys containing a
// chord, symbol parsing, a marked shape's notes and the match notes. Run with
// `npm run check:chord-library`.
import { CHORD_GROUPS, keysOf, matchNotes, parseChordSymbol, ROOT_LABELS, shapeNotes, voicingCaption } from '../ts/chord-library.ts'
import { CHORD_TYPES, chordType, identifyChords } from '../ts/chord-theory.ts'
import { chordShapes, type Voicing } from '../ts/chord-shapes.ts'
import { pitchClassOf } from '../ts/scales.ts'
import { check, finish } from './check.ts'

const type = (symbol: string) => chordType(symbol)!
const pcs = (...names: string[]) => new Set(names.map(pitchClassOf))

/* Picker ------------------------------------------------------------------ */
const grouped = CHORD_GROUPS.flatMap((g) => g.types)
check('Every chord type in exactly one group', grouped.length === CHORD_TYPES.length && new Set(grouped).size === CHORD_TYPES.length)
check('No empty group', CHORD_GROUPS.every((g) => g.types.length > 0))
check('Triads start with major, minor', CHORD_GROUPS[0].types[0].symbol === '' && CHORD_GROUPS[0].types[1].symbol === 'm')
check('Root labels: 12, each naming its pitch class', ROOT_LABELS.length === 12 && ROOT_LABELS.every((l, pc) => l.split('/').every((n) => pitchClassOf(n) === pc)))

/* In keys ----------------------------------------------------------------- */
const keys = (root: string, symbol: string) => keysOf(pitchClassOf(root), type(symbol)).map((k) => `${k.numeral} ${k.key}`).join(', ')
const KEYS: [string, string, string][] = [
	['C', '', 'I C, IV G, V F, bIII Am, bVI Em, bVII Dm'],
	['C', '7', 'V7 F, bVII7 Dm'],
	['B', 'dim', 'vii° C, ii° Am'],
	['A', 'm', 'ii G, iii F, vi C, i Am, iv Em, v Dm'],
	['C#', '', 'I Db, IV Ab, V Gb, bIII Bbm, bVI Fm, bVII Ebm'], // Db, not C# (7 sharps); Gb, not F#, holds a Db
	['G#', 'm', 'ii F#, iii E, vi B, i G#m, iv D#m, v C#m'], // D#m holds a G#, Ebm an Ab
	['Bb', 'm7', 'ii7 Ab, iii7 Gb, vi7 Db, i7 Bbm, iv7 Fm, v7 Ebm'],
	['F#', '', 'I F#, IV Db, V B, bIII D#m, bVI Bbm, bVII G#m'], // not C# (7 sharps): Db, where it reads Gb
	['C', 'sus4', ''],
	['C', '9', ''],
]
for (const [root, symbol, expected] of KEYS) {
	const got = keys(root, symbol)
	check(`keys of ${root}${symbol}`, got === expected, got || '(none)')
}

/* Symbols ----------------------------------------------------------------- */
const parsed = (s: string) => {
	const p = parseChordSymbol(s)
	return p ? `${p.rootPc} ${p.type.symbol || 'major'}` : 'null'
}
check('parse Am', parsed('Am') === '9 m')
check('parse C#m7', parsed('C#m7') === '1 m7')
check('parse Bbmaj7', parsed('Bbmaj7') === '10 maj7')
check('parse C/E (slash bass ignored)', parsed('C/E') === '0 major')
check('parse unknown', parsed('Cblah') === 'null' && parsed('--') === 'null' && parsed('') === 'null')
check('Every symbol round-trips', CHORD_TYPES.every((t) => parseChordSymbol(`F#${t.symbol}`)?.type === t))

/* Marked shapes ------------------------------------------------------------- */
// Per string as in STRINGS (high E first): C open = x32010 → [0, 1, 0, 2, 3, -1].
const cShape = shapeNotes([0, 1, 0, 2, 3, -1])
check('x32010: notes low string first', cShape.midis.join(' ') === '48 52 55 60 64', cShape.midis.join(' '))
check('x32010: bass C, pcs C E G', cShape.bassPc === 0 && [...cShape.pcs].sort().join(' ') === '0 4 7')
const empty = shapeNotes([-1, -1, -1, -1, -1, -1])
check('Empty shape: nothing, no bass', empty.midis.length === 0 && empty.bassPc === undefined)
// Low E at fret 9 (C#3) under an open A (A2): the bass is the lower pitch.
check('Bass is the lowest pitch, not the lowest string', shapeNotes([-1, -1, -1, -1, 0, 9]).bassPc === pitchClassOf('A'))
const top = identifyChords(cShape.pcs, cShape.bassPc)[0]
check('Marked x32010 identifies as C', top.symbol === 'C', top.symbol)
const eShape = shapeNotes([0, 0, 1, 2, 2, 0])
check('Marked 022100 identifies as E', identifyChords(eShape.pcs, eShape.bassPc)[0].symbol === 'E')
const slash = shapeNotes([0, 1, 0, 2, 3, 0])
check('Marked 032010 identifies as C/E', identifyChords(slash.pcs, slash.bassPc)[0].symbol === 'C/E')

/* Match notes --------------------------------------------------------------- */
const notesOf = (played: Set<number>, bass: string, symbol: string) => {
	const m = identifyChords(played, pitchClassOf(bass)).find((x) => x.symbol === symbol)
	return m ? matchNotes(m, played).join(', ') : 'not found'
}
check('C E G as C: exact', notesOf(pcs('C', 'E', 'G'), 'C', 'C') === '')
check('C E Bb as C7: no 5th', notesOf(pcs('C', 'E', 'Bb'), 'C', 'C7') === 'no 5th')
check('C E G D as C: + add9', notesOf(pcs('C', 'E', 'G', 'D'), 'C', 'C') === '+ add9')
check('C Eb Gb as Cdim7: no bb7', notesOf(pcs('C', 'Eb', 'Gb'), 'C', 'Cdim7') === 'no bb7')

/* Captions ------------------------------------------------------------------ */
const caption = (symbol: string, root: string, i = 0) => {
	const c = voicingCaption(chordShapes(pitchClassOf(root), type(symbol))[i], i)
	return `${c.title} | ${c.position}`
}
check('C first voicing: 1 · x32010 | open', caption('', 'C') === '1 · x32010 | open', caption('', 'C'))
check('F first voicing is a barre at fret 1', caption('', 'F') === '1 · 133211 | barre · fret 1', caption('', 'F'))
const high = voicingCaption({ frets: [8, 8, 9, 10, -1, -1], barre: null, base: 8 } as Voicing, 2)
check('No open string, no barre: 3 · x-x-10-9-8-8 | fret 8', `${high.title} | ${high.position}` === '3 · x-x-10-9-8-8 | fret 8', `${high.title} | ${high.position}`)

finish('All chord library checks passed')
