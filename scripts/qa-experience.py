"""Browser QA for the guide, the automatic editor demo, the presentation and the shared sound.

  npx vite --host 127.0.0.1 --port 5199 --force                       (no API server needed)
  QA_CHROME=/path/to/chrome python3 scripts/qa-experience.py [sections…]

Sections (default: all): sound guide guide-mobile demo present present-mobile reduced story story-mobile story-reduced
No API server is started on purpose: every check here must also hold when the API is down
(the presentation must never create or start a drill on a server). Results are printed as
PASS/FAIL lines; screenshots go to qa-output/experience/.
"""
import asyncio, json, os, sys
from playwright.async_api import async_playwright

BASE = os.environ.get('QA_BASE', 'http://127.0.0.1:5199')
CHROME = os.environ.get('QA_CHROME')
SHOTS = os.environ.get('QA_SHOTS', 'qa-output/experience')
ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
SKIP_INTRO = "try{sessionStorage.setItem('skr-cinematic-intro','seen')}catch(e){}"
STATE_KEY = 'skr-building1-evacuation-state'
results = []

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

def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('PASS' if ok else 'FAIL') + '  ' + name + (('  — ' + (detail if isinstance(detail, str) else json.dumps(detail, ensure_ascii=False))) if detail != '' else ''), flush=True)

async def new_page(p, width=1440, height=900, extra_args=(), reduced=False, mobile=False, guide=False, gate=False):
    browser = await p.chromium.launch(executable_path=CHROME, args=ARGS + list(extra_args))
    ctx = await browser.new_context(viewport={'width': width, 'height': height}, is_mobile=mobile, has_touch=mobile,
                                    reduced_motion='reduce' if reduced else 'no-preference')
    await ctx.add_init_script(SKIP_INTRO)
    if gate: await ctx.add_init_script(BLOCK_AUTOPLAY)
    page = await ctx.new_page()
    page.set_default_timeout(90000)
    page.errors = []
    page.api = []
    page.on('pageerror', lambda e: page.errors.append(str(e)))
    page.on('request', lambda r: page.api.append(r.method + ' ' + r.url) if '/api/' in r.url else None)
    await page.goto(BASE + ('/?qa=1' if guide else '/?guide=0&qa=1'))
    if not guide:
        # 'attached', not 'visible': on phones the settings sheet (which holds this card) is closed and inert
        # until the user opens it, so the card exists but is hidden. This only waits for the app to load.
        await page.locator('#sw-readiness').wait_for(state='attached')
        await page.wait_for_timeout(1500)
    return browser, page

# ------------------------------------------------------------------ sound
async def section_sound(p):
    browser, page = await new_page(p, extra_args=['--autoplay-policy=user-gesture-required'], gate=True)
    await page.evaluate("()=>window.__skrSound.startBed('qa', .3)")
    await page.wait_for_timeout(800)
    before = await page.evaluate("()=>({ctx: window.__skrSound.contextState(), beds: window.__skrSound.stats.beds})")
    toggle = page.locator('.sound-toggle').first
    blocked_ui = await toggle.evaluate("e=>e.classList.contains('is-blocked')")
    check('sound: autoplay blocked → context waits, toggle shows “แตะเพื่อเปิดเสียง”', before['ctx'] != 'running' and blocked_ui, before)
    await page.mouse.click(700, 450)
    await page.wait_for_timeout(1200)
    after = await page.evaluate("()=>({ctx: window.__skrSound.contextState(), gestures: window.__skrSound.stats.resumesFromGesture})")
    check('sound: first click unlocks the shared context', after['ctx'] == 'running', after)
    await toggle.click()
    await page.wait_for_timeout(300)
    off = await page.evaluate("()=>JSON.parse(localStorage.getItem('skr-intro-audio:v1')||'{}').enabled")
    check('sound: mute is stored', off is False)
    await page.reload(); await page.locator('#sw-readiness').wait_for(); await page.wait_for_timeout(1000)
    stats0 = await page.evaluate("()=>window.__skrSound.stats.beds")
    await page.mouse.click(700, 450)
    await page.evaluate("()=>window.__skrSound.startBed('qa', .3)")
    await page.wait_for_timeout(1500)
    persisted = await page.evaluate("()=>({off: document.querySelector('.sound-toggle')?.classList.contains('is-off'), beds: window.__skrSound.stats.beds})")
    check('sound: mute survives reload and nothing plays', persisted['off'] and persisted['beds'] == stats0, persisted)
    await page.locator('.sound-toggle').first.click()  # leave sound on for the next sections
    check('sound: no page errors', not page.errors, page.errors[:2])
    await browser.close()

