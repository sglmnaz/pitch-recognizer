// Self-check for Trainer → Songs: the song model (compact bars, repeats and
// endings unrolled, time ↔ quarters, positions for a score without tab), the
// built-in songs, a MusicXML file read through alphaTab, and the player driven
// with a fake audio clock (what is plucked and clicked when, speed, count-in,
// jumps, the A–B loop, the end). Run with `npm run check:songs`. Silent.
import { check, finish } from './check.ts'
import { assignPositions, barQuarters, parseBars, playOrder, quarterAt, STANDARD_TUNING, timeline, type Song, type SongBar } from '../ts/music/song.ts'
import { BUILTIN } from '../ts/music/songs-catalog.ts'
import { importSong, musicXmlMarks, musicXmlTempos } from '../ts/music/song-import.ts'
import { createPlayer, type PlayerOptions } from '../ts/features/songs/songs.player.ts'

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

/* Compact bars ---------------------------------------------------------------- */
{
	const [bar] = parseBars('4:1/0 8.:2/3 16:3/2+4/2 4:r 4:6/3')
	check(
		'compact bars: notes, dotted lengths, chords',
		bar.length === 5 && near(bar[1].length, 0.75) && near(bar[2].at, 1.75) && bar[3].at === bar[2].at && bar[4].at === 3
	)
	check('compact bars: midi from standard tuning', bar[0].midi === 64 && bar[4].midi === 43)
	let threw = 0
	for (const bad of ['4:7/0', '3x:1/0', '4:1/-1', '4'])
		try {
			parseBars(bad)
		} catch {
			threw++
		}
	check('compact bars: bad tokens throw', threw === 4)
}

/* Repeats and endings ------------------------------------------------------------- */
const plain = (n: number, marks: Record<number, Partial<SongBar>> = {}): SongBar[] =>
	Array.from({ length: n }, (_, i) => ({ beats: 4, unit: 4, tempo: 120, ...marks[i] }))
check('no repeats: bars in order', playOrder(plain(4)).join() === '0,1,2,3')
check('a repeat without start goes back to the top', playOrder(plain(3, { 1: { repeatEnd: 2 } })).join() === '0,1,0,1,2')
check('repeat start and end', playOrder(plain(4, { 1: { repeatStart: true }, 2: { repeatEnd: 2 } })).join() === '0,1,2,1,2,3')
check('first and second ending', playOrder(plain(5, { 1: { repeatStart: true }, 2: { endings: 1, repeatEnd: 2 }, 3: { endings: 2 } })).join() === '0,1,2,1,3,4')
check('two passages repeat one after the other', playOrder(plain(4, { 1: { repeatEnd: 2 }, 3: { repeatEnd: 2 } })).join() === '0,1,0,1,2,3,2,3')
// 'E spingole frangese's shape: |: at 2, endings 1-2 on 39–40 (repeat at 40), ending 3 on 41.
{
	const bars = plain(46, { 1: { repeatStart: true }, 38: { endings: 3 }, 39: { endings: 3, repeatEnd: 2 }, 40: { endings: 4 } })
	const order = playOrder(bars)
	const count = (bar: number) => order.filter((b) => b === bar).length
	check(
		'three verses through endings 1-2 and 3',
		order.length === 122 && count(1) === 3 && count(38) === 2 && count(40) === 1 && order.at(-1) === 45,
		`${order.length} bars`
	)
}

/* Timeline --------------------------------------------------------------------- */
{
	const song: Song = {
		id: 't',
		title: 't',
		artist: '',
		bars: [
			{ beats: 4, unit: 4, tempo: 120 },
			{ beats: 6, unit: 8, tempo: 60, repeatEnd: 2 },
		],
		tracks: [],
	}
	const tl = timeline(song)
	check('timeline: bar lengths in quarters and seconds', tl.slots.length === 4 && near(tl.quarters, 4 + 3 + 4 + 3) && near(tl.duration, 2 + 3 + 2 + 3))
	check('timeline: passes counted', tl.slots[2].bar === 0 && tl.slots[2].pass === 2 && tl.slots[2].passes === 2)
	check('timeline: seconds → quarters through each tempo', near(quarterAt(tl, 1), 2) && near(quarterAt(tl, 3.5), 5.5) && near(quarterAt(tl, 99), tl.quarters))
}

