import type { Page } from '@playwright/test'
import { expect, shot, test } from './fixtures'

// Taps neck cells (string, fret) the way a click lands on them. dispatchEvent:
// a cell can sit outside a horizontally scrolled board on a phone.
async function tapCells(page: Page, neck: string, cells: [number, number][]) {
	for (const [s, f] of cells) await page.locator(`${neck} [data-s="${s}"][data-f="${f}"]`).dispatchEvent('click')
}

// Library diagrams draw as they scroll in (IntersectionObserver): scroll the
// whole page through once so a full-page shot has all of them.
async function scrollThrough(page: Page) {
	await page.evaluate(async () => {
		const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
		for (let y = 0; y < document.body.scrollHeight; y += innerHeight / 2) {
			scrollTo(0, y)
			await frame()
		}
		scrollTo(0, 0)
		await frame()
	})
}

test.describe('tuner', () => {
	test('guitar', async ({ page, open }) => {
		await open('#tuner')
		await shot(page, 'tuner')
	})
	test('chromatic', async ({ page, open }) => {
		await open('#tuner', { tunerMode: 'chromatic' })
		await shot(page, 'tuner-chromatic')
	})
	test('help dialog', async ({ page, open }) => {
		await open('#tuner')
		await page.locator('[data-help="tuner"]').click()
		await expect(page.locator('#help')).toBeVisible()
		await shot(page, 'tuner-help')
	})
})

test.describe('chords', () => {
	test('listen', async ({ page, open }) => {
		await open('#chords')
		await shot(page, 'chords-listen')
	})
	test('library default', async ({ page, open }) => {
		await open('#chords', { chordsMode: 'library' })
		await scrollThrough(page)
		await shot(page, 'chords-library-c', { fullPage: true })
	})
	test('library seventh', async ({ page, open }) => {
		await open('#chords', { chordsMode: 'library' })
		// The native selects stay as the values behind the dropdowns (ts/ui/dropdown.ts).
		await page.locator('select.chord-root-select').selectOption('7', { force: true })
		await page.locator('select.chord-type').selectOption('7', { force: true })
		await scrollThrough(page)
		await shot(page, 'chords-library-g7', { fullPage: true })
	})
	test('library left-handed', async ({ page, open }) => {
		await open('#chords', { chordsMode: 'library', leftHanded: true })
		await expect(page.locator('.voicing--hero')).toHaveScreenshot('chords-library-left-handed.png')
	})
	test('identify empty', async ({ page, open }) => {
		await open('#chords', { chordsMode: 'identify' })
		await shot(page, 'chords-identify')
	})
	test('identify marked', async ({ page, open }) => {
		await open('#chords', { chordsMode: 'identify' })
		await tapCells(page, '.chord-identify .neck', [
			[1, 3],
			[2, 2],
			[3, 0],
			[4, 1],
			[5, 0],
		])
		await shot(page, 'chords-identify-marked')
	})
})

test.describe('scales', () => {
	test('explore', async ({ page, open }) => {
		await open('#scales')
		await shot(page, 'scales-explore')
	})
	test('chord chip', async ({ page, open }) => {
		await open('#scales')
		await page.locator('.harmony-chords .harmony-chord').nth(4).click()
		await shot(page, 'scales-chord')
	})
	test('progressions', async ({ page, open }) => {
		await open('#scales')
		await page.locator('.harmony__tabs [data-pane="progressions"]').click()
		await expect(page.locator('section.harmony')).toHaveScreenshot('scales-progressions.png')
	})
	test('circle', async ({ page, open }) => {
		await open('#scales')
		await page.locator('.harmony__tabs [data-pane="circle"]').click()
		await expect(page.locator('section.harmony')).toHaveScreenshot('scales-circle.png')
	})
	test('vertical neck', async ({ page, open }) => {
		await open('#scales', { fretboardVertical: true })
		// A vertical neck fills the screen height measured at draw time, which
		// races font loading and the async mic hint on boot; the app redraws on
		// resize, so one resize pins the length to the settled layout.
		await page.evaluate(() => dispatchEvent(new Event('resize')))
		await shot(page, 'scales-vertical')
	})
	test('left-handed', async ({ page, open }) => {
		await open('#scales', { leftHanded: true })
		await shot(page, 'scales-left-handed')
	})
	test('identify marked', async ({ page, open }) => {
		await open('#scales')
		await page.locator('.scales-mode [data-scales-mode="identify"]').click()
		await tapCells(page, '#view-scales .neck', [
			[0, 3],
			[0, 5],
			[1, 2],
			[1, 3],
			[1, 5],
		])
		await shot(page, 'scales-identify-marked')
	})
})

test.describe('trainer', () => {
	for (const exercise of ['notes', 'intervals', 'chords', 'changes', 'tab']) {
		test(exercise, async ({ page, open }) => {
			await open('#trainer', { trainerExercise: exercise })
			await shot(page, `trainer-${exercise}`)
		})
	}
	test('changes in time', async ({ page, open }) => {
		await open('#trainer', { trainerExercise: 'changes', changesMode: 'time' })
		await shot(page, 'trainer-changes-in-time')
	})
})