# ------------------------------------------------------------------ guide
async def section_guide(p, mobile=False):
    w, h = (390, 844) if mobile else (1440, 900)
    tag = 'guide-mobile' if mobile else 'guide'
    browser, page = await new_page(p, w, h, mobile=mobile, guide=True)
    dlg = page.locator('dialog.user-guide')
    await dlg.wait_for()
    check(f'{tag}: opens by itself on the first visit (welcome)', await dlg.evaluate("d=>d.classList.contains('is-welcome')"))
    choices = [await x.inner_text() for x in await dlg.locator('.user-guide-choice strong').all()]
    check(f'{tag}: offers “อ่านตามหัวข้อ” and “ลองทำบนหน้าจอจริง”', choices == ['อ่านตามหัวข้อ', 'ลองทำบนหน้าจอจริง'], choices)
    await page.screenshot(path=f'{SHOTS}/{tag}-choice.png')
    await dlg.get_by_role('button', name='อ่านตามหัวข้อ').click()
    if mobile:
        await dlg.locator('.user-guide-toc-toggle').click()
    labels = [await x.inner_text() for x in await dlg.locator('.user-guide-toc-label').all()]
    check(f'{tag}: contents list 14 lessons, basic → advanced', len(labels) == 14, labels)
    await dlg.locator('.user-guide-search input').fill('ส่งออก')
    found = [await x.inner_text() for x in await dlg.locator('.user-guide-toc-label').all()]
    check(f'{tag}: search finds the export lesson', 'ไฟล์และย้ายเครื่อง' in found, found)
    await dlg.locator('.user-guide-search input').fill('')  # (phones: the contents stay open until a lesson is picked)
    await dlg.locator('.user-guide-toc-label', has_text='หลักคณิตศาสตร์').click()
    parts = [await x.inner_text() for x in await dlg.locator('.user-guide-parts h4').all()]
    check(f'{tag}: lesson shows the four parts', len(parts) == 4, parts)
    verdict = await dlg.locator('.rx-verdict').inner_text()
    breakeven = await dlg.locator('.rx h5 + p').inner_text()
    check(f'{tag}: worked example — hand = program', verdict.startswith('✓') and '28 คน' in breakeven and 'ตรงกัน' in breakeven, verdict + ' | ' + breakeven[-60:])
    visible = await dlg.locator('.user-guide-parts').evaluate("e=>getComputedStyle(e).opacity")
    check(f'{tag}: lesson text visible even if animations stall', visible == '1', visible)
    await dlg.locator('.rx').screenshot(path=f'{SHOTS}/{tag}-math.png')
    if mobile:
        width = await page.evaluate("()=>document.querySelector('dialog.user-guide').scrollWidth <= innerWidth + 1")
        check(f'{tag}: nothing wider than the phone screen', width)
    # practise a lesson on the real screen
    if mobile:
        await dlg.locator('.user-guide-toc-toggle').click()
    await dlg.locator('.user-guide-toc-label', has_text='จำนวนคนและแนวทาง').click()
    await dlg.get_by_role('button', name='ลองทำบนหน้าจอจริง →').click()
    card = page.locator('.guided-tour-card')
    await card.wait_for(); await page.wait_for_timeout(1200)
    await page.screenshot(path=f'{SHOTS}/{tag}-practice.png')
    spot = await page.evaluate("()=>{const s=document.querySelector('.guided-tour-spot'),t=document.querySelector('[data-tour=\"population\"]');if(!s||!t)return null;const a=s.getBoundingClientRect(),b=t.getBoundingClientRect();const c=document.querySelector('.guided-tour-card').getBoundingClientRect();return {covers: a.left<=b.left+1&&a.top<=b.top+1&&a.right>=b.right-1&&a.bottom>=b.bottom-1, cardOverTarget: !(c.right<b.left||c.left>b.right||c.bottom<b.top||c.top>b.bottom)}}")
    check(f'{tag}: practice highlights the real button and the card does not cover it', spot and spot['covers'] and not spot['cardOverTarget'], spot)
    first = await card.locator('.guided-tour-primary').inner_text()
    await page.locator('[data-tour="population"]').click()
    await page.wait_for_timeout(800)
    task = await card.locator('.guided-tour-task').inner_text()
    check(f'{tag}: waits for the action, then confirms it', first.startswith('ข้าม') and task.startswith('✓'), [first, task])
    await card.locator('.guided-tour-primary').click(); await page.wait_for_timeout(800)
    await card.locator('.guided-tour-primary').click(); await page.wait_for_timeout(300)
    await card.locator('.guided-tour-primary').click(); await page.wait_for_timeout(1000)
    back = await dlg.count() and await dlg.evaluate('d=>d.open') and await dlg.locator('#user-guide-lesson-title').inner_text()
    check(f'{tag}: returns to the same lesson afterwards', back == 'ตั้งจำนวนนักเรียนและวิธีเลือกเส้นทาง', back)
    progress = await page.evaluate("()=>JSON.parse(localStorage.getItem('skr-guide-progress'))")
    await page.reload(); await page.wait_for_timeout(1500)
    again = await page.evaluate("()=>JSON.parse(localStorage.getItem('skr-guide-progress'))")
    check(f'{tag}: progress remembered across reload', progress == again and 'setup' in again['done'], again)
    if not mobile:
        # a missing target must not trap the user
        await page.goto(BASE + '/?guide=0&qa=1'); await page.locator('#sw-readiness').wait_for()
        await page.add_style_tag(content='[data-tour="walk"]{display:none!important}')
        await page.locator('.sw-guide-button').first.click()
        await dlg.get_by_role('button', name='อ่านตามหัวข้อ').click()
        await dlg.locator('.user-guide-toc-label', has_text='เดินสำรวจ').click()
        await dlg.get_by_role('button', name='ลองทำบนหน้าจอจริง →').click()
        await card.wait_for(); await page.wait_for_timeout(2500)
        text = await card.locator('.guided-tour-task').inner_text()
        check(f'{tag}: hidden target → explains and lets you skip', 'ไม่แสดง' in text and await card.locator('.guided-tour-primary').is_enabled(), text)
        await card.locator('.guided-tour-close').click()
    check(f'{tag}: no page errors', not page.errors, page.errors[:2])
    await browser.close()