/* Positions for a score without tab ----------------------------------------------- */
{
	const at = (midi: number, finger?: number) => [{ midi, finger }]
	const [open, a, gs, d, fs] = assignPositions([at(64, 0), at(69, 4), at(68, 3), at(62, 2), at(66, 1)])
	check('finger 0 = open string', open[0].string === 1 && open[0].fret === 0)
	check(
		'fingers place the hand (position II)',
		a[0].fret === 5 && gs[0].fret === 4 && d[0].string === 2 && d[0].fret === 3 && fs[0].fret === 2,
		JSON.stringify([a, gs, d, fs])
	)
	const [after] = assignPositions([at(66, 1), at(61)]).slice(1)
	check('no fingering: stays in the hand position', after[0].string === 2 && after[0].fret === 2)
	const [chord] = assignPositions([[{ midi: 64 }, { midi: 64 }, { midi: 59 }]])
	check('notes struck together on different strings', new Set(chord.map((p) => p.string)).size === 3)
	const [low] = assignPositions([at(30)])
	check('out of range: no string', low[0].string === 0)
}

/* Built-in songs ------------------------------------------------------------------ */
for (const song of BUILTIN) {
	const notes = song.tracks[0].bars
	const playable = notes.every((bar) =>
		bar.every((n) => n.string >= 1 && n.string <= 6 && n.fret >= 0 && n.fret <= 20 && n.midi === STANDARD_TUNING[n.string - 1] + n.fret)
	)
	const whole = song.bars.every((bar, i) => {
		const end = Math.max(0, ...notes[i].map((n) => n.at + n.length))
		return end <= barQuarters(bar) + 1e-9 && notes[i].every((n, k) => k === 0 || n.at >= notes[i][k - 1].at)
	})
	check(`${song.id}: playable, in order, no bar overfull`, playable && whole && notes.length === song.bars.length)
}
{
	const elise = BUILTIN.find((s) => s.id === 'builtin:fur-elise')!
	const order = playOrder(elise.bars)
	check('Für Elise: pickup, eight bars twice through the endings', order.join() === '0,1,2,3,4,5,6,7,8,1,2,3,4,5,6,7,9')
	let threw = false
	try {
		parseBars('4:1/0 4:1/0 | 2:1/0 4:1/0', () => 2)
	} catch {
		threw = true
	}
	check('compact bars: a bar that does not add up throws (the built-ins all add up)', threw)
}