test.describe('metronome', () => {
	test('default', async ({ page, open }) => {
		await open('#metronome')
		await shot(page, 'metronome')
	})
	test('speed trainer', async ({ page, open }) => {
		await open('#metronome', { metroTrainerOn: true })
		await shot(page, 'metronome-speed-trainer')
	})
})

test.describe('calibration', () => {
	test('page', async ({ page, open }) => {
		// The dates in the steps' status would change every day: one step done on a fixed day.
		await open('#calibration', { audioDelayMs: -135, audioCalibratedAt: Date.UTC(2026, 9, 21, 12) })
		await shot(page, 'calibration', { fullPage: true })
	})
})

test.describe('settings', () => {
	test('top', async ({ page, open }) => {
		await open('#settings')
		await shot(page, 'settings', { fullPage: true })
	})
	test('metronome group', async ({ page, open }) => {
		// Settings opens at the group of the tab the user came from.
		await open('#metronome')
		await page.locator('[data-tab="settings"]').click()
		await expect(page.locator('#view-settings')).toBeVisible()
		await shot(page, 'settings-metronome')
	})
})

// Behaviour: cheap, stable checks; one project is enough.
test.describe('behaviour', () => {
	test.skip(({ theme, viewport }) => theme !== 'light' || viewport?.width !== 1280, 'desktop-light only')

	test('tabs route through the hash', async ({ page, open }) => {
		await open('')
		await expect(page.locator('#view-tuner')).toBeVisible()
		await page.locator('[data-tab="chords"]').click()
		await expect(page).toHaveURL(/#chords$/)
		await expect(page.locator('#view-chords')).toBeVisible()
		await expect(page.locator('#view-tuner')).toBeHidden()
		await expect(page.locator('#tab-chords')).toHaveAttribute('aria-selected', 'true')
		await page.evaluate(() => (location.hash = '#metronome'))
		await expect(page.locator('#view-metronome')).toBeVisible()
		await expect(page.locator('#tab-metronome')).toHaveAttribute('aria-selected', 'true')
	})

	test('settings survive a reload', async ({ page, open }) => {
		await open('#chords')
		await page.locator('[data-chords-mode="library"]').click()
		await expect(page.locator('.chord-library')).toBeVisible()
		await page.reload()
		await expect(page.locator('.chord-library')).toBeVisible()
		await expect(page.locator('[data-chords-mode="library"]')).toHaveAttribute('aria-pressed', 'true')
	})

	test('help opens and closes with Escape', async ({ page, open }) => {
		await open('#metronome')
		await page.locator('[data-help="metronome"]').click()
		await expect(page.locator('#help')).toBeVisible()
		await expect(page.locator('#helpTitle')).toHaveText('Metronome')
		await page.keyboard.press('Escape')
		await expect(page.locator('#help')).toBeHidden()
	})

	test('metronome Start / Stop', async ({ page, open }) => {
		await open('#metronome')
		const start = page.locator('.metro-start')
		await expect(start).toHaveText('Start')
		await start.click()
		await expect(start).toHaveText('Stop')
		await start.click()
		await expect(start).toHaveText('Start')
	})

	test('the oldest theme key migrates; theme-color follows the theme', async ({ page, open }) => {
		await open('#settings')
		const stored = await page.evaluate(() => [localStorage.getItem('theme'), localStorage.getItem('pitch-recognizer:mode')])
		expect(stored).toEqual([null, 'light'])
		await expect(page.locator('html')).toHaveAttribute('data-mode', 'light')
		await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#e7e1d3')
		await page.getByRole('combobox', { name: 'Theme' }).click()
		await page.getByRole('option', { name: 'Night blue' }).click()
		await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#1c222c')
		await page.reload()
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'night')
		await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark')
	})

	// A theme is one CSS block of materials per mode (DESIGN.md): inject one at
	// runtime and check tokens, derived roles and components follow, including a
	// subtree that forces its own mode (the fretboard board).
	test('a new theme is one CSS block', async ({ page, open }) => {
		await open('#scales', { fretboardTheme: 'dark' })
		await page.addStyleTag({
			content: `[data-theme='test'][data-mode='light'], [data-theme='test'] [data-mode='light'] { --key-face: rgb(255, 0, 0); --panel: rgb(255, 0, 0); }
				[data-theme='test'][data-mode='dark'], [data-theme='test'] [data-mode='dark'] { --key-face: rgb(0, 0, 255); --panel: rgb(0, 0, 255); }`,
		})
		const read = () =>
			page.evaluate(() => {
				const board = document.querySelector('#view-scales .neck-board')!
				return {
					token: getComputedStyle(document.documentElement).getPropertyValue('--surface').trim(),
					// The keycap is the button's ::before (key.css).
					button: getComputedStyle(document.querySelector('.btn')!, '::before').backgroundColor,
					board: getComputedStyle(board).getPropertyValue('--surface').trim(),
					boardBg: getComputedStyle(board).getPropertyValue('--bg').trim(),
				}
			})
		const before = await read()
		expect(before.button).toBe('rgb(237, 231, 216)')
		await page.evaluate(() => (document.documentElement.dataset.theme = 'test'))
		expect(await read()).toEqual({ token: 'rgb(255, 0, 0)', button: 'rgb(255, 0, 0)', board: 'rgb(0, 0, 255)', boardBg: 'rgb(0, 0, 255)' })
	})

	// Each section's first row resets it: slide (or tap) the guard's shutter away, then Confirm.
	test('a section resets to its defaults', async ({ page, open }) => {
		await open('#settings', { leftHanded: true })
		const group = page.locator('[data-group="fretboard"]')
		await group.locator('.settings-group__toggle').click()
		await expect(group.locator('[data-setting="leftHanded"]')).toBeChecked()
		// Closed, the shutter covers Confirm: it is the shutter that takes the tap.
		const confirm = group.locator('.guard__confirm')
		await expect(confirm).toHaveAttribute('tabindex', '-1')
		await group.locator('.guard__shutter').click()
		await confirm.click()
		await expect(group.locator('[data-setting="leftHanded"]')).not.toBeChecked()
		expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pitch-recognizer:settings')!).leftHanded)).toBe(false)
	})

	// Sections fold; the search shows only the matching rows, open.
	test('settings fold and search', async ({ page, open }) => {
		await open('#settings')
		const settings = page.locator('#view-settings')
		await expect(settings.getByRole('button', { name: 'Fretboard', exact: true })).toHaveAttribute('aria-expanded', 'false')
		const search = page.getByRole('searchbox', { name: 'Search settings' })
		await search.fill('left-handed')
		await expect(settings.getByText('Left-handed', { exact: true })).toBeVisible()
		await expect(page.locator('[data-group="tuner"]')).toBeHidden()
		await search.fill('zzz')
		await expect(page.getByText('No setting matches.')).toBeVisible()
		await search.fill('')
		await expect(page.locator('[data-group="tuner"]')).toBeVisible()
	})

	// Coming back to Settings from another tab opens that tab's section only: one left open closes.
	test('settings open the section of the tab you came from, only', async ({ page, open }) => {
		await open('#scales')
		await page.evaluate(() => (location.hash = '#settings'))
		const band = (name: string) => page.locator('#view-settings').getByRole('button', { name, exact: true })
		await expect(band('Scales')).toHaveAttribute('aria-expanded', 'true')
		await page.evaluate(() => (location.hash = '#tuner'))
		await page.evaluate(() => (location.hash = '#settings'))
		await expect(band('Tuner')).toHaveAttribute('aria-expanded', 'true')
		await expect(band('Scales')).toHaveAttribute('aria-expanded', 'false')
	})

	// The display colour is its own axis: it recolours LCDs only, and sticks.
	test('the display colour is independent of the theme', async ({ page, open }) => {
		await open('#settings')
		const color = (selector: string) => page.evaluate((s) => getComputedStyle(document.querySelector(s)!).backgroundColor, selector)
		const keyBefore = await page.evaluate(() => getComputedStyle(document.querySelector('.btn')!, '::before').backgroundColor)
		// Through the dropdown itself: open it, pick Amber.
		await page.getByRole('combobox', { name: 'Display' }).click()
		await page.getByRole('option', { name: 'Amber', exact: true }).click()
		await expect(page.getByRole('combobox', { name: 'Display' })).toHaveText('Amber')
		expect(await color('.dropdown')).toBe('rgb(20, 16, 11)')
		expect(await page.evaluate(() => getComputedStyle(document.querySelector('.btn')!, '::before').backgroundColor)).toBe(keyBefore)
		await page.reload()
		await expect(page.locator('html')).toHaveAttribute('data-display', 'amber')
	})
})