# ------------------------------------------------------------------ automatic editor demo
async def section_demo(p):
    browser, page = await new_page(p)
    before = await page.evaluate(f"()=>localStorage.getItem('{STATE_KEY}')")
    await page.get_by_role('button', name='แก้ไขแบบจำลอง').first.click(); await page.wait_for_timeout(2500)
    await page.get_by_role('button', name='▶ ชมการสาธิตอัตโนมัติ').click()
    demo = page.locator('.auto-demo'); await demo.wait_for()
    await page.get_by_role('button', name='พัก').click()
    seen, framed = [], []
    for i in range(1, 10):
        await page.get_by_role('button', name='ข้ามไปขั้นถัดไป').click()
        for _ in range(90):
            st = await page.evaluate("()=>({s:document.querySelector('.auto-demo')?.dataset.step, r:document.querySelector('.auto-demo-result')?.textContent||''})")
            if st['s'] == str(i + 1) and 'กำลังจัดกล้อง' not in st['r']: break
            await page.wait_for_timeout(1000)
        seen.append(st['s'])
        await page.wait_for_timeout(600)
        view = await page.evaluate("()=>window.__skrAutoDemo?.inspect?.() ?? null")
        if view: framed.append(view)
    await page.screenshot(path=f'{SHOTS}/demo-last-step.png')
    check('demo: all 10 steps reachable with “ข้าม”', seen == [str(i) for i in range(2, 11)], seen)
    if framed:
        inside = [v for v in framed if v.get('allInside')]
        check('demo: highlighted points inside the visible area', len(inside) == len(framed), f'{len(inside)}/{len(framed)}')
    await page.get_by_role('button', name='ย้อน').click(); await page.wait_for_timeout(1500)
    check('demo: back works', await demo.get_attribute('data-step') == '9')
    mid = await page.evaluate(f"()=>localStorage.getItem('{STATE_KEY}')")
    await page.locator('.auto-demo-exit').click(); await page.wait_for_timeout(1500)
    after = await page.evaluate(f"()=>localStorage.getItem('{STATE_KEY}')")
    check('demo: user data untouched during and after', before == mid == after, len(before or ''))
    check('demo: exit closes the demo', await page.locator('.auto-demo').count() == 0)
    check('demo: no page errors', not page.errors, page.errors[:2])
    await browser.close()