/* MusicXML through alphaTab ----------------------------------------------------- */
{
	const note = (step: string, octave: number, duration: number, type: string, finger?: number, alter = 0) =>
		`<note><pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch><duration>${duration}</duration><voice>1</voice><type>${type}</type>${
			finger === undefined ? '' : `<notations><technical><fingering>${finger}</fingering></technical></notations>`
		}</note>`
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.0"><movement-title>" Test song "</movement-title>
<identification><creator type="composer">Nobody</creator></identification>
<part-list><score-part id="P1"><part-name>Chitarra</part-name></score-part></part-list>
<part id="P1">
<measure number="1"><attributes><divisions>2</divisions><time><beats>2</beats><beat-type>2</beat-type></time><clef><sign>G</sign><line>2</line></clef>
<transpose><diatonic>0</diatonic><chromatic>0</chromatic><octave-change>-1</octave-change></transpose></attributes><sound tempo="100"/>
${note('E', 5, 2, 'quarter', 0)}${note('A', 5, 2, 'quarter', 4)}${note('G', 5, 2, 'quarter', 3, 1)}${note('D', 5, 2, 'quarter', 2)}</measure>
<measure number="2"><barline location="left"><repeat direction="forward"/></barline>
<direction placement="above"><direction-type><words>Canto</words></direction-type></direction>
${note('F', 5, 4, 'half', 1, 1)}${note('E', 5, 4, 'half')}<barline location="right"><repeat direction="backward"/></barline></measure>
</part></score-partwise>`
	check('MusicXML tempo marks found per measure', musicXmlTempos(xml).get(0) === 100 && musicXmlTempos(xml).size === 1)
	{
		// alphaTab drops these from MusicXML: a hammer-on and a pull-off (on tab), a tie (no tab), after a <backup>.
		const tab = (string: number, fret: number, more = '') => `<technical><string>${string}</string><fret>${fret}</fret>${more}</technical>`
		const marks = musicXmlMarks(`<score-partwise><part id="P1"><measure number="1"><attributes><divisions>2</divisions></attributes>
<note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><notations>${tab(3, 5, '<hammer-on type="start">H</hammer-on>')}</notations></note>
<note><pitch><step>D</step><octave>5</octave></pitch><duration>1</duration><notations>${tab(3, 7, '<hammer-on type="stop"/><pull-off type="start">P</pull-off>')}</notations></note>
<backup><duration>2</duration></backup>
<note><pitch><step>A</step><octave>3</octave></pitch><duration>2</duration><tie type="start"/></note>
</measure><measure number="2"><note><pitch><step>A</step><octave>3</octave></pitch><duration>4</duration><tie type="stop"/><notations><tied type="stop"/></notations></note></measure></part></score-partwise>`)
		check(
			'MusicXML marks: hammer-on, pull-off by string and onset, a tie by pitch class',
			marks.get('0:0:0:s3')?.tech === 'h' &&
				marks.get('0:0:24:s3')?.tech === 'p' &&
				marks.get('1:0:0:pc9') === undefined &&
				marks.get('0:1:0:pc9')?.tied === true,
			JSON.stringify([...marks])
		)
	}
	const song = await importSong(new TextEncoder().encode(xml), 'test.musicxml', 'file:test')
	const [bar1, bar2] = song.tracks[0].bars
	check(
		'MusicXML: title unquoted, artist, meter, tempo from <sound>',
		song.title === 'Test song' && song.artist === 'Nobody' && song.bars[0].beats === 2 && song.bars[0].unit === 2 && song.bars[0].tempo === 100,
		JSON.stringify([song.title, song.artist, song.bars[0]])
	)
	check('MusicXML: sounding pitch (guitar an octave down)', bar1[0].midi === 64 && bar1[1].midi === 69)
	check(
		'MusicXML: positions from the fingering',
		bar1.map((n) => `${n.string}/${n.fret}`).join() === '1/0,1/5,1/4,2/3' && bar2[0].string === 1 && bar2[0].fret === 2,
		bar1.map((n) => `${n.string}/${n.fret}`).join()
	)
	check(
		'MusicXML: words stand in for a section, the repeat is read',
		song.bars[1].section === 'Canto' && song.bars[1].repeatStart === true && (song.bars[1].repeatEnd ?? 0) >= 1
	)
	check('MusicXML: lengths in quarters', bar1[0].length === 1 && bar2[0].length === 2 && bar2[1].at === 2)
	let threw = false
	try {
		await importSong(new TextEncoder().encode('not a score'), 'x.gp5', 'file:bad')
	} catch {
		threw = true
	}
	check('a file that is not a score is refused', threw)
}

/* The player, on a fake clock ---------------------------------------------------- */
{
	const song: Song = {
		id: 'p',
		title: 'p',
		artist: '',
		// 4/4 at 120: a quarter is 0.5 s, a bar 2 s; four bars, one note per beat.
		bars: Array.from({ length: 4 }, () => ({ beats: 4, unit: 4, tempo: 120 })),
		tracks: [
			{
				name: 'g',
				tuning: STANDARD_TUNING,
				bars: parseBars('4:1/0 4:1/1 4:1/2 4:1/3 | 4:2/0 4:2/1 4:2/2 4:2/3 | 4:3/0 4:3/1 4:3/2 4:3/3 | 4:4/0 4:4/1 4:4/2 4:4/3'),
			},
		],
	}
	function rig(options: Partial<PlayerOptions> = {}, heardAfter = 0) {
		let clock = 10
		const plucks: { midi: number; at: number; length: number }[] = []
		const clicks: { at: number; accented: boolean }[] = []
		let ended = 0
		const player = createPlayer(
			song,
			{
				now: () => clock,
				heardAfter: () => heardAfter,
				pluck: (midi, at, length) => plucks.push({ midi, at, length }),
				click: (at, accented) => clicks.push({ at, accented }),
				stop: () => {},
			},
			{ speed: 100, listen: true, click: false, countIn: false, track: 0, ...options },
			() => ended++
		)
		const run = (seconds: number) => {
			for (const end = clock + seconds; clock < end; clock += 0.025) player.tick()
		}
		return { player, plucks, clicks, run, now: () => clock, ended: () => ended }
	}
	{
		const { player, plucks, run } = rig()
		player.play()
		run(2.1)
		check(
			'plays a beat a quarter apart from Play',
			plucks.length >= 4 && near(plucks[0].at, 10.06) && near(plucks[1].at - plucks[0].at, 0.5),
			plucks.map((p) => p.at.toFixed(2)).join()
		)
		check('the strip follows the clock', near(player.position(), 2.1 - 0.06, 0.03) && near(player.quarter(), (2.1 - 0.06) * 2, 0.06))
		check('notes last their length (+ release)', near(plucks[0].length, 0.55))
	}
	{
		const { player, plucks, run } = rig({ speed: 50 })
		player.play()
		run(2.1)
		check('50%: twice as long between notes', near(plucks[1].at - plucks[0].at, 1) && near(player.position(), (2.1 - 0.06) / 2, 0.02))
	}
	{
		const { player, plucks, clicks, run } = rig({ countIn: true })
		player.play()
		run(0.5)
		check(
			'count-in: a bar of clicks, the first accented, notes after it',
			clicks.length === 4 && clicks[0].accented && !clicks[1].accented && plucks.length === 0 && player.countingIn() && player.position() === 0
		)
		run(2)
		check('count-in: the song starts a bar later', near(plucks[0].at, 10.06 + 2))
	}
	{
		const { player, clicks, run } = rig({ click: true })
		player.play()
		run(2.1)
		check('click: on every beat, accent on one', clicks.length >= 5 && clicks[0].accented && !clicks[1].accented && clicks[4].accented)
	}
	{
		const { player, plucks, run } = rig({ listen: false })
		player.play()
		run(1)
		check('listen off: nothing plucked', plucks.length === 0)
	}
	{
		const { player, plucks, run } = rig()
		player.seek(4.2)
		check('stopped: seek moves where Play starts', near(player.position(), 4.2) && player.slot() === 2)
		player.jumpBars(-1)
		check('a bar back: start of the bar before', near(player.position(), 2))
		player.jumpSeconds(5)
		check('five seconds on (at 100%)', near(player.position(), 7))
		player.jumpSeconds(60)
		check('jumps stop at the end', near(player.position(), 8))
		player.jumpBars(-99)
		check('and at the top', player.position() === 0)
		player.seek(2)
		player.play()
		run(0.2)
		check('Play from a seek: the bar there', plucks[0].midi === 59)
		player.pause()
		const at = player.position()
		run(1)
		check('pause holds the position', near(player.position(), at))
	}
	{
		const { player, plucks, run } = rig()
		player.seek(2.5)
		player.mark('a')
		player.seek(4.5)
		player.mark('b')
		player.setLooping(true)
		check('A and B on the bars heard', player.loop().a === 1 && player.loop().b === 2 && player.loop().on)
		player.play()
		run(6)
		const second = plucks.filter((p) => p.midi === 59)
		check(
			'loop: plays bars 2–3, then bar 2 again, never bar 4',
			second.length >= 2 && !plucks.some((p) => p.midi === 50) && near(second[1].at - second[0].at, 4),
			plucks.map((p) => p.midi).join()
		)
		check('loop: the strip wraps with it', player.position() >= 2 && player.position() < 6)
		player.mark('b')
		check('clearing B ends the loop', !player.loop().on && player.loop().b === null)
	}
	{
		// A field bug: going round, the loop scheduled whole rounds at once and the strip
		// stood still for seconds while the notes went on. Heard 250 ms late (Bluetooth).
		const { player, plucks, run } = rig({}, 0.25)
		player.seek(2.5)
		player.mark('a')
		player.mark('b')
		player.setLooping(true)
		player.play()
		run(0.5)
		let last = player.position()
		let stuck = 0
		let longest = 0
		let rounds = 0
		for (let i = 0; i < 600; i++) {
			run(1 / 60)
			const at = player.position()
			if (at < last - 0.5) rounds++
			stuck = Math.abs(at - last) < 1e-9 ? stuck + 1 : 0
			longest = Math.max(longest, stuck)
			last = at
		}
		const gaps = plucks.slice(1).map((p, i) => p.at - plucks[i].at)
		check('loop going round: the strip keeps moving', longest <= 2 && rounds >= 3, `${longest} frames still, ${rounds} rounds`)
		check(
			'loop going round: notes stay a beat apart',
			gaps.every((gap) => near(gap, 0.5)),
			gaps.map((g) => g.toFixed(2)).join()
		)
	}
	{
		const { player, run, ended } = rig()
		player.seek(7)
		player.play()
		run(1.5)
		check('the end: stops and says so', !player.playing() && ended() === 1 && near(player.position(), 8))
		player.play()
		check('Play after the end starts from the top', player.position() === 0)
	}
	{
		const { player, plucks, run } = rig()
		player.play()
		run(1)
		player.setOptions({ speed: 50, listen: true, click: false, countIn: false, track: 0 })
		const before = plucks.length
		run(2)
		const later = plucks.slice(before)
		check('speed changed while playing: carries on from where it was, slower', later.length >= 2 && near(later[1].at - later[0].at, 1))
	}
}

/* Bends, ties and legato in the player ----------------------------------------- */
{
	// 4/4 at 120: a bend, a hammer-on to the next note, a note tied over the bar line.
	const song: Song = {
		id: 'tech',
		title: 'tech',
		artist: '',
		bars: [
			{ beats: 4, unit: 4, tempo: 120 },
			{ beats: 4, unit: 4, tempo: 120 },
		],
		tracks: [
			{
				name: 'g',
				tuning: STANDARD_TUNING,
				bars: [
					[
						{ at: 0, length: 1, string: 2, fret: 8, midi: 67, bend: 2 },
						{ at: 1, length: 1, string: 3, fret: 5, midi: 60, tech: 'h' },
						{ at: 2, length: 1, string: 3, fret: 7, midi: 62 },
						{ at: 3, length: 1, string: 1, fret: 5, midi: 69 },
					],
					[
						{ at: 0, length: 2, string: 1, fret: 5, midi: 69, tied: true },
						{ at: 2, length: 1, string: 1, fret: 8, midi: 72 },
					],
				],
			},
		],
	}
	let clock = 0
	const plucks: { midi: number; length: number; volume: number; bend: number }[] = []
	const player = createPlayer(
		song,
		{
			now: () => clock,
			heardAfter: () => 0,
			pluck: (midi, _at, length, volume, bend) => plucks.push({ midi, length, volume, bend }),
			click: () => {},
			stop: () => {},
		},
		{ speed: 100, listen: true, click: false, countIn: false, track: 0 }
	)
	player.play()
	for (; clock < 5; clock += 0.025) player.tick()
	check('a bend is plucked at the fretted note and pushed up', plucks[0].midi === 67 && plucks[0].bend === 2)
	check('a hammer-on: the next note sounds without a pick, quieter', plucks[1].volume === 1 && plucks[2].volume < 1)
	check(
		'a tie: one pluck that lasts both notes',
		plucks.length === 5 && near(plucks[3].length, 0.5 + 1 + 0.05),
		plucks.map((p) => `${p.midi}:${p.length.toFixed(2)}`).join()
	)
}

finish('Songs: the model, built-in songs, MusicXML import and the player check out.')