// The extra themes and LCD colours (ts/ui/theme.ts): one phone screen each,
// so a missing token shows without multiplying every shot by every theme.
test.describe('themes', () => {
	test.skip(({ theme, viewport }) => theme !== 'light' || viewport?.width !== 375, 'phone-light only')
	const remember = (page: Page, key: string, value: string) =>
		page.evaluate(([k, v]) => localStorage.setItem(k, v), [key, value] as const).then(() => page.reload())

	for (const id of [
		'sand',
		'studio',
		'mint',
		'graphite',
		'petrol',
		'walnut',
		'olive',
		'stage',
		'brit',
		'copper',
		'citrus',
		'blackstar',
		'regia-light',
		'regia-dark',
	]) {
		test(id, async ({ page, open }) => {
			await open('#chords')
			await remember(page, 'pitch-recognizer:mode', id)
			await shot(page, `theme-${id}`)
		})
	}

	for (const id of ['casio', 'red', 'phosphor', 'vfd', 'oled', 'ice', 'violet', 'eink', 'backlit']) {
		test(`lcd ${id}`, async ({ page, open }) => {
			await open('#metronome')
			await remember(page, 'pitch-recognizer:display', id)
			await expect(page.locator('#view-metronome .plate')).toHaveScreenshot(`lcd-${id}.png`)
		})
	}
})