# ------------------------------------------------------------------ presentation
async def section_present(p, mobile=False, reduced=False):
    w, h = (390, 844) if mobile else (1440, 900)
    tag = 'present-mobile' if mobile else 'present-reduced' if reduced else 'present'
    browser, page = await new_page(p, w, h, mobile=mobile, reduced=reduced)
    before = await page.evaluate(f"()=>localStorage.getItem('{STATE_KEY}')")
    view0 = await page.evaluate("()=>document.querySelector('.sw-dock-modes [aria-checked=\"true\"]')?.textContent")
    api0 = len(page.api)
    opener = page.locator('[data-guide-target="present"]')
    if mobile and not await opener.is_visible():
        await page.evaluate("()=>window.dispatchEvent(new Event('skr:open-presentation'))")
    else:
        await opener.click()
    await page.locator('.pz-start').wait_for()
    check(f'{tag}: opens on the start screen (เริ่มการสาธิต / ดูแบบสไลด์)', await page.get_by_role('button', name='▶ เริ่มการสาธิต').count() == 1)
    await page.get_by_role('button', name='ดูแบบสไลด์ (เลื่อนเอง)').click()
    root = page.locator('.pz-root'); await root.wait_for()
    check(f'{tag}: opens (fullscreen or full-window fallback)', await page.evaluate("()=>!!document.fullscreenElement || getComputedStyle(document.querySelector('.pz-root')).position==='fixed'"))
    if reduced:
        check(f'{tag}: reduced motion → still stage', await page.locator('.pz-stage.is-still').count() == 1)
    total = await page.locator('.pz-dots button').count()
    titles = []
    for i in range(total):
        await page.wait_for_timeout(2500 if not mobile else 1500)
        titles.append(await page.locator('#pz-title').inner_text())
        panel = await page.locator('.pz-panel').evaluate("e=>{const r=e.getBoundingClientRect();return {text:e.innerText.length, inside:r.left>=-8&&r.right<=innerWidth+8&&r.top>=-8&&r.bottom<=innerHeight+8}}")
        if not panel['inside'] or panel['text'] < 40:
            check(f'{tag}: slide {i + 1} panel fits and has content', False, panel)
        await page.screenshot(path=f'{SHOTS}/{tag}-{i + 1}.png')
        if i == 2:
            v = await page.locator('.pz-verdict').first.inner_text()
            check(f'{tag}: math slide — hand = program', v.startswith('✓'), v)
        if i == 6:
            phone = await page.evaluate("()=>({badge: document.querySelector('.pz-badge-demo')?.textContent||'', phones: document.querySelectorAll('.pz-phone .m-app').length, fallback: document.querySelectorAll('.pz-fallback').length})")
            check(f'{tag}: phone slide labelled as a demo, before/after shown', 'การสาธิต' in phone['badge'] and (phone['phones'] == 2 or phone['fallback'] == 2), phone)
        if i < total - 1:
            await page.keyboard.press('ArrowRight') if not mobile else await page.locator('.pz-nav.is-next').click()
    check(f'{tag}: {total} main slides in order', total == 9 and len(set(titles)) == total, titles)
    await page.keyboard.press('Home'); await page.wait_for_timeout(400)
    check(f'{tag}: Home → slide 1', (await page.locator('.pz-count').inner_text()).startswith('1/'))
    await page.keyboard.press('End'); await page.wait_for_timeout(400)
    check(f'{tag}: End → last main slide', (await page.locator('.pz-count').inner_text()) == f'{total}/{total}')
    await page.keyboard.press('ArrowLeft'); await page.wait_for_timeout(400)
    check(f'{tag}: ← goes back', (await page.locator('.pz-count').inner_text()) == f'{total - 1}/{total}')
    await page.locator('.pz-top button', has_text='สารบัญ').click()
    toc = await page.locator('.pz-toc button').count()
    check(f'{tag}: contents list main + extra scenes', toc >= total + 3, toc)
    await page.locator('.pz-toc button', has_text='ผลทุกสถานการณ์').click(); await page.wait_for_timeout(2500)
    count = await page.locator('.pz-count').inner_text()
    check(f'{tag}: extra scene reachable from contents', count.startswith('เสริม'), count)
    await page.screenshot(path=f'{SHOTS}/{tag}-matrix.png')
    if not mobile and not reduced:
        # slide 8 → editor demo → back to slide 8
        await page.keyboard.press('Home'); [await page.keyboard.press('ArrowRight') for _ in range(7)]
        await page.wait_for_timeout(1500)
        await page.locator('.pz-action', has_text='ชมการสาธิตอัตโนมัติ').click()
        await page.locator('.auto-demo').wait_for(); await page.wait_for_timeout(2000)
        check(f'{tag}: editor demo plays over a paused presentation', await root.count() == 0)
        await page.locator('.auto-demo-exit').click(); await page.wait_for_timeout(2500)
        back = await page.locator('.pz-count').inner_text() if await page.locator('.pz-count').count() else None
        check(f'{tag}: leaving the demo returns to slide 8', back == f'8/{total}', back)
    if mobile:
        small = await page.evaluate("()=>[...document.querySelectorAll('.pz-root button')].filter(b=>b.offsetParent&&b.getBoundingClientRect().height<36).map(b=>b.textContent.trim()).slice(0,5)")
        check(f'{tag}: buttons large enough to tap', not small, small)
        await page.locator('.pz-icon.is-exit').click()
    else:
        await page.keyboard.press('Escape')
    await page.wait_for_timeout(1500)
    check(f'{tag}: exit closes and restores the page', await root.count() == 0 and 'skr-presenting' not in await page.evaluate('()=>document.body.className'))
    view1 = await page.evaluate("()=>document.querySelector('.sw-dock-modes [aria-checked=\"true\"]')?.textContent")
    check(f'{tag}: building view restored', view0 == view1, [view0, view1])
    if not mobile:
        check(f'{tag}: focus back on the “นำเสนอ” button', await page.evaluate("()=>document.activeElement?.dataset?.guideTarget") == 'present')
    after = await page.evaluate(f"()=>localStorage.getItem('{STATE_KEY}')")
    check(f'{tag}: user data untouched', before == after)
    check(f'{tag}: no server calls (works with the API down)', len(page.api) == api0, page.api[api0:][:3])
    check(f'{tag}: no page errors', not page.errors, page.errors[:2])
    await browser.close()


