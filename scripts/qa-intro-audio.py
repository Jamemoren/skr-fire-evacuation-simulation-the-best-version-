"""Browser QA for the intro sound (music + effects + controls).

  EVAC_API_URL=http://127.0.0.1:8799 npx vite --port 5199              (dev, StrictMode)
  QA_BASE=http://127.0.0.1:5199 python3 scripts/qa-intro-audio.py

Two Chromium instances: one that allows autoplay and one that requires a click first
(--autoplay-policy). The page exposes only what the sound engine did (status, cue list, context
state) under ?qa=1 — there is no way here to listen, so "heard" means "scheduled on the audio clock".
Headless software rendering is slow (~1 frame/s), so long waits jump the intro clock with the
existing ?introDebug seek/play hooks; skipped cues must then stay silent (no burst of late sounds).
"""
import asyncio, json, os, sys
from playwright.async_api import async_playwright

BASE = os.environ.get('QA_BASE', 'http://127.0.0.1:5199')
CHROME = os.environ.get('QA_CHROME')
SHOTS = os.environ.get('QA_SHOTS', 'qa-output/intro-audio')
# guide=0: the first-visit guide (opened after the intro on a fresh profile) would cover the buttons this
# audio test clicks; the guide has its own checks in scripts/qa-experience.py.
URL = BASE + '/?intro=1&qa=1&introDebug=1&guide=0'
results = []

def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('PASS' if ok else 'FAIL') + '  ' + name + (('  — ' + (detail if isinstance(detail, str) else json.dumps(detail, ensure_ascii=False))) if detail != '' else ''), flush=True)

A = 'window.__skrIntroAudio'
I = 'window.__skrIntro'

async def wait_for(page, expr, timeout=60000):
    try:
        await page.wait_for_function(expr, timeout=timeout)
        return True
    except Exception:
        return False

async def engine(page):
    return await page.evaluate(f'({{ status: {A}.status, ctx: {A}.contextState(), cues: [...{A}.stats.cues], starts: {A}.stats.musicStarts, offsets: {A}.stats.musicOffsets, resyncs: {A}.stats.resyncs, contexts: {A}.stats.contexts, closes: {A}.stats.closes, missing: [...{A}.missing] }})')

async def clock(page):
    return await page.evaluate(f'{I} ? {I}.state().elapsed : null')

async def seek_play(page, seconds):
    await page.evaluate(f'(() => {{ {I}.seek({seconds}); {I}.play(); }})()')

# Headless Chromium here ignores --autoplay-policy and lets audio start without a click, so the
# "blocked" browser is emulated the way Chrome behaves: an AudioContext starts suspended and resume()
# stays pending until the page has a real user activation (a click/tap/key from Playwright counts).
BLOCK_AUTOPLAY = """(() => {
  const Real = window.AudioContext;
  if (!Real) return;
  // Playwright navigation already sets navigator.userActivation here, so the gate tracks real input
  // events itself: a trusted pointer/touch/key event within the last 5 s allows resume().
  let gestureAt = -Infinity;
  for (const type of ["pointerdown", "touchstart", "keydown", "mousedown"]) {
    window.addEventListener(type, (event) => { if (event.isTrusted) gestureAt = performance.now(); }, true);
  }
  class GatedAudioContext extends Real {
    constructor(options) { super(options); Real.prototype.suspend.call(this); }
    resume() { return performance.now() - gestureAt < 5000 ? Real.prototype.resume.call(this) : new Promise(() => {}); }
  }
  window.AudioContext = GatedAudioContext;
})();"""

async def open_page(browser, errors, viewport=None, gate=False, **kw):
    context = await browser.new_context(viewport=viewport or {'width': 1440, 'height': 810}, **kw)
    if gate: await context.add_init_script(BLOCK_AUTOPLAY)
    page = await context.new_page()
    page.set_default_timeout(60000)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' and 'favicon' not in m.text and 'WebGL' not in m.text and 'GPU stall' not in m.text else None)
    await page.goto(URL, wait_until='domcontentloaded')
    await page.wait_for_selector('.cine-audio-toggle')
    return context, page