# ------------------------------------------------------------------ narrated story (“เริ่มการสาธิต”)
async def section_story(p, mobile=False, reduced=False):
    w, h = (390, 844) if mobile else (1440, 900)
    tag = 'story-mobile' if mobile else 'story-reduced' if reduced else 'story'
    browser, page = await new_page(p, w, h, mobile=mobile, reduced=reduced)
    before = await page.evaluate(f"()=>localStorage.getItem('{STATE_KEY}')")
    api0 = len(page.api)
    await page.evaluate('()=>{window.__skrStoryLog = {seen: [], texts: {}}}')
    await page.evaluate("()=>window.dispatchEvent(new Event('skr:open-presentation'))")
    await page.locator('.pz-start').wait_for()
    await page.get_by_role('button', name='▶ เริ่มการสาธิต').click()
    await page.wait_for_function('!!window.__skrStory')
    S = '()=>window.__skrStory.state()'
    checks = await page.evaluate('()=>window.__skrStory.checks()')
    check(f'{tag}: the story\'s numbers pass their own checks (hand = program, 27→A, 28→B, fire)', all(checks.values()), checks)
    nums = await page.evaluate('()=>window.__skrStory.numbers()')
    beats = await page.evaluate('()=>window.__skrStory.beats()')
    panel = lambda: page.locator('.st-panel').inner_text()
    await page.evaluate('()=>window.__skrStory.setRate(3)')
    paused_checked = back_checked = False
    for _ in range(900):
        st = await page.evaluate(S)
        if not paused_checked and st['id'] == 'sumA' and st['elapsed'] > 200:
            await page.evaluate("()=>document.querySelector('.st-play').click()"); await page.wait_for_timeout(300)
            a = await page.evaluate(S)
            await page.wait_for_timeout(2500)
            b = await page.evaluate(S)
            check(f'{tag}: pause stops the clock and the camera together', not a['playing'] and abs(b['elapsed'] - a['elapsed']) < 1 and b['beat'] == a['beat'] and a['elapsed'] > 0 and a['camera'] == b['camera'], [a['id'], round(a['elapsed']), round(b['elapsed']), a['camera'], b['camera']])
            await page.evaluate("()=>document.querySelector('.st-play').click()"); await page.wait_for_timeout(1200)
            c = await page.evaluate(S)
            check(f'{tag}: resume continues from the same point', c['playing'] and (c['beat'] > b['beat'] or c['elapsed'] > b['elapsed']))
            paused_checked = True
        if not back_checked and st['id'] == 'ramp1':
            await page.evaluate("()=>document.querySelector('[aria-label=\"ย้อนช่วง\"]').click()"); await page.wait_for_timeout(300)
            d = await page.evaluate(S)
            kicker = await page.locator('.st-kicker').inner_text()
            check(f'{tag}: “ย้อนช่วง” replays the section from its start (panel, beat and clock together)', d['id'] == 'queueFormula' and 'ช่วงที่ 4' in kicker, [d['id'], round(d['elapsed']), kicker])
            back_checked = True
        if st['finished']:
            break
        await page.wait_for_timeout(250)
    rec = await page.evaluate('()=>window.__skrStoryLog')
    seen, texts = rec['seen'], rec['texts']
    order = [b['id'] for b in beats]
    check(f'{tag}: one press plays every section to the end without any other click', st['finished'] and [i for i in order if i in seen] == order, f'{len(set(seen))}/{len(order)}')
    await page.screenshot(path=f'{SHOTS}/{tag}-end.png')
    t = texts.get('substitute', '')
    check(f'{tag}: substitution on screen = program values', nums['subA']['expression'] in t and nums['subA']['result'] in t and 'ตรงกัน' in t, nums['subA'])
    t = texts.get('checkA', '')
    check(f'{tag}: route A total, hand vs program, with “ตรงกัน”', nums['totalA'] in t and nums['programA'] in t and 'ตรงกัน' in t, t[-160:].replace('\n', ' '))
    t = texts.get('sumB', '')
    check(f'{tag}: route B total and the choice without queue', nums['totalB'] in t and 'ตรงกัน' in t and 'ทาง A' in t)
    t27, t28 = texts.get('at27', ''), texts.get('at28', '')
    check(f'{tag}: at 27 people the panel shows the program choosing A, at 28 choosing B', nums['before']['costA'] in t27 and 'เลือก ทาง A' in t27 and nums['after']['costA'] in t28 and 'เลือก ทาง B' in t28, [nums['before'], nums['after']])
    check(f'{tag}: fire section names the closed steps and why', 'ตัดออก' in texts.get('blocked', '') and '∞' in texts.get('blocked', ''))
    # try it yourself
    await page.get_by_role('button', name='ลองปรับจำนวนคนรอเอง').click()
    slider = page.locator('.st-slider input')
    labels = "()=>[...document.querySelectorAll('.story-label')].map(e=>e.textContent).filter(t=>/^[AB] = /.test(t))"
    await slider.fill('27')
    await page.wait_for_function(labels + f".some(t=>t.startsWith('A = {nums['before']['costA']}') && t.includes('✓'))", timeout=30000)
    a27 = await panel(); l27 = await page.evaluate(labels)
    await slider.fill('28')
    await page.wait_for_function(labels + ".some(t=>t.startsWith('B =') && t.includes('✓'))", timeout=30000)
    l28a = await page.evaluate(labels)
    a28 = await panel(); l28 = await page.evaluate(labels)
    check(f'{tag}: “ลองปรับจำนวนคนรอเอง”: equation, chart and the route on the model follow the slider', 'เลือก ทาง A' in a27 and 'เลือก ทาง B' in a28 and any(x.startswith('A = ' + nums['before']['costA']) and '✓' in x for x in l27) and any(x.startswith('A = ' + nums['after']['costA']) for x in l28) and any(x.startswith('B =') and '✓' in x for x in l28), [l27, l28])
    if mobile:
        fit = await page.evaluate("()=>{const p=document.querySelector('.st-panel').getBoundingClientRect();return p.left>=0&&p.right<=innerWidth+1&&document.querySelector('.st-panel').scrollWidth<=document.querySelector('.st-panel').clientWidth+1}")
        check(f'{tag}: panel fits the phone (no sideways overflow)', fit)
    await page.screenshot(path=f'{SHOTS}/{tag}-try.png')
    await page.keyboard.press('Escape'); await page.wait_for_timeout(1200)
    check(f'{tag}: Esc leaves and restores the page', await page.locator('.st-root').count() == 0 and 'skr-presenting' not in await page.evaluate('()=>document.body.className'))
    after = await page.evaluate(f"()=>localStorage.getItem('{STATE_KEY}')")
    check(f'{tag}: user data untouched; no server calls', before == after and len(page.api) == api0, page.api[api0:][:3])
    check(f'{tag}: no page errors', not page.errors, page.errors[:2])
    await browser.close()

async def main():
    os.makedirs(SHOTS, exist_ok=True)
    wanted = sys.argv[1:] or ['sound', 'guide', 'guide-mobile', 'demo', 'present', 'present-mobile', 'reduced', 'story', 'story-mobile', 'story-reduced']
    async with async_playwright() as p:
        for name in wanted:
            print(f'--- {name}', flush=True)
            try:
                if name == 'sound': await section_sound(p)
                elif name == 'guide': await section_guide(p)
                elif name == 'guide-mobile': await section_guide(p, mobile=True)
                elif name == 'demo': await section_demo(p)
                elif name == 'present': await section_present(p)
                elif name == 'present-mobile': await section_present(p, mobile=True)
                elif name == 'reduced': await section_present(p, reduced=True)
                elif name == 'story': await section_story(p)
                elif name == 'story-mobile': await section_story(p, mobile=True)
                elif name == 'story-reduced': await section_story(p, reduced=True)
            except Exception as error:  # a crash is a failure, not a pass
                check(f'{name}: ran to the end', False, str(error).splitlines()[0][:200])
    failed = [name for name, ok in results if not ok]
    print(f'\n{len(results) - len(failed)}/{len(results)} passed' + (f' · FAILED: {failed}' if failed else ''))
    sys.exit(1 if failed else 0)

asyncio.run(main())