async def main():
    os.makedirs(SHOTS, exist_ok=True)
    async with async_playwright() as p:
        base_args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
        allowed = await p.chromium.launch(executable_path=CHROME, args=base_args + ['--autoplay-policy=no-user-gesture-required'])
        blocked = await p.chromium.launch(executable_path=CHROME, args=base_args + ['--autoplay-policy=user-gesture-required'])
        errors = []

        # ---------------------------------------------------------------- 1. autoplay allowed: the whole timeline
        ctx, page = await open_page(allowed, errors)
        ok = await wait_for(page, f'["playing","partial"].includes({A}.status)')
        e = await engine(page)
        check('A1 autoplay allowed: sound starts without a click', ok, e['status'])
        check('A2 one audio context only (StrictMode mounts the intro twice in development)', e['contexts'] == 1, e['contexts'])
        await wait_for(page, f'{I}.state().elapsed > 2.3', 180000)
        e = await engine(page)
        check('A3 music joins the picture (started once, at the clock position)', e['starts'] >= 1 and abs(e['offsets'][0]['offset'] - e['offsets'][0]['clock']) < 0.3, e['offsets'][:2])
        check('A4 opening cues in order: ignition → camera whoosh → scan', e['cues'][:3] == ['ignite@0.05', 'whoosh@1.4', 'scan@2.05'], e['cues'])
        await page.screenshot(path=f'{SHOTS}/01-desktop-playing.png')
        await seek_play(page, 4.95)
        await wait_for(page, f'{I}.state().elapsed > 7.2', 180000)
        e = await engine(page)
        check('A5 three statement pulses, one each, rising', [c for c in e['cues'] if c.startswith('pulse')] == ['pulse@5.2', 'pulse@6.05', 'pulse@6.95'], e['cues'])
        await seek_play(page, 8.7)
        await wait_for(page, f'{I}.state().elapsed > 9.05', 180000)
        e = await engine(page)
        check('A6 title sound with the hero flash', 'title@8.86' in e['cues'], e['cues'])
        last = e['offsets'][-1]
        check('A7 after a jump the music re-aligns to the picture', e['resyncs'] >= 1 and abs(last['offset'] - last['clock']) < 0.3, {'resyncs': e['resyncs'], 'last': last})
        await seek_play(page, 10.85)
        gone = await wait_for(page, '!document.querySelector(".cine")', 180000)
        e = await engine(page)
        check('A8 closing sound before the dashboard', 'outro@10.95' in e['cues'], e['cues'])
        check('A9 no cue played twice', len(e['cues']) == len(set(e['cues'])), e['cues'])
        await page.wait_for_timeout(3000)
        e = await engine(page)
        check('A10 intro finished: audio released (context closed, nothing left playing)', gone and e['ctx'] == 'none' and e['closes'] == 1, {'ctx': e['ctx'], 'closes': e['closes']})

        # Replay from the project info panel.
        await page.get_by_role('button', name='รายละเอียดโครงการ').click()
        await page.get_by_role('button', name='เล่นบทนำอีกครั้ง (มีเสียง)').click()
        back = await wait_for(page, '!!document.querySelector(".cine")', 20000)
        playing = await wait_for(page, f'["playing","partial"].includes({A}.status)', 30000)
        e = await engine(page)
        check('R1 "เล่นบทนำอีกครั้ง" replays the intro with sound (a fresh context)', back and playing and e['contexts'] == 2, {'contexts': e['contexts'], 'status': e['status']})
        await page.wait_for_timeout(1500)
        before = len((await engine(page))['cues'])
        await page.keyboard.press('Escape')
        await wait_for(page, '!document.querySelector(".cine")', 20000)
        await page.wait_for_timeout(1500)
        e = await engine(page)
        check('R2 skip (Esc) fades out and releases: no cue after the skip, context closed', len(e['cues']) <= before + 0 and e['ctx'] == 'none' and e['closes'] == 2, {'cues_after': len(e['cues']) - before, 'ctx': e['ctx']})
        await ctx.close()

        # ---------------------------------------------------------------- 2. autoplay blocked
        ctx, page = await open_page(blocked, errors, gate=True)
        is_blocked = await wait_for(page, f'{A}.status === "blocked"', 60000)
        label = await page.locator('.cine-audio-toggle').inner_text()
        status_text = await page.locator('.cine-audio-status').inner_text()
        check('B1 autoplay blocked: status says so and the button reads "เปิดเสียง"', is_blocked and 'เปิดเสียง' in label, {'label': label, 'status': status_text})
        t0 = await clock(page)
        await page.wait_for_timeout(4000)
        t1 = await clock(page)
        e = await engine(page)
        check('B2 the intro keeps playing while sound is blocked (and no cue sounds)', t1 > t0 and e['cues'] == [], {'clock': [t0, t1], 'cues': e['cues']})
        await page.screenshot(path=f'{SHOTS}/02-desktop-blocked.png')
        await page.locator('.cine-audio-toggle').click()
        started = await wait_for(page, f'["playing","partial"].includes({A}.status)', 20000)
        await wait_for(page, f'{A}.stats.musicStarts > 0', 60000)
        e = await engine(page)
        off = e['offsets'][0] if e['offsets'] else None
        check('B3 clicking "เปิดเสียง" starts the sound in sync with where the intro is', started and off and off['clock'] > 0.3 and abs(off['offset'] - off['clock']) < 0.3, off)
        await page.keyboard.press('Escape')
        await wait_for(page, '!document.querySelector(".cine")', 20000)
        await page.wait_for_timeout(1500)
        e = await engine(page)
        check('B4 skipping releases the audio', e['ctx'] == 'none' and e['closes'] == 1, e['ctx'])
        await ctx.close()

        # ---------------------------------------------------------------- 3. mute, levels, remembered, keyboard
        ctx, page = await open_page(allowed, errors)
        await wait_for(page, f'["playing","partial"].includes({A}.status)')
        await page.locator('.cine-audio-toggle').focus()
        await page.keyboard.press('Enter')
        muted = await wait_for(page, f'{A}.status === "off"', 5000)
        still = await page.locator('.cine').count()
        stored = await page.evaluate('JSON.parse(localStorage.getItem("skr-intro-audio:v1") || "{}")')
        pressed = await page.locator('.cine-audio-toggle').get_attribute('aria-pressed')
        check('K1 Enter on the sound button mutes (and does not skip the intro)', muted and still == 1 and pressed == 'false', {'stored': stored})
        await page.get_by_role('button', name='ปรับระดับเสียงเพลงและเสียงประกอบ').click()
        await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft')
        await page.keyboard.press('Tab'); await page.keyboard.press('ArrowRight')
        await page.screenshot(path=f'{SHOTS}/03-desktop-levels.png')
        stored = await page.evaluate('JSON.parse(localStorage.getItem("skr-intro-audio:v1") || "{}")')
        check('K2 music and effects levels move with the keyboard and are stored', abs(stored.get('music', 0) - 0.5) < 0.01 and abs(stored.get('sfx', 0) - 0.75) < 0.01 and stored.get('enabled') is False, stored)
        await page.keyboard.press('Escape')
        panel_closed = await page.locator('.cine-audio-panel').count() == 0
        intro_kept = await page.locator('.cine').count() == 1
        check('K3 Esc inside the levels panel closes the panel, not the intro', panel_closed and intro_kept)
        await page.get_by_role('button', name='ปรับระดับเสียงเพลงและเสียงประกอบ').click()
        names = await page.evaluate('[...document.querySelectorAll(".cine-audio button, .cine-audio input")].map((el) => el.getAttribute("aria-label") || el.closest("label")?.innerText.split("\\n")[0])')
        check('K4 every control has a name a screen reader can read', all(names) and len(names) == 4, names)
        await page.keyboard.press('Escape')
        await page.reload(wait_until='domcontentloaded')
        await page.wait_for_selector('.cine-audio-toggle')
        await page.wait_for_timeout(1500)
        e = await engine(page)
        label = await page.locator('.cine-audio-toggle').inner_text()
        check('P1 after reload the choice is remembered: still off, no audio context created', e['status'] == 'off' and e['contexts'] == 0 and 'เปิดเสียง' in label, {'status': e['status'], 'contexts': e['contexts']})
        await page.get_by_role('button', name='ปรับระดับเสียงเพลงและเสียงประกอบ').click()
        values = await page.evaluate('[...document.querySelectorAll(".cine-audio-panel input")].map((el) => el.value)')
        check('P2 levels remembered after reload', values == ['50', '75'], values)
        await page.keyboard.press('Escape')
        await page.locator('.cine-audio-toggle').click()
        on = await wait_for(page, f'["playing","partial"].includes({A}.status)', 20000)
        check('P3 switching sound back on works', on)
        # Tab switch: the page goes hidden → the audio pauses with the picture; back → resumes.
        await page.evaluate('(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); })()')
        suspended = await wait_for(page, f'{A}.contextState() === "suspended"', 5000)
        await page.evaluate('(() => { delete document.hidden; delete document.visibilityState; Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); document.dispatchEvent(new Event("visibilitychange")); })()')
        resumed = await wait_for(page, f'{A}.contextState() === "running"', 5000)
        check('V1 hidden tab suspends the sound, coming back resumes it', suspended and resumed)
        await ctx.close()

        # ---------------------------------------------------------------- 4. missing files
        ctx = await allowed.new_context(viewport={'width': 1280, 'height': 720})
        await ctx.route('**/audio/intro/intro-score.mp3', lambda route: route.fulfill(status=404, body='missing'))
        page = await ctx.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(URL, wait_until='domcontentloaded')
        partial = await wait_for(page, f'{A}.status === "partial"', 60000)
        text = await page.locator('.cine-audio-status').inner_text()
        check('F1 a missing music file: effects still play, the status names what is missing', partial and 'เพลงประกอบ' in text, text)
        await ctx.close()
        ctx = await allowed.new_context(viewport={'width': 1280, 'height': 720})
        await ctx.route('**/audio/intro/*', lambda route: route.fulfill(status=404, body='missing'))
        page = await ctx.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(URL, wait_until='domcontentloaded')
        failed = await wait_for(page, f'{A}.status === "error"', 60000)
        text = await page.locator('.cine-audio-status').inner_text()
        await page.wait_for_function(f'!!{I}')
        await seek_play(page, 11.6)
        finished = await wait_for(page, '!document.querySelector(".cine")', 180000)
        check('F2 all files missing: clear message, the intro still finishes and the site works', failed and finished, text)
        await ctx.close()

        # ---------------------------------------------------------------- 5. phone screen
        ctx, page = await open_page(blocked, errors, viewport={'width': 390, 'height': 844}, gate=True, has_touch=True, is_mobile=True, device_scale_factor=2)
        await wait_for(page, f'{A}.status === "blocked"', 60000)
        boxes = await page.evaluate('["cine-audio-toggle","cine-audio-levels","cine-skip"].map((c) => { const r = document.querySelector("." + c).getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })')
        inside = all(b[0] >= 0 and b[0] + b[2] <= 390 and b[1] + b[3] <= 844 for b in boxes)
        big = all(b[2] >= 44 and b[3] >= 44 for b in boxes)
        overlap = any(boxes[i][0] < boxes[j][0] + boxes[j][2] and boxes[j][0] < boxes[i][0] + boxes[i][2] and boxes[i][1] < boxes[j][1] + boxes[j][3] and boxes[j][1] < boxes[i][1] + boxes[i][3] for i in range(3) for j in range(i + 1, 3))
        label = await page.locator('.cine-audio-toggle').inner_text()
        check('M1 phone: sound buttons and Skip fit on screen, ≥ 44 px, not overlapping; "เปิดเสียง" is spelled out', inside and big and not overlap and 'เปิดเสียง' in label, boxes)
        await page.screenshot(path=f'{SHOTS}/04-phone-blocked.png')
        await page.locator('.cine-audio-toggle').tap()
        on = await wait_for(page, f'["playing","partial"].includes({A}.status)', 20000)
        check('M2 phone: a tap starts the sound', on)
        await page.screenshot(path=f'{SHOTS}/05-phone-playing.png')
        await ctx.close()

        # ---------------------------------------------------------------- 6. reduced motion
        ctx, page = await open_page(allowed, errors, reduced_motion='reduce')
        mode = await page.locator('.cine').get_attribute('data-mode')
        await wait_for(page, f'["playing","partial"].includes({A}.status)')
        done = await wait_for(page, '!document.querySelector(".cine")', 120000)
        await page.wait_for_timeout(2500)
        e = await engine(page)
        check('D1 reduced motion: quiet bed + one soft chime only (no score, no whooshes)', mode == 'reduced' and done and e['cues'] == ['title@0.3'] and e['starts'] == 0, {'mode': mode, 'cues': e['cues'], 'score': e['starts']})
        check('D2 reduced motion: audio released at the end', e['ctx'] == 'none')
        await ctx.close()

        check('E1 no page errors or console errors', not errors, errors[:5])
        await allowed.close(); await blocked.close()
    failed = [name for name, ok in results if not ok]
    print(f'\n{len(results) - len(failed)}/{len(results)} checks passed ({BASE})')
    if failed:
        print('Failed: ' + ' | '.join(failed)); sys.exit(1)

asyncio.run(main())
